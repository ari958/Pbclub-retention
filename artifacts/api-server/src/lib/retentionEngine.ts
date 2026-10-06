import { supabase } from "./supabaseClient";
import { randomUUID } from "node:crypto";
import { getTextEligibilitySkipReason } from "./retentionPolicy";
import { buildRetentionContext, isLearnToPlayName, loadLiveClubCached, verifyRetentionTriggerEvent, type RetentionLiveClub, type VerifiedRetentionTrigger } from "./retentionContext";
import { RetentionTextValidationError, validateRetentionTextBody, writeRetentionText } from "./retentionText";
import { buildLtpStepText, DEFAULT_LTP_SEQUENCE_CONFIG, formatLtpDate, validateLtpSequenceConfig } from "./ltpPhraseBuilder";
import { validateRetentionCoupon, type RetentionCouponValidation } from "./retentionCoupons";
import { sanitizeScheduledSendAt } from "./playerTiming";
import { checkLtpBookingSince, transitionLtpSequence, type LtpBookingBatchOptions } from "./ltpSequenceLifecycle";
import { ltpTestRpc, requireLtpTestOverride, readLtpTestControl } from "./ltpTestTools";
import {
  DEFAULT_RETENTION_LOOKBACK_DAYS,
  MAX_RETENTION_LOOKBACK_DAYS,
  isAttendanceDateNearRetentionWindow,
  isRetentionTriggerDate,
  normalizeRetentionLookbackDays,
  retentionDatePhrase,
  retentionWeekday,
  toEtDate,
  calendarDayDistance,
  hasNonLtpAttendanceAfterTrigger,
} from "./retentionDates";
import type { RetentionCandidate, RetentionContext, RetentionPlaybook, RetentionSequenceStep } from "./retentionTypes";
import { RetentionPodplayBatchClient, type RetentionPodplayTelemetry } from "./retentionPodplayBatch";

export type RetentionSkipReason =
  | "no_phone"
  | "opted_out"
  | "duplicate"
  | "holdout"
  | "marketing_consent"
  | "missing_player"
  | "invalid_trigger"
  | "out_of_window"
  | "already_returned";

const SKIP_REASONS: RetentionSkipReason[] = [
  "no_phone",
  "opted_out",
  "duplicate",
  "holdout",
  "marketing_consent",
  "missing_player",
  "invalid_trigger",
  "out_of_window",
  "already_returned",
];

export type RetentionResultStatus = "drafted" | "needs_context" | "manual_edit" | "skipped";

export interface RetentionCandidateResult {
  candidate_id: string;
  player_id: string;
  player_name: string | null;
  status: RetentionResultStatus;
  reason: string | null;
  body: string | null;
  context: RetentionContext;
  validation_errors?: string[];
}

export interface RetentionGenerationResult {
  lookback_days: number;
  stats: {
    found: number;
    verified: number;
    new_ltp_players: number;
    created: number;
    skipped: number;
    drafted: number;
    needs_context: number;
    manual_edit: number;
    skipped_candidates: number;
    error_count: number;
    skipped_by_reason: Record<RetentionSkipReason, number>;
  };
  errors: string[];
  coupon_check: { code: string | null; valid: boolean | null; warning: string | null };
  drafts: RetentionCandidateResult[];
}

export interface RetentionRegenerationResult {
  candidate_id: string;
  player_id?: string;
  status: RetentionResultStatus;
  reason: string | null;
  body: string | null;
  context: RetentionContext;
  validation_errors?: string[];
}

const PAGE_SIZE = 1000;
const CONCURRENCY = 3;

function intendedRetentionSendAt(): Date {
  return sanitizeScheduledSendAt(new Date(Date.now() + 60_000)) ?? new Date(Date.now() + 60_000);
}

function tableMissing(message: string) {
  return /retention_(playbooks|candidates|create_draft|create_candidate|update_candidate|regenerate_draft|retry_context|manual_edit_candidate|schema_ready)|does not exist|schema cache|could not find the table|could not find the function/i.test(message);
}

async function pageAll<T>(queryFactory: (from: number, to: number) => any): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await queryFactory(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []) as T[]);
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function stableBucket(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 10_000;
}

async function withConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asStringErrors(value: unknown, fallback: string): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [fallback];
}

function contextFailure(error: unknown): { reason: string; errors: string[]; diagnostics: Record<string, unknown> } {
  const candidate = error as { reason?: unknown; errors?: unknown; diagnostics?: unknown } | null;
  const message = errorMessage(error);
  const reason = candidate && (candidate.reason === "no_next_program" || candidate.reason === "context_lookup_failed")
    ? candidate.reason
    : "context_lookup_failed";
  return {
    reason,
    errors: asStringErrors(candidate?.errors, message),
    diagnostics: candidate?.diagnostics && typeof candidate.diagnostics === "object"
      ? candidate.diagnostics as Record<string, unknown>
      : { error: message },
  };
}

function withGenerationMetadata(
  context: RetentionContext,
  trigger: VerifiedRetentionTrigger,
  lookbackDays: number,
  intendedSendAt: Date,
): RetentionContext {
  return {
    ...context,
    trigger: { ...context.trigger, date: trigger.date, name: trigger.name },
    date_phrase: retentionDatePhrase(trigger.date, intendedSendAt),
    send_date_et: toEtDate(intendedSendAt),
    next_program_day: context.next_program ? retentionWeekday(context.next_program.date) : undefined,
    lookback_days: lookbackDays,
    stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
    diagnostics: context.diagnostics ?? {},
    errors: context.errors ?? [],
    reason: context.reason ?? null,
    validation_errors: context.validation_errors ?? [],
  };
}

function canGenerateRetentionText(context: RetentionContext): boolean {
  if (context.variant === "no_program") {
    return context.next_program === null
      && context.promo?.code === "LTPNEXT25"
      && !!context.promo.offer_text.trim();
  }
  if (context.variant === "with_program") return !!context.next_program;
  // Legacy contexts may be treated as with-program only when that program exists.
  return !!context.next_program;
}

function contextGenerationBlockReason(context: RetentionContext): string {
  if (context.variant === "no_program"
    && (context.promo?.code !== "LTPNEXT25" || !context.promo.offer_text.trim())) {
    return "coupon_not_verified";
  }
  return "context_incomplete";
}

function failureContext(
  player: { name?: string | null },
  trigger: VerifiedRetentionTrigger,
  failure: ReturnType<typeof contextFailure>,
  lookbackDays: number,
): RetentionContext {
  const intendedSendAt = intendedRetentionSendAt();
  return {
    trigger: { event_id: "", name: trigger.name, date: trigger.date },
    player_first_name: player.name?.trim().split(/\s+/)[0] ?? "",
    next_program: null,
    classmates_signed_up: 0,
    already_booked: false,
    booked_event: null,
    promo: null,
    coupon_warning: null,
    evaluated_at: new Date().toISOString(),
    date_phrase: retentionDatePhrase(trigger.date, intendedSendAt),
    send_date_et: toEtDate(intendedSendAt),
    lookback_days: lookbackDays,
    stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
    reason: failure.reason,
    errors: failure.errors,
    diagnostics: failure.diagnostics,
    validation_errors: [],
  };
}

async function createCandidate(args: {
  clubId: string;
  playerId: string;
  playbookKey: string;
  triggerEventId: string;
  context: RetentionContext;
  status: RetentionResultStatus;
  body: string | null;
}): Promise<string | null> {
  const { data, error } = await supabase.rpc("retention_create_candidate", {
    p_club_id: args.clubId,
    p_player_id: args.playerId,
    p_playbook_key: args.playbookKey,
    p_trigger_event_id: args.triggerEventId,
    p_context: args.context,
    p_status: args.status,
    p_body: args.body,
  });
  if (error) throw new Error(error.message);
  return data as string | null;
}

function makeTriggerContext(
  trigger: VerifiedRetentionTrigger,
  player: { name?: string | null },
  reason: string,
  errors: string[],
  diagnostics: Record<string, unknown>,
): RetentionContext {
  return {
    trigger: { event_id: "", name: trigger.name, date: trigger.date },
    player_first_name: player.name?.trim().split(/\s+/)[0] ?? "",
    next_program: null,
    classmates_signed_up: 0,
    already_booked: false,
    booked_event: null,
    promo: null,
    coupon_warning: null,
    evaluated_at: new Date().toISOString(),
    reason,
    errors,
    diagnostics,
    validation_errors: [],
  };
}

function hasLaterNonLtpAttendance(rows: any[], triggerDate: string): boolean {
  return hasNonLtpAttendanceAfterTrigger(rows.map((row) => ({
    attendance_date: toEtDate(String(row.attended_at)),
    is_ltp: isLearnToPlayName(String(row.program_name ?? "")),
  })), triggerDate);
}

