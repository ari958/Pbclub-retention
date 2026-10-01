import { supabase } from "./supabaseClient";
import { getTextEligibilitySkipReason } from "./retentionPolicy";
import { buildRetentionContext, isLearnToPlayName, loadLiveClubCached, verifyRetentionTriggerEvent, type RetentionLiveClub, type VerifiedRetentionTrigger } from "./retentionContext";
import { writeRetentionText } from "./retentionText";
import { validateRetentionCoupon, type RetentionCouponValidation } from "./retentionCoupons";
import { sanitizeScheduledSendAt } from "./playerTiming";
import {
  DEFAULT_RETENTION_LOOKBACK_DAYS,
  isAttendanceDateNearRetentionWindow,
  isRetentionTriggerDate,
  normalizeRetentionLookbackDays,
  retentionDatePhrase,
  retentionWeekday,
  toEtDate,
  calendarDayDistance,
  hasNonLtpAttendanceAfterTrigger,
} from "./retentionDates";
import type { RetentionCandidate, RetentionContext, RetentionPlaybook } from "./retentionTypes";
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
      .select("id,status,context").eq("club_id", clubId).in("id", candidateIds);
    if (error) throw new Error(error.message);
    if (candidates?.length !== candidateIds.length || candidates.some((candidate: any) => !canRetryRetentionContext(candidate))) {
      throw Object.assign(new Error("Every requested candidate must still need context with reason context_lookup_failed or no_next_program"), { status: 409 });
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