function appendResult(
  result: RetentionGenerationResult,
  value: RetentionCandidateResult,
) {
  result.drafts.push(value);
  result.stats.created++;
  if (value.status === "drafted") result.stats.drafted++;
  else if (value.status === "needs_context") result.stats.needs_context++;
  else if (value.status === "manual_edit") result.stats.manual_edit++;
  else result.stats.skipped_candidates++;
}

/**
 * Creates safe retention candidates only. Blocked candidates have no pending
 * message; successfully generated texts are unscheduled and unapproved.
 */
export async function generateRetentionDrafts(
  clubId: string,
  requestedLookbackDays = DEFAULT_RETENTION_LOOKBACK_DAYS,
): Promise<RetentionGenerationResult> {
  const lookbackDays = normalizeRetentionLookbackDays(requestedLookbackDays);
  const result: RetentionGenerationResult = {
    lookback_days: lookbackDays,
    stats: {
      found: 0,
      verified: 0,
      new_ltp_players: 0,
      created: 0,
      skipped: 0,
      drafted: 0,
      needs_context: 0,
      manual_edit: 0,
      skipped_candidates: 0,
      error_count: 0,
      skipped_by_reason: Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<RetentionSkipReason, number>,
    },
    errors: [],
    coupon_check: { code: null, valid: null, warning: null },
    drafts: [],
  };
  const skip = (reason: RetentionSkipReason) => {
    result.stats.skipped++;
    result.stats.skipped_by_reason[reason]++;
  };
  const recordError = (message: string) => {
    result.errors.push(message);
    result.stats.error_count++;
  };
  const [playbookResult, attendance] = await Promise.all([
    supabase.from("retention_playbooks").select("*").eq("enabled", true),
    pageAll<any>((from, to) => supabase.from("attendances")
      .select("id,player_id,event_id,program_name,attended_at,players!inner(club_id)")
      .eq("players.club_id", clubId).order("attended_at", { ascending: true }).order("id", { ascending: true }).range(from, to)),
  ]);
  if (playbookResult.error) throw new Error(playbookResult.error.message);
  const playbooks = (playbookResult.data ?? []) as RetentionPlaybook[];
  const playbook = playbooks.find((item) => item.key === "ltp_followup");
  if (!playbook) return result;
  await requireRetentionSequenceReady();
  playbook.ltp_sequence_config = validateLtpSequenceConfig(
    playbook.ltp_sequence_config ?? DEFAULT_LTP_SEQUENCE_CONFIG,
  );
  const couponCache = new Map<string, Promise<RetentionCouponValidation>>();
  if (playbook.promo_code) {
    const couponKey = `${clubId}:${playbook.promo_code}`;
    const couponPromise = validateRetentionCoupon(clubId, playbook.promo_code);
    couponCache.set(couponKey, couponPromise);
    const coupon = await couponPromise;
    result.coupon_check = { code: playbook.promo_code, valid: coupon.valid, warning: coupon.warning };
  }

  const byPlayer = new Map<string, any[]>();
  for (const row of attendance) {
    if (!row.player_id) continue;
    const list = byPlayer.get(row.player_id) ?? [];
    list.push(row);
    byPlayer.set(row.player_id, list);
  }
  const today = toEtDate(new Date());
  const possibleCandidates: { playerId: string; trigger: any; attendanceDate: string }[] = [];
  for (const [playerId, rows] of byPlayer) {
    rows.sort((a, b) =>
      toEtDate(String(a.attended_at)).localeCompare(toEtDate(String(b.attended_at)))
      || String(a.id).localeCompare(String(b.id)));
    const earliestDate = toEtDate(String(rows[0].attended_at));
    if (!isAttendanceDateNearRetentionWindow(earliestDate, today, lookbackDays)) continue;
    const onEarliest = rows.filter((row) => toEtDate(String(row.attended_at)) === earliestDate);
    const ltp = onEarliest.filter((row) => isLearnToPlayName(row.program_name ?? ""));
    if (!ltp.length || onEarliest.some((row) => !isLearnToPlayName(row.program_name ?? ""))) continue;
    result.stats.found++;
    const trigger = [...ltp].sort((a, b) =>
      String(a.event_id).localeCompare(String(b.event_id)) || String(a.id).localeCompare(String(b.id)))[0];
    if (!trigger.event_id) { skip("invalid_trigger"); continue; }
    possibleCandidates.push({
      playerId,
      trigger,
      attendanceDate: earliestDate,
    });
  }
  if (!possibleCandidates.length) return result;

  const clubCache = new Map<string, Promise<RetentionLiveClub>>();
  const triggerCache = new Map<string, Promise<VerifiedRetentionTrigger>>();
  const candidates: { playerId: string; trigger: any; verifiedDate: string; verifiedName: string; alreadyReturned: boolean }[] = [];
  await withConcurrency(possibleCandidates, CONCURRENCY, async (candidate) => {
    try {
      const verified = await verifyRetentionTriggerEvent(clubId, candidate.trigger.event_id, clubCache, triggerCache);
      if (!isLearnToPlayName(verified.name)) { skip("invalid_trigger"); return; }
      if (calendarDayDistance(verified.date, candidate.attendanceDate) > 1) {
        skip("invalid_trigger");
        return;
      }
      result.stats.verified++;
      if (!isRetentionTriggerDate(verified.date, today, lookbackDays)) { skip("out_of_window"); return; }
      result.stats.new_ltp_players++;
      candidates.push({
        playerId: candidate.playerId,
        trigger: candidate.trigger,
        verifiedDate: verified.date,
        verifiedName: verified.name,
        alreadyReturned: hasLaterNonLtpAttendance(byPlayer.get(candidate.playerId) ?? [], verified.date),
      });
    } catch (error) {
      recordError(`${candidate.playerId}: could not verify Learn to Play trigger event ${candidate.trigger.event_id}: ${errorMessage(error)}`);
    }
  });
  if (!candidates.length) return result;

  const candidatePlayerIds = [...new Set(candidates.map((candidate) => candidate.playerId))];
  const { data: existingCandidates, error: duplicateQueryError } = await supabase.from("retention_candidates")
    .select("player_id").eq("playbook_key", playbook.key).in("player_id", candidatePlayerIds);
  if (duplicateQueryError) throw new Error(duplicateQueryError.message);
  const duplicatePlayerIds = new Set((existingCandidates ?? []).map((candidate: any) => candidate.player_id));
  const freshCandidates = candidates.filter((candidate) => {
    if (!duplicatePlayerIds.has(candidate.playerId)) return true;
    skip("duplicate");
    return false;
  });
  if (!freshCandidates.length) return result;

  const playerIds = [...new Set(freshCandidates.map((candidate) => candidate.playerId))];
  const players = await pageAll<any>((from, to) => supabase.from("players")
    .select("id,name,external_id,phone,opted_out,sms_opt_in,consent_source,sms_consented_at,club_id")
    .eq("club_id", clubId).in("id", playerIds).range(from, to));
  const playerMap = new Map(players.map((player) => [player.id, player]));

  const returned = freshCandidates.filter((candidate) => candidate.alreadyReturned);
  if (playbook.key === "ltp_followup") {
    const eligible: typeof freshCandidates = [];
    for (const candidate of freshCandidates.filter((item) => !item.alreadyReturned)) {
      const player = playerMap.get(candidate.playerId);
      if (!player) { skip("missing_player"); continue; }
      const eligibilityReason = getTextEligibilitySkipReason(player);
      if (eligibilityReason) { skip(eligibilityReason); continue; }
      if (stableBucket(`${candidate.playerId}:${playbook.key}`) < Number(playbook.holdout_pct ?? 0) * 100) {
        skip("holdout");
        continue;
      }
      eligible.push(candidate);
    }
    const safeReturned: typeof returned = [];
    for (const candidate of returned) {
      const player = playerMap.get(candidate.playerId);
      if (player?.opted_out === true) {
        skip("opted_out");
        continue;
      }
      skip("already_returned");
      safeReturned.push(candidate);
    }
    const ltpBatch = await createInitialLtpCandidateBatch(
      clubId,
      [...eligible, ...safeReturned],
      playerMap,
      lookbackDays,
    );
    if (ltpBatch.failures.length) {
      for (const failure of ltpBatch.failures) recordError(`${failure.candidate_id}: ${failure.error}`);
      return result;
    }
    for (const draft of ltpBatch.results) {
      const playerId = draft.player_id ?? "";
      const player = playerMap.get(playerId);
      appendResult(result, {
        candidate_id: draft.candidate_id,
        player_id: playerId,
        player_name: player?.name ?? null,
        status: draft.status,
        reason: draft.reason,
        body: draft.body,
        context: draft.context,
        ...(draft.validation_errors?.length ? { validation_errors: draft.validation_errors } : {}),
      });
    }
    return result;
  }

  for (const candidate of returned) {
    const player = playerMap.get(candidate.playerId);
    if (!player) { skip("missing_player"); continue; }
    const trigger = { date: candidate.verifiedDate, name: candidate.verifiedName, start_time: "" };
    const laterRows = (byPlayer.get(candidate.playerId) ?? [])
      .filter((row) => !isLearnToPlayName(String(row.program_name ?? "")) && toEtDate(String(row.attended_at)) > candidate.verifiedDate)
      .map((row) => ({ date: toEtDate(String(row.attended_at)), program_name: row.program_name ?? null }));
    const context = makeTriggerContext(trigger, player, "already_returned", [], { later_non_ltp_attendance: laterRows });
    context.trigger.event_id = String(candidate.trigger.event_id);
    context.lookback_days = lookbackDays;
    context.stale = lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS;
    const intendedSendAt = intendedRetentionSendAt();
    context.date_phrase = retentionDatePhrase(candidate.verifiedDate, intendedSendAt);
    context.send_date_et = toEtDate(intendedSendAt);
    try {
      const id = await createCandidate({
        clubId, playerId: candidate.playerId, playbookKey: playbook.key,
        triggerEventId: candidate.trigger.event_id, context, status: "skipped", body: null,
      });
      if (!id) { skip("duplicate"); continue; }
      skip("already_returned");
      appendResult(result, {
        candidate_id: id, player_id: candidate.playerId, player_name: player.name ?? null,
        status: "skipped", reason: "already_returned", body: null, context,
      });
    } catch (error) {
      recordError(`${player.name ?? candidate.playerId}: ${errorMessage(error)}`);
    }
  }

  const eligibleCandidates = freshCandidates.filter((candidate) => !candidate.alreadyReturned);
  const eligible: typeof eligibleCandidates = [];
  for (const candidate of eligibleCandidates) {
    const player = playerMap.get(candidate.playerId);
    if (!player) { skip("missing_player"); continue; }
    const eligibilityReason = getTextEligibilitySkipReason(player);
    if (eligibilityReason) { skip(eligibilityReason); continue; }
    if (stableBucket(`${candidate.playerId}:${playbook.key}`) < Number(playbook.holdout_pct ?? 0) * 100) {
      skip("holdout");
      continue;
    }
    eligible.push(candidate);
  }
  if (!eligible.length) return result;

  const socialEventsCache = new Map<string, Promise<any[]>>();
  const socialSignupsCache = new Map<string, Promise<string[]>>();
  await withConcurrency(eligible, CONCURRENCY, async ({ playerId, trigger, verifiedDate, verifiedName }) => {
    const player = playerMap.get(playerId)!;
    const verifiedTrigger = { date: verifiedDate, name: verifiedName, start_time: "" };
    const intendedSendAt = intendedRetentionSendAt();
    let candidateContext: RetentionContext | null = null;
    let status: RetentionResultStatus = "needs_context";
    let reason: string | null = null;
    let body: string | null = null;
    let generatedPreview: string | null = null;
    let validationErrors: string[] = [];
    try {
      const context = await buildRetentionContext({
        clubId, player, playbook,
        trigger: { event_id: trigger.event_id, name: verifiedName, date: verifiedDate },
        classmatesExternalIds: () => loadClassmatesExternalIds(clubId, trigger.event_id, playerId),
        socialEventsCache, socialSignupsCache, clubCache, couponCache,
      });
      candidateContext = withGenerationMetadata(context, verifiedTrigger, lookbackDays, intendedSendAt);
      if (!canGenerateRetentionText(candidateContext)) {
        reason = contextGenerationBlockReason(candidateContext);
        const errors = [candidateContext.coupon_warning ?? "A verified LTPNEXT25 offer is unavailable for this context"];
        candidateContext = { ...candidateContext, reason, errors };
      } else {
        const textResult = await writeRetentionText(candidateContext, playbook);
        validationErrors = textResult.validation_errors;
        generatedPreview = textResult.generated_preview;
        if (validationErrors.length) {
          status = "manual_edit";
          reason = "text_validation_failed";
          candidateContext = {
            ...candidateContext,
            reason,
            errors: validationErrors,
            validation_errors: validationErrors,
            generated_preview: generatedPreview,
            diagnostics: { ...(candidateContext.diagnostics ?? {}), text_generation_attempts: 3 },
          };
        } else {
          status = "drafted";
          body = textResult.body;
        }
      }
    } catch (error) {
      if (candidateContext) {
        reason = "text_generation_failed";
        status = "needs_context";
        candidateContext = {
          ...candidateContext,
          reason,
          errors: [errorMessage(error)],
          diagnostics: {
            ...(candidateContext.diagnostics ?? {}),
            text_generation: { status: "error", errors: [errorMessage(error)] },
          },
        };
      } else {
        const failure = contextFailure(error);
        reason = failure.reason;
        candidateContext = failureContext(player, verifiedTrigger, failure, lookbackDays);
        candidateContext.trigger.event_id = String(trigger.event_id);
      }
    }

    if (!candidateContext) {
      const failure = contextFailure(new Error("Context builder returned no context"));
      candidateContext = failureContext(player, verifiedTrigger, failure, lookbackDays);
      reason = failure.reason;
    }
    if (status === "needs_context" && reason) {
      candidateContext = {
        ...candidateContext,
        reason,
        errors: candidateContext.errors?.length ? candidateContext.errors : [reason === "no_next_program"
          ? "No matching next program with open spots was found"
          : reason === "coupon_not_verified"
            ? candidateContext.coupon_warning ?? "A verified LTPNEXT25 offer is unavailable for this context"
            : "Retention context could not be built"],
      };
    }
    candidateContext.trigger.event_id = String(trigger.event_id);
    try {
      const candidateId = await createCandidate({
        clubId, playerId, playbookKey: playbook.key, triggerEventId: trigger.event_id,
        context: candidateContext, status, body,
      });
      if (!candidateId) { skip("duplicate"); return; }
      appendResult(result, {
        candidate_id: candidateId,
        player_id: playerId,
        player_name: player.name ?? null,
        status,
        reason,
        body: status === "manual_edit" ? generatedPreview : body,
        context: candidateContext,
        ...(validationErrors.length ? { validation_errors: validationErrors } : {}),
      });
    } catch (error) {
      recordError(`${player.name ?? playerId}: ${errorMessage(error)}`);
    }
  });
  return result;
}

async function loadClassmatesExternalIds(clubId: string, eventId: string, playerId: string): Promise<string[]> {
  const { data, error } = await supabase.from("attendances")
    .select("player_id,players!inner(external_id,club_id)")
    .eq("event_id", eventId)
    .eq("players.club_id", clubId);
  if (error) throw new Error(error.message);
  return [...new Set((data ?? [])
    .filter((row: any) => row.player_id !== playerId && row.players?.external_id)
    .map((row: any) => row.players.external_id as string))];
}

export async function regenerateRetentionCandidate(
  clubId: string,
  candidateId: string,
): Promise<RetentionRegenerationResult> {
  const { data: row, error } = await supabase.from("retention_candidates")
    .select("playbook_key").eq("id", candidateId).eq("club_id", clubId).maybeSingle();
  if (error) throw new Error(error.message);
  if (row?.playbook_key === "ltp_followup") {
    const result = await regenerateLtpCandidateBatch(clubId, [candidateId]);
    if (result.failures.length) {
      throw Object.assign(new Error(result.failures[0].error), { status: result.failures[0].http_status });
    }
    return result.results[0];
  }
  return rebuildRetentionCandidate(clubId, candidateId, "regenerate");
}

interface RetentionRebuildBatch {
  client: RetentionPodplayBatchClient;
  clubCache: Map<string, Promise<RetentionLiveClub>>;
  couponCache: Map<string, Promise<RetentionCouponValidation>>;
  triggerCache: Map<string, Promise<VerifiedRetentionTrigger>>;
  eventsCache: Map<string, Promise<any[]>>;
  signupsCache: Map<string, Promise<string[]>>;
}

export function canRetryRetentionContext(candidate: Pick<RetentionCandidate, "status" | "context">): boolean {
  return candidate.status === "needs_context"
    && ["context_lookup_failed", "no_next_program"].includes(String(candidate.context?.reason ?? ""));
}

export interface RetentionContextRetryBatchResult {
  schema_ready: true;
  results: RetentionRegenerationResult[];
  failures: { candidate_id: string; error: string; http_status: number }[];
  podplay: RetentionPodplayTelemetry;
}

const activeContextRetries = new Set<string>();
const activeLtpCandidateBatches = new Set<string>();

async function requireRetentionSequenceReady(): Promise<void> {
  const { data, error } = await supabase.rpc("retention_sequence_ready");
  if (error || data !== true) {
    throw Object.assign(new Error("Apply migration 013_retention_ltp_sequence.sql in the existing Supabase SQL Editor before LTP sequence operations"), { status: 503 });
  }
}

interface LtpCandidateBatchInput {
  id: string;
  player_id: string;
  playbook_key: string;
  trigger_event_id: string;
  context: RetentionContext;
  status: RetentionCandidate["status"];
  message_id: string | null;
  updated_at: string;
  step?: RetentionSequenceStep;
  sequence_id?: string | null;
  attendance_cutoff?: string;
}

interface LtpBatchWriteItem {
  id: string;
  club_id: string;
  player_id: string;
  playbook_key: string;
  trigger_event_id: string;
  step: RetentionSequenceStep;
  operation: "create" | "regenerate" | "reshuffle" | "retry_context";
  expected_message_id: string | null;
  expected_body: string | null;
  expected_context: RetentionContext | null;
  expected_updated_at: string | null;
  context: RetentionContext;
  status: RetentionCandidate["status"];
  body: string | null;
  capacity_event_id: string | null;
  open_spots: number | null;
  event_start_time: string | null;
}

function ltpCandidateOrder(a: LtpCandidateBatchInput, b: LtpCandidateBatchInput): number {
  return String(a.context?.trigger?.date ?? "").localeCompare(String(b.context?.trigger?.date ?? ""))
    || String(a.id).localeCompare(String(b.id));
}

function ltpSendDate(): Date {
  return sanitizeScheduledSendAt(new Date(Date.now() + 60_000)) ?? new Date(Date.now() + 60_000);
}

async function readLtpPlaybook(): Promise<RetentionPlaybook> {
  const { data, error } = await supabase.from("retention_playbooks").select("*")
    .eq("key", "ltp_followup").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.enabled) throw Object.assign(new Error("LTP follow-up playbook is missing or disabled"), { status: 409 });
  const playbook = data as RetentionPlaybook;
  playbook.ltp_sequence_config = validateLtpSequenceConfig(
    playbook.ltp_sequence_config ?? DEFAULT_LTP_SEQUENCE_CONFIG,
  );
  return playbook;
}

function ltpFailedContext(
  prior: RetentionContext,
  trigger: { event_id: string; name: string; date: string },
  firstName: string,
  error: unknown,
  lookbackDays: number,
  step: RetentionSequenceStep,
  seedNonce: number,
): { context: RetentionContext; status: RetentionCandidate["status"] } {
  const failure = contextFailure(error);
  return {
    context: {
      ...prior,
      trigger,
      player_first_name: firstName,
      next_program: null,
      variant: "no_program",
      date_phrase: `on ${formatLtpDateSafe(trigger.date)}`,
      send_date_et: toEtDate(ltpSendDate()),
      lookback_days: lookbackDays,
      stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
      reason: failure.reason,
      errors: failure.errors,
      diagnostics: { ...(prior.diagnostics ?? {}), sequence_context_failure: failure.diagnostics },
      validation_errors: [],
      ltp_text: {
        step,
        seed_nonce: seedNonce,
        slot_indices: {},
        slot_templates: {},
        opener: `Hi ${firstName}, it's PB Club.`,
        ltp_date: formatLtpDateSafe(trigger.date),
        when: null,
      },
    },
    status: "needs_context",
  };
}

function formatLtpDateSafe(date: string): string {
  try {
    return formatLtpDate(date);
  } catch {
    return date;
  }
}

export interface LtpSequenceBatchResult {
  schema_ready: true;
  results: RetentionRegenerationResult[];
  failures: { candidate_id: string; error: string; http_status: number }[];
  podplay: RetentionPodplayTelemetry;
}

interface LtpBatchOptions {
  reshuffle?: boolean;
  retryContext?: boolean;
}

function ltpErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 500;
}

async function readLtpCandidatesForBatch(
  clubId: string,
  candidateIds: string[],
  options: LtpBatchOptions,
) {
  const { data, error } = await supabase.from("retention_candidates").select("*")
    .eq("club_id", clubId).eq("playbook_key", "ltp_followup").in("id", candidateIds);
  if (error) throw new Error(error.message);
  if ((data ?? []).length !== candidateIds.length) {
    throw Object.assign(new Error("One or more LTP sequence candidates were not found for this club"), { status: 404 });
  }
  const candidateMap = new Map((data ?? []).map((row: any) => [String(row.id), row as LtpCandidateBatchInput]));
  const candidates = candidateIds.map((id) => candidateMap.get(id)!);
  const playerRows = await Promise.all(candidates.map((candidate) => supabase.from("players")
    .select("id,opted_out").eq("id", candidate.player_id).eq("club_id", clubId).maybeSingle()));
  const optedOutCandidateIds: string[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const { data: player, error: playerError } = playerRows[index];
    if (playerError) throw new Error(playerError.message);
    if (!player) throw Object.assign(new Error(`Candidate ${candidates[index].id} player was not found`), { status: 409 });
    if (player.opted_out === true) {
      await transitionLtpSequence(
        clubId, candidates[index].player_id, "ltp_followup", "exited_opt_out", "player_opted_out",
      );
      optedOutCandidateIds.push(candidates[index].id);
    }
  }
  if (optedOutCandidateIds.length) {
    throw Object.assign(new Error(
      `LTP regeneration is blocked because the player opted out: ${optedOutCandidateIds.join(", ")}`,
    ), { status: 409 });
  }
  for (const candidate of candidates) {
    const step = candidate.step ?? candidate.context?.ltp_text?.step ?? 1;
    if (step !== 1 && step !== 2) throw Object.assign(new Error(`Candidate ${candidate.id} has an invalid LTP step`), { status: 409 });
    if (options.retryContext) {
      if (candidate.status !== "needs_context") throw Object.assign(new Error(`Candidate ${candidate.id} no longer needs context`), { status: 409 });
      continue;
    }
    if (candidate.status !== "drafted") throw Object.assign(new Error(`Candidate ${candidate.id} is not a drafted, editable LTP message`), { status: 409 });
    if (candidate.message_id == null) throw Object.assign(new Error(`Candidate ${candidate.id} has no pending draft message`), { status: 409 });
    const { data: message, error: messageError } = await supabase.from("messages")
      .select("id,body,status,approved_at,approved_by,approved_body,scheduled_send_at,dispatch_claimed_at,sent_at,simulated,retention_delivery_kind")
      .eq("id", candidate.message_id).maybeSingle();
    if (messageError) throw new Error(messageError.message);
    if (!message || message.status !== "pending" || message.approved_at != null
      || message.approved_by != null || message.approved_body != null || message.scheduled_send_at != null
      || message.dispatch_claimed_at != null || message.sent_at != null || message.simulated
      || message.retention_delivery_kind === "test") {
      throw Object.assign(new Error(`Candidate ${candidate.id} message is approved, scheduled, processed, or otherwise immutable`), { status: 409 });
    }
    (candidate as any).expected_message = message;
  }
  return candidates;
}

async function buildLtpBatchWriteItems(
  clubId: string,
  candidates: LtpCandidateBatchInput[],
  playbook: RetentionPlaybook,
  client: RetentionPodplayBatchClient,
  operation: "create" | "regenerate" | "reshuffle" | "retry_context",
): Promise<{
  items: LtpBatchWriteItem[];
  results: RetentionRegenerationResult[];
  transitions: { player_id: string; booked_event_id: string | null }[];
  failures: { candidate_id: string; error: string; http_status: number }[];
}> {
  const sorted = [...candidates].sort(ltpCandidateOrder);
  const socialEventsCache = new Map<string, Promise<any[]>>();
  const socialSignupsCache = new Map<string, Promise<string[]>>();
  const clubCache = new Map<string, Promise<RetentionLiveClub>>();
  const triggerCache = new Map<string, Promise<VerifiedRetentionTrigger>>();
  const couponCache = new Map<string, Promise<RetentionCouponValidation>>();
  const bookingOptions: LtpBookingBatchOptions = {
    client,
    clubCache,
    eventsCache: socialEventsCache,
    signupsCache: socialSignupsCache,
  };
  const allocatedCapacityByEvent = new Map<string, number>();
  const items: LtpBatchWriteItem[] = [];
  const results: RetentionRegenerationResult[] = [];
  const transitions: { player_id: string; booked_event_id: string | null }[] = [];
  const failures: { candidate_id: string; error: string; http_status: number }[] = [];
  for (const candidate of sorted) {
    const previousContext = candidate.context ?? {} as RetentionContext;
    const step = candidate.step ?? previousContext.ltp_text?.step ?? 1;
    const lookbackDays = normalizeRetentionLookbackDays(Number(
      previousContext.lookback_days ?? (previousContext.stale ? MAX_RETENTION_LOOKBACK_DAYS : DEFAULT_RETENTION_LOOKBACK_DAYS),
    ));
    const [{
      data: player,
      error: playerError,
    }, {
      data: message,
      error: messageError,
    }] = await Promise.all([
      supabase.from("players").select("id,name,external_id,phone,opted_out,sms_opt_in,consent_source,sms_consented_at,club_id")
        .eq("id", candidate.player_id).eq("club_id", clubId).maybeSingle(),
      candidate.message_id
        ? supabase.from("messages").select("id,body,status,approved_at,approved_by,approved_body,scheduled_send_at,dispatch_claimed_at,sent_at").eq("id", candidate.message_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (playerError) throw new Error(playerError.message);
    if (messageError) throw new Error(messageError.message);
    if (!player) throw Object.assign(new Error(`Candidate ${candidate.id} player was not found`), { status: 409 });
    if (player.opted_out === true) {
      if (candidate.sequence_id) {
        await transitionLtpSequence(
          clubId, candidate.player_id, "ltp_followup", "exited_opt_out", "player_opted_out",
        );
      }
      const reason = "opted_out";
      results.push({
        candidate_id: candidate.id,
        player_id: candidate.player_id,
        status: "skipped",
        reason,
        body: null,
        context: { ...previousContext, reason, errors: ["Player opted out of SMS"] },
      });
      if (operation !== "create") {
        failures.push({
          candidate_id: candidate.id,
          error: "LTP regeneration is blocked because the player opted out",
          http_status: 409,
        });
      }
      continue;
    }

    let trigger: VerifiedRetentionTrigger = {
      name: previousContext.trigger?.name ?? "Learn to Play",
      date: previousContext.trigger?.date ?? "",
      start_time: "",
    };
    let nextContext: RetentionContext = previousContext;
    let status: RetentionCandidate["status"] = "needs_context";
    let body: string | null = null;
    let reason: string | null = null;
    const sendAt = ltpSendDate();
    const selectedOperation = operation;
    try {
      trigger = await verifyRetentionTriggerEvent(
        clubId, candidate.trigger_event_id, clubCache, triggerCache, client,
      );
      if (!isLearnToPlayName(trigger.name)
        || (previousContext.trigger?.date && trigger.date !== previousContext.trigger.date)) {
        throw Object.assign(new Error("The live trigger no longer matches the saved Learn to Play event date"), { status: 409 });
      }
      const attendanceCutoff = candidate.attendance_cutoff ?? trigger.start_time;
      const { data: attendance, error: attendanceError } = await supabase.from("attendances")
      .select("event_id,program_name,attended_at,players!inner(club_id)").eq("player_id", candidate.player_id)
        .eq("players.club_id", clubId);
      if (attendanceError) throw new Error(attendanceError.message);
      const subsequentAttendance = (attendance ?? []).filter((row: any) =>
        Number.isFinite(Date.parse(attendanceCutoff))
        && Number.isFinite(Date.parse(String(row.attended_at)))
        && Date.parse(String(row.attended_at)) > Date.parse(attendanceCutoff),
      );
      const laterRows = subsequentAttendance.map((row: any) => ({
        date: toEtDate(String(row.attended_at)),
        program_name: row.program_name ?? null,
        event_id: row.event_id ?? null,
      }));
      if (laterRows.length) {
        const booking = laterRows[0];
        nextContext = {
          ...previousContext,
          trigger: { event_id: candidate.trigger_event_id, name: trigger.name, date: trigger.date },
          player_first_name: player.name?.trim().split(/\s+/)[0] ?? "",
          variant: "no_program",
          next_program: null,
          promo: null,
          booked_event: null,
          reason: "already_returned",
          errors: [],
          diagnostics: { ...(previousContext.diagnostics ?? {}), attendance_since_trigger: laterRows },
          validation_errors: [],
          send_date_et: toEtDate(sendAt),
          lookback_days: lookbackDays,
          stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
          ltp_text: {
            step,
            seed_nonce: optionsNonce(previousContext.ltp_text?.seed_nonce, selectedOperation),
            slot_indices: {},
            slot_templates: {},
            opener: `Hi ${player.name?.trim().split(/\s+/)[0] ?? ""}, it's PB Club.`,
            ltp_date: formatLtpDateSafe(trigger.date),
            when: null,
          },
        };
        status = "needs_context";
        reason = "already_returned";
        transitions.push({ player_id: candidate.player_id, booked_event_id: booking.event_id });
      } else {
        if (candidate.attendance_cutoff) {
          const testControl = candidate.sequence_id ? await readLtpTestControl(clubId, candidate.sequence_id) : null;
          const recentBooking = testControl?.simulated_booking
            ? { booked_event_id: "test-simulated-booking", source: "test_simulated_booking" }
            : await checkLtpBookingSince(
            clubId, candidate.player_id, candidate.attendance_cutoff, bookingOptions,
          );
          if (recentBooking) {
            nextContext = {
              ...previousContext,
              trigger: { event_id: candidate.trigger_event_id, name: trigger.name, date: trigger.date },
              player_first_name: player.name?.trim().split(/\s+/)[0] ?? "",
              next_program: null,
              variant: "no_program",
              promo: null,
              booking_url: "https://pbclub.podplay.app",
              reason: "already_booked",
              errors: [],
              diagnostics: { ...(previousContext.diagnostics ?? {}), exited_on_booking_since_step1: recentBooking },
              validation_errors: [],
              send_date_et: toEtDate(sendAt),
              lookback_days: lookbackDays,
              stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
              ltp_text: {
                step,
                seed_nonce: optionsNonce(previousContext.ltp_text?.seed_nonce, selectedOperation),
                slot_indices: {},
                slot_templates: {},
                opener: `Hi ${player.name?.trim().split(/\s+/)[0] ?? ""}, it's PB Club.`,
                ltp_date: formatLtpDateSafe(trigger.date),
                when: null,
              },
            };
            status = "needs_context";
            reason = "already_booked";
            transitions.push({ player_id: candidate.player_id, booked_event_id: recentBooking.booked_event_id });
          }
        }
        if (reason !== "already_booked") {
        const couponKey = `${clubId}:${playbook.promo_code ?? "LTPNEXT25"}`;
        if (step === 1 && !couponCache.has(couponKey)) {
          couponCache.set(couponKey, validateRetentionCoupon(
            clubId, playbook.promo_code ?? "LTPNEXT25", client.fetch,
          ));
        }
        const sequencePlaybook: RetentionPlaybook = step === 2
          ? { ...playbook, promo_code: null, offer_text: null }
          : playbook;
        const context = await buildRetentionContext({
          clubId,
          player,
          playbook: sequencePlaybook,
          trigger: { event_id: candidate.trigger_event_id, name: trigger.name, date: trigger.date },
          classmatesExternalIds: () => loadClassmatesExternalIds(clubId, candidate.trigger_event_id, candidate.player_id),
          socialEventsCache,
          socialSignupsCache,
          clubCache,
          couponCache,
          batchClient: client,
          allocatedCapacityByEvent,
          sequenceStep: step,
        });
        nextContext = withGenerationMetadata(context, trigger, lookbackDays, sendAt);
        nextContext.trigger.event_id = candidate.trigger_event_id;
        if (nextContext.already_booked && nextContext.booked_event) {
          const bookedEvent = nextContext.booked_event;
          status = "needs_context";
          reason = "already_booked";
          nextContext = {
            ...nextContext,
            reason,
            errors: [],
            diagnostics: { ...(nextContext.diagnostics ?? {}), exited_on_booking: nextContext.booked_event },
            validation_errors: [],
            ltp_text: {
              step,
              seed_nonce: optionsNonce(previousContext.ltp_text?.seed_nonce, selectedOperation),
              slot_indices: {},
              slot_templates: {},
              opener: `Hi ${player.name?.trim().split(/\s+/)[0] ?? ""}, it's PB Club.`,
              ltp_date: formatLtpDateSafe(trigger.date),
              when: null,
            },
          };
          transitions.push({ player_id: candidate.player_id, booked_event_id: bookedEvent.event_id });
        } else {
          const promo = step === 1 ? (playbook.promo_code ?? "LTPNEXT25") : null;
          const built = buildLtpStepText({
            candidateId: candidate.id,
            seedNonce: optionsNonce(previousContext.ltp_text?.seed_nonce, selectedOperation),
            step,
            context: nextContext,
            promoCode: promo,
            config: playbook.ltp_sequence_config,
            preferredSlotIndices: selectedOperation !== "reshuffle"
              && previousContext.ltp_text?.step === step
              ? previousContext.ltp_text.slot_indices
              : undefined,
          });
          nextContext = built.context;
          if (previousContext.ltp_test_mode === true) nextContext.ltp_test_mode = true;
          const validationErrors = validateRetentionTextBody(built.body, nextContext, playbook);
          if (validationErrors !== built.body) throw new Error("LTP sequence text validator returned an unexpected body");
          const validation = validateLtpBodyForErrors(built.body, nextContext, playbook);
          if (validation.length) {
            status = "manual_edit";
            reason = "text_validation_failed";
            nextContext = {
              ...nextContext,
              reason,
              errors: validation,
              validation_errors: validation,
              generated_preview: built.body,
            };
          } else {
            status = "drafted";
            body = built.body;
          }
          if (nextContext.next_program) {
            allocatedCapacityByEvent.set(
              nextContext.next_program.event_id,
              (allocatedCapacityByEvent.get(nextContext.next_program.event_id) ?? 0) + 1,
            );
          }
        }
        }
      }
    } catch (error) {
      const failure = contextFailure(error);
      const failed = ltpFailedContext(previousContext, {
        event_id: candidate.trigger_event_id, name: trigger.name, date: trigger.date || previousContext.trigger?.date || "",
      }, player.name?.trim().split(/\s+/)[0] ?? "", error, lookbackDays, step,
      optionsNonce(previousContext.ltp_text?.seed_nonce, selectedOperation));
      nextContext = {
        ...failed.context,
        reason: failure.reason,
        errors: failure.errors,
        diagnostics: {
          ...(failed.context.diagnostics ?? {}),
          sequence_context_failure: failure.diagnostics,
        },
      };
      status = "needs_context";
      reason = failure.reason;
      body = null;
    }
    const slot = nextContext.next_program;
    const item: LtpBatchWriteItem = {
      id: candidate.id,
      club_id: clubId,
      player_id: candidate.player_id,
      playbook_key: "ltp_followup",
      trigger_event_id: candidate.trigger_event_id,
      step,
      operation: selectedOperation,
      expected_message_id: selectedOperation === "create" ? null : candidate.message_id,
      expected_body: selectedOperation === "create" ? null : message?.body ?? null,
      expected_context: selectedOperation === "create" ? null : previousContext,
      expected_updated_at: selectedOperation === "create" ? null : candidate.updated_at,
      context: nextContext,
      status,
      body,
      capacity_event_id: slot?.event_id ?? null,
      open_spots: slot?.spots_remaining ?? null,
      event_start_time: slot?.start_time ?? null,
    };
    items.push(item);
    results.push({
      candidate_id: candidate.id,
      player_id: candidate.player_id,
      status: reason === "already_booked" || reason === "already_returned"
        ? "skipped"
        : status as RetentionResultStatus,
      reason,
      body,
      context: nextContext,
      ...(status === "manual_edit" ? { validation_errors: nextContext.validation_errors } : {}),
    });
  }
  return { items, results, transitions, failures };
}

function optionsNonce(previousNonce: number | undefined, operation: "create" | "regenerate" | "reshuffle" | "retry_context"): number {
  const nonce = Number.isSafeInteger(previousNonce) && Number(previousNonce) >= 0 ? Number(previousNonce) : 0;
  return operation === "reshuffle" ? nonce + 1 : operation === "create" ? 0 : nonce;
}

function validateLtpBodyForErrors(body: string, context: RetentionContext, playbook: RetentionPlaybook): string[] {
  try {
    validateRetentionTextBody(body, context, playbook);
    return [];
  } catch (error) {
    return error instanceof RetentionTextValidationError ? error.validation_errors : [errorMessage(error)];
  }
}

async function transitionLtpSequenceBooked(clubId: string, playerId: string, eventId: string | null): Promise<void> {
  await transitionLtpSequence(clubId, playerId, "ltp_followup", "exited_booked", "booked_after_ltp", eventId);
}

async function saveLtpSequenceBatch(clubId: string, items: LtpBatchWriteItem[], testMode = false): Promise<void> {
  if (testMode) {
    await ltpTestRpc("save", clubId, { items });
    return;
  }
  const { error } = await supabase.rpc("retention_sequence_save_batch", {
    p_club_id: clubId,
    p_items: items,
  });
  if (error) {
    const status = /capacity_exhausted|insufficient_capacity/i.test(error.message) ? 409 : 500;
    throw Object.assign(new Error(error.message), { status });
  }
}

async function runLtpCandidateBatch(
  clubId: string,
  candidateIds: string[],
  options: LtpBatchOptions = {},
): Promise<LtpSequenceBatchResult> {
  if (!candidateIds.length || candidateIds.length > 50 || new Set(candidateIds).size !== candidateIds.length) {
    throw Object.assign(new Error("Provide 1–50 distinct candidate IDs"), { status: 400 });
  }
  if (activeLtpCandidateBatches.has(clubId)) {
    throw Object.assign(new Error("An LTP candidate batch is already running for this club"), { status: 409 });
  }
  activeLtpCandidateBatches.add(clubId);
  try {
    await requireRetentionSequenceReady();
    const [candidates, playbook] = await Promise.all([
      readLtpCandidatesForBatch(clubId, candidateIds, options),
      readLtpPlaybook(),
    ]);
    const client = new RetentionPodplayBatchClient();
    let items: LtpBatchWriteItem[];
    let results: RetentionRegenerationResult[];
    let transitions: { player_id: string; booked_event_id: string | null }[];
    let failures: { candidate_id: string; error: string; http_status: number }[];
    try {
      ({ items, results, transitions, failures } = await buildLtpBatchWriteItems(
        clubId, candidates, playbook, client,
        options.retryContext ? "retry_context" : options.reshuffle ? "reshuffle" : "regenerate",
      ));
    } catch (error) {
      const message = errorMessage(error);
      return {
        schema_ready: true,
        results: [],
        failures: candidateIds.map((candidate_id) => ({
          candidate_id, error: message, http_status: ltpErrorStatus(error),
        })),
        podplay: client.telemetry,
      };
    }
    try {
      if (items.length) await saveLtpSequenceBatch(clubId, items);
      for (const transition of transitions) {
        await transitionLtpSequenceBooked(clubId, transition.player_id, transition.booked_event_id);
      }
      return { schema_ready: true, results, failures, podplay: client.telemetry };
    } catch (error) {
      const message = errorMessage(error);
      return {
        schema_ready: true,
        results: [],
        failures: candidateIds.map((candidate_id) => ({
          candidate_id, error: message, http_status: ltpErrorStatus(error),
        })),
        podplay: client.telemetry,
      };
    }
  } finally {
    activeLtpCandidateBatches.delete(clubId);
  }
}

async function createInitialLtpCandidateBatch(
  clubId: string,
  sourceCandidates: Array<{
    playerId: string;
    trigger: any;
    verifiedDate: string;
    verifiedName: string;
    alreadyReturned: boolean;
  }>,
  players: Map<string, any>,
  lookbackDays: number,
): Promise<LtpSequenceBatchResult> {
  if (!sourceCandidates.length) {
    return { schema_ready: true, results: [], failures: [], podplay: new RetentionPodplayBatchClient().telemetry };
  }
  const candidates: LtpCandidateBatchInput[] = sourceCandidates.map((source) => ({
    id: randomUUID(),
    player_id: source.playerId,
    playbook_key: "ltp_followup",
    trigger_event_id: String(source.trigger.event_id),
    context: {
      trigger: { event_id: String(source.trigger.event_id), name: source.verifiedName, date: source.verifiedDate },
      player_first_name: players.get(source.playerId)?.name?.trim().split(/\s+/)[0] ?? "",
      next_program: null,
      classmates_signed_up: 0,
      already_booked: false,
      booked_event: null,
      promo: null,
      coupon_warning: null,
      evaluated_at: new Date().toISOString(),
      lookback_days: lookbackDays,
      stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
    },
    status: "drafted",
    message_id: null,
    updated_at: "",
    step: 1,
  }));
  const playbook = await readLtpPlaybook();
  const client = new RetentionPodplayBatchClient();
  let items: LtpBatchWriteItem[];
  let results: RetentionRegenerationResult[];
  let transitions: { player_id: string; booked_event_id: string | null }[];
  let failures: { candidate_id: string; error: string; http_status: number }[];
  try {
    ({ items, results, transitions, failures } = await buildLtpBatchWriteItems(clubId, candidates, playbook, client, "create"));
    if (items.length) await saveLtpSequenceBatch(clubId, items);
    for (const transition of transitions) {
      await transitionLtpSequenceBooked(clubId, transition.player_id, transition.booked_event_id);
    }
    return { schema_ready: true, results, failures, podplay: client.telemetry };
  } catch (error) {
    return {
      schema_ready: true,
      results: [],
      failures: candidates.map((candidate) => ({
        candidate_id: candidate.id, error: errorMessage(error), http_status: ltpErrorStatus(error),
      })),
      podplay: client.telemetry,
    };
  }
}

/** Rebuilds a whole sequence batch atomically; it never approves, schedules, or sends. */
export async function regenerateLtpCandidateBatch(
  clubId: string,
  candidateIds: string[],
): Promise<LtpSequenceBatchResult> {
  return runLtpCandidateBatch(clubId, candidateIds);
}

/** Drafted-only deterministic phrase reshuffle, protected by the migration CAS write. */
export async function reshuffleLtpCandidate(
  clubId: string,
  candidateId: string,
): Promise<RetentionRegenerationResult> {
  const result = await runLtpCandidateBatch(clubId, [candidateId], { reshuffle: true });
  if (result.failures.length) {
    throw Object.assign(new Error(result.failures[0].error), { status: result.failures[0].http_status });
  }
  return result.results[0];
}

/** Creates unscheduled step-2 drafts only from migration-gated real step-1 delivery cohorts. */
export async function generateDueLtpStep2Drafts(clubId: string, testCandidateIds?: string[]): Promise<LtpSequenceBatchResult> {
  const testMode = testCandidateIds !== undefined;
  if (testMode) {
    requireLtpTestOverride();
    if (!testCandidateIds.length || testCandidateIds.length > 50 || new Set(testCandidateIds).size !== testCandidateIds.length) {
      throw Object.assign(new Error("Select 1–50 distinct test step-1 candidates"), { status: 400 });
    }
  }
  await requireRetentionSequenceReady();
  if (activeLtpCandidateBatches.has(clubId)) {
    throw Object.assign(new Error("An LTP candidate batch is already running for this club"), { status: 409 });
  }
  activeLtpCandidateBatches.add(clubId);
  try {
    const { data, error } = testMode
      ? { data: await ltpTestRpc("due", clubId, { candidate_ids: testCandidateIds }), error: null }
      : await supabase.rpc("retention_sequence_due_step2", { p_club_id: clubId });
    if (error) throw new Error(error.message);
    if (data != null && !Array.isArray(data)) throw new Error("Step-2 due-candidate RPC returned an invalid payload");
    const dueRows = (data ?? []) as any[];
    if (!dueRows.length) {
      return { schema_ready: true, results: [], failures: [], podplay: new RetentionPodplayBatchClient().telemetry };
    }
    if (dueRows.length > 50) throw Object.assign(new Error("The step-2 due cohort exceeds the atomic batch limit"), { status: 409 });
    const candidates: LtpCandidateBatchInput[] = dueRows.map((row) => ({
      id: randomUUID(),
      player_id: String(row.player_id),
      playbook_key: "ltp_followup",
      trigger_event_id: String(row.trigger_event_id),
      context: { ...row.context, ...(testMode ? { ltp_test_mode: true } : {}) } as RetentionContext,
      status: "sent",
      message_id: null,
      updated_at: "",
      step: 2,
      sequence_id: row.sequence_id ?? null,
      attendance_cutoff: String(row.step1_sent_at),
    }));
    for (let index = 0; index < dueRows.length; index++) {
      const row = dueRows[index];
      if (row.step1_delivery_kind !== (testMode ? "test" : "real")
        || (testMode && (row.test_mode !== true || !testCandidateIds!.includes(row.id)))
        || !row.step1_sent_at || !Number.isFinite(Date.parse(String(row.step1_sent_at)))
        || String(row.step) !== "1" || !row.context?.trigger?.date) {
        throw Object.assign(new Error(`Due step-2 cohort row ${row.id ?? index} lacks verified real step-1 facts`), { status: 409 });
      }
    }
    const playbook = await readLtpPlaybook();
    const client = new RetentionPodplayBatchClient();
    let items: LtpBatchWriteItem[];
    let results: RetentionRegenerationResult[];
    let transitions: { player_id: string; booked_event_id: string | null }[];
    let failures: { candidate_id: string; error: string; http_status: number }[];
    try {
      ({ items, results, transitions, failures } = await buildLtpBatchWriteItems(
        clubId, candidates, playbook, client, "create",
      ));
      if (testMode) {
        // Exits do not create an empty step-2 candidate. The shared transition
        // atomically withdraws existing drafts, just as at real dispatch.
        items = items.filter((item) => !["already_returned", "already_booked"].includes(item.context.reason ?? ""));
      }
      if (items.length) await saveLtpSequenceBatch(clubId, items, testMode);
      for (const transition of transitions) {
        await transitionLtpSequenceBooked(clubId, transition.player_id, transition.booked_event_id);
      }
      return { schema_ready: true, results, failures, podplay: client.telemetry };
    } catch (failure) {
      const message = errorMessage(failure);
      return {
        schema_ready: true,
        results: [],
        failures: candidates.map((candidate) => ({
          candidate_id: candidate.id, error: message, http_status: ltpErrorStatus(failure),
        })),
        podplay: client.telemetry,
      };
    }
  } finally {
    activeLtpCandidateBatches.delete(clubId);
  }
}

/** Eligibility and schema are checked before any PodPlay or model request. */
export async function retryRetentionContextBatch(
  clubId: string,
  candidateIds: string[],
): Promise<RetentionContextRetryBatchResult> {
  if (!candidateIds.length || candidateIds.length > 50 || new Set(candidateIds).size !== candidateIds.length) {
    throw Object.assign(new Error("Provide 1–50 distinct candidate IDs"), { status: 400 });
  }
  if (activeContextRetries.has(clubId)) {
    throw Object.assign(new Error("A context retry batch is already running for this club"), { status: 409 });
  }
  activeContextRetries.add(clubId);
  try {
    const { data: ready, error: readinessError } = await supabase.rpc("retention_context_retry_ready");
    if (readinessError || ready !== true) {
      throw Object.assign(new Error("Apply retention migration 012 in the existing Supabase SQL Editor before retrying context"), { status: 503 });
    }
    const { data: candidates, error } = await supabase.from("retention_candidates")
      .select("id,status,context,playbook_key").eq("club_id", clubId).in("id", candidateIds);
    if (error) throw new Error(error.message);
    if (candidates?.length !== candidateIds.length || candidates.some((candidate: any) => !canRetryRetentionContext(candidate))) {
      throw Object.assign(new Error("Every requested candidate must still need context with reason context_lookup_failed or no_next_program"), { status: 409 });
    }
    if (candidates.every((candidate: any) => candidate.playbook_key === "ltp_followup")) {
      return runLtpCandidateBatch(clubId, candidateIds, { retryContext: true });
    }
    const batch: RetentionRebuildBatch = {
      client: new RetentionPodplayBatchClient(),
      clubCache: new Map(),
      couponCache: new Map(),
      triggerCache: new Map(),
      eventsCache: new Map(),
      signupsCache: new Map(),
    };
    const result: RetentionContextRetryBatchResult = {
      schema_ready: true, results: [], failures: [], podplay: batch.client.telemetry,
    };
    for (const id of candidateIds) {
      try {
        result.results.push(await rebuildRetentionCandidate(clubId, id, "retry_context", batch));
      } catch (error: any) {
        result.failures.push({ candidate_id: id, error: errorMessage(error), http_status: error.status ?? 500 });
      }
    }
    return result;
  } finally {
    activeContextRetries.delete(clubId);
  }
}

async function rebuildRetentionCandidate(
  clubId: string,
  candidateId: string,
  operation: "regenerate" | "retry_context",
  batch?: RetentionRebuildBatch,
): Promise<RetentionRegenerationResult> {
  const { data: candidateRow, error: candidateError } = await supabase.from("retention_candidates")
    .select("*").eq("id", candidateId).eq("club_id", clubId).maybeSingle();
  if (candidateError) throw new Error(candidateError.message);
  if (!candidateRow) throw Object.assign(new Error("Retention candidate not found"), { status: 404 });
  const candidate = candidateRow as RetentionCandidate;
  if (operation === "retry_context" && !canRetryRetentionContext(candidate)) {
    throw Object.assign(new Error("Only eligible needs_context candidates can retry context"), { status: 409 });
  }
  if (operation === "regenerate" && candidate.status !== "drafted") {
    throw Object.assign(new Error("Only candidates that are still drafted can be regenerated"), { status: 409 });
  }
  const [{ data: player, error: playerError }, { data: playbook, error: playbookError }, { data: message, error: messageError }] = await Promise.all([
    supabase.from("players").select("id,name,external_id,club_id").eq("id", candidate.player_id).eq("club_id", clubId).maybeSingle(),
    supabase.from("retention_playbooks").select("*").eq("key", candidate.playbook_key).maybeSingle(),
    candidate.message_id
      ? supabase.from("messages").select("id,body,status,approved_at,approved_by,approved_body,scheduled_send_at,dispatch_claimed_at,sent_at").eq("id", candidate.message_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (playerError) throw new Error(playerError.message);
  if (playbookError) throw new Error(playbookError.message);
  if (messageError) throw new Error(messageError.message);
  if (!player || !playbook) throw Object.assign(new Error("Candidate player or playbook was not found"), { status: 409 });
  if (playbook.enabled !== true) throw Object.assign(new Error("Candidate playbook is not enabled"), { status: 409 });
  if ((operation === "regenerate" && !candidate.message_id) || (candidate.message_id && !message)) {
    throw Object.assign(new Error("Draft message is missing and cannot be regenerated safely"), { status: 409 });
  }
  if (message && (message.status !== "pending" || message.approved_at != null || message.approved_by != null
    || message.approved_body != null || message.scheduled_send_at != null || message.dispatch_claimed_at != null
    || message.sent_at != null)) {
    throw Object.assign(new Error("Draft is approved, scheduled, processed, or claimed and cannot be regenerated"), { status: 409 });
  }

  const previousContext = candidate.context as RetentionContext;
  const triggerDate = previousContext?.trigger?.date;
  if (!triggerDate) throw Object.assign(new Error("Candidate context is missing the Learn to Play trigger date"), { status: 409 });
  let trigger = { event_id: candidate.trigger_event_id, name: previousContext.trigger.name, date: triggerDate };
  const lookbackDays = normalizeRetentionLookbackDays(Number(previousContext.lookback_days ?? DEFAULT_RETENTION_LOOKBACK_DAYS));
  let laterNonLtpAttendance: { date: string; program_name: string | null }[] = [];
  let attendanceFailure: ReturnType<typeof contextFailure> | null = null;
  try {
    if (batch) {
      const verified = await verifyRetentionTriggerEvent(
        clubId, candidate.trigger_event_id, batch.clubCache, batch.triggerCache, batch.client,
      );
      if (!isLearnToPlayName(verified.name) || !isRetentionTriggerDate(verified.date, toEtDate(new Date()), lookbackDays)) {
        throw new Error("The live trigger is not Learn to Play within the candidate's original lookback window");
      }
      trigger = { event_id: candidate.trigger_event_id, name: verified.name, date: verified.date };
    }
    const { data: attendance, error: attendanceError } = await supabase.from("attendances")
      .select("program_name,attended_at").eq("player_id", candidate.player_id);
    if (attendanceError) throw new Error(attendanceError.message);
    laterNonLtpAttendance = (attendance ?? []).filter((row: any) =>
      !isLearnToPlayName(String(row.program_name ?? "")) && toEtDate(String(row.attended_at)) > trigger.date,
    ).map((row: any) => ({ date: toEtDate(String(row.attended_at)), program_name: row.program_name ?? null }));
  } catch (error) {
    attendanceFailure = contextFailure(error);
  }

  let newContext: RetentionContext;
  let newStatus: RetentionResultStatus;
  let reason: string | null = null;
  let body: string | null = null;
  let generatedPreview: string | null = null;
  let validationErrors: string[] = [];
  const intendedSendAt = intendedRetentionSendAt();
  if (attendanceFailure) {
    newStatus = "needs_context";
    reason = "context_lookup_failed";
    newContext = {
      ...previousContext,
      date_phrase: retentionDatePhrase(trigger.date, intendedSendAt),
      send_date_et: toEtDate(intendedSendAt),
      lookback_days: lookbackDays,
      stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
      reason,
      errors: attendanceFailure.errors,
      diagnostics: {
        ...(previousContext.diagnostics ?? {}),
        already_returned_lookup: { status: "error", errors: attendanceFailure.errors },
        failure: attendanceFailure.diagnostics,
      },
      validation_errors: [],
    };
  } else if (laterNonLtpAttendance.length) {
    newStatus = "skipped";
    reason = "already_returned";
    newContext = {
      ...previousContext,
      date_phrase: retentionDatePhrase(trigger.date, intendedSendAt),
      send_date_et: toEtDate(intendedSendAt),
      lookback_days: lookbackDays,
      stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
      reason,
      errors: [],
      diagnostics: { ...(previousContext.diagnostics ?? {}), later_non_ltp_attendance: laterNonLtpAttendance },
      validation_errors: [],
    };
  } else {
    const clubCache = batch?.clubCache ?? new Map<string, Promise<RetentionLiveClub>>();
    const couponCache = batch?.couponCache ?? new Map<string, Promise<RetentionCouponValidation>>();
    let generatedContext: RetentionContext | null = null;
    try {
      if (playbook.promo_code) {
        const key = `${clubId}:${playbook.promo_code}`;
        if (!couponCache.has(key)) {
          couponCache.set(key, validateRetentionCoupon(clubId, playbook.promo_code, batch?.client.fetch));
        }
        const coupon = await couponCache.get(key);
        if (batch && coupon?.lookup_failed) throw new Error(coupon.warning ?? "Live coupon lookup failed");
      }
      const context = await buildRetentionContext({
        clubId,
        player,
        playbook,
        trigger,
        classmatesExternalIds: () => loadClassmatesExternalIds(clubId, candidate.trigger_event_id, candidate.player_id),
        socialEventsCache: batch?.eventsCache ?? new Map<string, Promise<any[]>>(),
        socialSignupsCache: batch?.signupsCache ?? new Map<string, Promise<string[]>>(),
        clubCache,
        couponCache,
        batchClient: batch?.client,
      });
      newContext = withGenerationMetadata(
        context,
        { date: trigger.date, name: trigger.name, start_time: "" },
        lookbackDays,
        intendedSendAt,
      );
      generatedContext = newContext;
      if (!canGenerateRetentionText(newContext)) {
        newStatus = "needs_context";
        reason = contextGenerationBlockReason(newContext);
        newContext = {
          ...newContext,
          reason,
          errors: [newContext.coupon_warning ?? "A verified LTPNEXT25 offer is unavailable for this context"],
        };
      } else {
        const textResult = await writeRetentionText(newContext, playbook);
        validationErrors = textResult.validation_errors;
        generatedPreview = textResult.generated_preview;
        if (validationErrors.length) {
          newStatus = "manual_edit";
          reason = "text_validation_failed";
          newContext = {
            ...newContext,
            reason,
            errors: validationErrors,
            validation_errors: validationErrors,
            generated_preview: generatedPreview,
          };
        } else {
          newStatus = "drafted";
          body = textResult.body;
          newContext = { ...newContext, reason: null, errors: [], validation_errors: [] };
        }
      }
    } catch (error) {
      const failure = contextFailure(error);
      newStatus = "needs_context";
      if (generatedContext) {
        reason = "text_generation_failed";
        newContext = {
          ...generatedContext,
          reason,
          errors: [errorMessage(error)],
          diagnostics: {
            ...(generatedContext.diagnostics ?? {}),
            text_generation: { status: "error", errors: [errorMessage(error)] },
          },
          validation_errors: [],
        };
      } else {
        reason = failure.reason;
        newContext = {
          ...previousContext,
          date_phrase: retentionDatePhrase(trigger.date, intendedSendAt),
          send_date_et: toEtDate(intendedSendAt),
          lookback_days: lookbackDays,
          stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS,
          reason,
          errors: failure.errors,
          diagnostics: failure.diagnostics,
          validation_errors: [],
        };
      }
    }
  }

  const { data: updated, error: updateError } = await supabase.rpc(
    operation === "retry_context" ? "retention_retry_context" : "retention_regenerate_draft", {
    p_id: candidate.id,
    p_club_id: clubId,
    p_expected_body: message?.body ?? null,
    p_expected_context: candidate.context,
    p_expected_updated_at: candidate.updated_at,
    p_new_body: body,
    p_new_context: newContext,
    p_new_status: newStatus,
    p_error: reason ? `${reason}: ${(newContext.errors ?? []).join("; ")}` : null,
    ...(operation === "retry_context" ? { p_expected_message_id: candidate.message_id } : {}),
  });
  if (updateError) throw Object.assign(new Error(updateError.message), {
    status: /changed since|only drafted|processed|claimed|approved|scheduled/i.test(updateError.message) ? 409 : undefined,
  });
  const updatedContext = (updated?.context ?? newContext) as RetentionContext;
  return {
    candidate_id: candidate.id,
    status: newStatus,
    reason,
    body: newStatus === "manual_edit" ? generatedPreview : body,
    context: updatedContext,
    ...(validationErrors.length ? { validation_errors: validationErrors } : {}),
  };
}

export function isRetentionSchemaMissing(error: unknown): boolean {
  return tableMissing(error instanceof Error ? error.message : String(error));
}