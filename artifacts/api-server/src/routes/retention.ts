import { Router, type IRouter } from "express";
import { z } from "zod";
import { GenerateRetentionDraftsBody } from "@workspace/api-zod";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { isRetentionOnlyMode, requiresMarketingConsent } from "../lib/retentionPolicy";
import { generateRetentionDrafts, isRetentionSchemaMissing, regenerateRetentionCandidate, retryRetentionContextBatch } from "../lib/retentionEngine";
import { withGenerationRun } from "../lib/runHistory";
import { DEFAULT_RETENTION_FLOW_KEY, describePlaybookFlow, findRetentionFlow, isSequenceFlowKey } from "../lib/retentionFlows";
import {
  ALLOWED_RETENTION_LOOKBACK_DAYS,
  DEFAULT_RETENTION_LOOKBACK_DAYS,
  retentionSendDateMatchesSchedule,
  toEtDate,
} from "../lib/retentionDates";
import { validateRetentionCoupon } from "../lib/retentionCoupons";
import { sanitizeScheduledSendAt } from "../lib/playerTiming";
import { validateRetentionTextBody } from "../lib/retentionText";
import type { RetentionCandidate, RetentionContext, RetentionMessage, RetentionPlaybook } from "../lib/retentionTypes";
import {
  applyCandidateStatusFilter,
  CANDIDATE_STATUSES,
  decorateApprovalCandidates,
  parseApprovalListStatus,
} from "../lib/retentionApprovals";
import ltpSequenceRouter from "./ltpSequence";
import { approveCandidate, requireLtpSequenceSchemaReady } from "../lib/retentionCandidateApproval";
import { logWinbackResult, runWinback } from "../lib/winback";
import { parseSendTimeEt } from "../lib/approvalKey";
import { etWallClock } from "../lib/retentionAutoApprove";
import { observeKillSwitch } from "../lib/operatorMonitoring";
import { smsLiveEnabled } from "../lib/backgroundPolicy";

const router: IRouter = Router();
router.use(ltpSequenceRouter);
const ExpectedBodySchema = z.string().refine((value) => value.trim().length > 0);
const ApproverSchema = z.object({
  approved_by: z.string().trim().min(1),
  expected_body: ExpectedBodySchema,
  /** Optional "HH:MM" New York send time today (e.g. "14:00"); default is the next minute. */
  send_at_et: z.string().optional(),
});
const EditSchema = z.object({ body: z.string().trim().min(1) });
const BulkSchema = z.object({
  approved_by: z.string().trim().min(1),
  candidate_ids: z.array(z.string().uuid()).min(1),
  expected_bodies: z.record(z.string(), ExpectedBodySchema),
});
const KillSwitchSchema = z.object({ enabled: z.boolean(), actor: z.string().trim().min(1).max(120).optional() });
const RetentionGenerationInputSchema = GenerateRetentionDraftsBody.extend({
  // Optional until the dashboard sends it; the OpenAPI spec gains the field then.
  playbook_key: z.string().refine((key) => !!findRetentionFlow(key), "Unknown retention flow").optional(),
  lookback_days: z.number().int().refine(
    (value) => ALLOWED_RETENTION_LOOKBACK_DAYS.includes(value as (typeof ALLOWED_RETENTION_LOOKBACK_DAYS)[number]),
    `lookback_days must be one of ${ALLOWED_RETENTION_LOOKBACK_DAYS.join(", ")}`,
  ).optional(),
}).strict();

async function retentionMode(clubId: string) {
  const { data: club, error } = await supabase.from("clubs").select("sms_kill_switch").eq("id", clubId).maybeSingle();
  return {
    retention_only: isRetentionOnlyMode(),
    require_marketing_consent: requiresMarketingConsent(),
    sms_live: smsLiveEnabled(),
    test_override_configured: !!process.env.SMS_TEST_OVERRIDE_TO?.trim(),
    kill_switch: error || !club ? null : club.sms_kill_switch === true,
    kill_switch_warning: error
      ? `Could not verify SMS kill switch: ${error.message}`
      : !club ? "SMS kill switch status is unknown: club record was not found" : null,
  };
}

async function missingSchemaResponse(res: any, error: unknown, clubId: string) {
  const mode = await retentionMode(clubId);
  res.status(200).json({
    schema_ready: false,
    playbooks: [],
    candidates: [],
    mode: {
      retention_only: mode.retention_only,
      require_marketing_consent: mode.require_marketing_consent,
      sms_live: mode.sms_live,
      test_override_configured: mode.test_override_configured,
      kill_switch: mode.kill_switch,
    },
    warnings: mode.kill_switch_warning ? [mode.kill_switch_warning] : [],
    error: error instanceof Error ? error.message : String(error),
  });
}

async function fetchAllRows<T>(makeQuery: (from: number, to: number) => any): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []) as T[]);
    if (!data || data.length < 1000) return rows;
  }
}

async function fetchByIds(table: "players" | "messages", select: string, ids: string[], clubId?: string) {
  const results: any[] = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    let query = supabase.from(table).select(select).in("id", ids.slice(offset, offset + 500));
    if (table === "players" && clubId) query = query.eq("club_id", clubId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    results.push(...(data ?? []));
  }
  return results;
}

async function fetchCandidateCounts(clubId: string) {
  const countFor = async (status?: (typeof CANDIDATE_STATUSES)[number]) => {
    let query = supabase.from("retention_candidates").select("id", { count: "exact", head: true }).eq("club_id", clubId);
    if (status) query = query.eq("status", status);
    const { count, error } = await query;
    if (error) throw new Error(error.message);
    return count ?? 0;
  };
  const [all, ...statusCounts] = await Promise.all([
    countFor(),
    ...CANDIDATE_STATUSES.map((status) => countFor(status)),
  ]);
  return {
    all,
    ...Object.fromEntries(CANDIDATE_STATUSES.map((status, index) => [status, statusCounts[index]])),
  };
}

async function loadCandidate(clubId: string, id: string) {
  const { data, error } = await supabase.from("retention_candidates").select("*").eq("id", id).eq("club_id", clubId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as RetentionCandidate | null;
}

async function requireRetentionSchemaReady() {
  const { data, error } = await supabase.rpc("retention_schema_ready");
  if (error) {
    const message = error.message ?? String(error);
    const missing = isRetentionSchemaMissing(new Error(message));
    throw Object.assign(new Error(missing
      ? `Retention migration 011 is not installed: ${message}`
      : message), { status: missing ? 503 : 500 });
  }
  if (data !== true) {
    throw Object.assign(new Error("Retention migration 011 is not installed or is incomplete; retention operations are disabled"), { status: 503 });
  }
}

async function retentionContextRetryReady(): Promise<boolean> {
  const { data, error } = await supabase.rpc("retention_context_retry_ready");
  return !error && data === true;
}

router.get("/retention/approvals", requireClub, async (req, res): Promise<void> => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsedStatus = parseApprovalListStatus(req.query.status);
  if (!parsedStatus.success) {
    res.status(400).json({ error: "status must be one of all, drafted, approved, skipped, sent, needs_context, manual_edit" });
    return;
  }
  const status = parsedStatus.data;
  try {
    const { data: schemaReady, error: readinessError } = await supabase.rpc("retention_schema_ready");
    if (readinessError) {
      if (isRetentionSchemaMissing(new Error(readinessError.message))) {
        return missingSchemaResponse(res, new Error(`Retention migration 011 is not installed: ${readinessError.message}`), clubId);
      }
      throw new Error(readinessError.message);
    }
    if (schemaReady !== true) {
      return missingSchemaResponse(res, new Error("Retention migration 011 is not installed or is incomplete"), clubId);
    }
    const retryContextReady = await retentionContextRetryReady();
    const { data: sequenceReady, error: sequenceReadinessError } = await supabase.rpc("retention_sequence_ready");
    const sequenceSchemaReady = !sequenceReadinessError && sequenceReady === true;
    const { data: playbooks, error: playbookError } = await supabase.from("retention_playbooks").select("*").order("key");
    if (playbookError) throw new Error(playbookError.message);
    const candidates = await fetchAllRows<RetentionCandidate>((from, to) => {
      let query = supabase.from("retention_candidates").select("*").eq("club_id", clubId);
      query = applyCandidateStatusFilter(query, status);
      return query.order("created_at", { ascending: false }).range(from, to);
    });
    const step2Candidates = candidates.filter((candidate) => candidate.step === 2);
    const step2PlayerIds = [...new Set(step2Candidates.map((candidate) => candidate.player_id))];
    const step2PlaybookKeys = [...new Set(step2Candidates.map((candidate) => candidate.playbook_key))];
    const step1Candidates: RetentionCandidate[] = [];
    if (sequenceSchemaReady) {
      for (let offset = 0; offset < step2PlayerIds.length; offset += 500) {
        const { data, error } = await supabase.from("retention_candidates").select("*")
          .eq("club_id", clubId).in("playbook_key", step2PlaybookKeys).eq("step", 1).eq("status", "sent")
          .in("player_id", step2PlayerIds.slice(offset, offset + 500));
        if (error) throw new Error(error.message);
        step1Candidates.push(...(data ?? []) as RetentionCandidate[]);
      }
    }
    const counts = await fetchCandidateCounts(clubId);
    const playerIds = [...new Set(candidates.map((c) => c.player_id))];
    const messageIds = [...new Set([...candidates, ...step1Candidates].map((c) => c.message_id).filter(Boolean))] as string[];
    const [playerRows, messageRows] = await Promise.all([
      fetchByIds("players", "id,name", playerIds, clubId),
      fetchByIds("messages", "id,body,status,approved_at,approved_by,scheduled_send_at,sent_at,simulated,retention_delivery_kind", messageIds),
    ]);
    const players = new Map(playerRows.map((row: any) => [row.id, row]));
    const messages = new Map(messageRows.map((row: any) => [row.id, row]));
    const priorSteps = new Map(step1Candidates.map((candidate) =>
      [`${candidate.playbook_key}:${candidate.player_id}`, messages.get(candidate.message_id)]));
    const mode = await retentionMode(clubId);
    const couponWarnings = await Promise.all((playbooks ?? [])
      .filter((playbook: RetentionPlaybook) => playbook.enabled && playbook.promo_code
        && candidates.some((candidate) => candidate.playbook_key === playbook.key && (candidate.step ?? 1) === 1))
      .map(async (playbook: RetentionPlaybook) => (await validateRetentionCoupon(clubId, playbook.promo_code!)).warning));
    const warnings = [...new Set([
      ...candidates.map((candidate) => candidate.context?.coupon_warning),
      ...couponWarnings,
      mode.kill_switch_warning,
    ].filter(Boolean))] as string[];
    res.json({
      schema_ready: true,
      retry_context_ready: retryContextReady,
      sequence_schema_ready: sequenceSchemaReady,
      playbooks: ((playbooks ?? []) as RetentionPlaybook[]).map(describePlaybookFlow),
      candidates: decorateApprovalCandidates(candidates, players, messages).map((candidate) => ({
        ...candidate,
        ...(candidate.step === 2 ? {
          step1_text: priorSteps.get(`${candidate.playbook_key}:${candidate.player_id}`)?.body ?? null,
          step1_sent_at: priorSteps.get(`${candidate.playbook_key}:${candidate.player_id}`)?.sent_at ?? null,
        } : {}),
      })) as (RetentionCandidate & {
        player: { name: string };
        message: RetentionMessage | null;
      })[],
      counts,
      warnings,
      mode: {
        retention_only: mode.retention_only,
        require_marketing_consent: mode.require_marketing_consent,
        sms_live: mode.sms_live,
        test_override_configured: mode.test_override_configured,
        kill_switch: mode.kill_switch,
      },
    });
  } catch (error: any) {
    if (isRetentionSchemaMissing(error)) return missingSchemaResponse(res, error, clubId);
    res.status(500).json({ schema_ready: true, error: error.message });
  }
});

router.patch("/retention/kill-switch", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = KillSwitchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "enabled must be a boolean; actor, if supplied, must be a nonblank name of at most 120 characters" });
  const { data, error } = await supabase.rpc("retention_set_kill_switch", {
    p_club_id: clubId,
    p_enabled: parsed.data.enabled,
    p_actor: parsed.data.actor ?? null,
    p_request_id: String(req.id ?? ""),
  });
  if (error) return res.status(500).json({ error: `Could not atomically audit and update SMS kill switch. Apply migration 014 if missing: ${error.message}` });
  if (!data) return res.status(404).json({ error: "Club not found; SMS kill switch was not changed" });
  req.log.info({ actor: parsed.data.actor ?? "unidentified operator", ...data }, "SMS kill switch change audited");
  void observeKillSwitch(clubId);
  return res.json(data);
});

router.post("/retention/generate", requireClub, async (req, res): Promise<void> => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = RetentionGenerationInputSchema.safeParse(req.body === undefined ? {} : req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `lookback_days must be one of ${ALLOWED_RETENTION_LOOKBACK_DAYS.join(", ")}` });
    return;
  }
  const requestedLookbackDays = parsed.data.lookback_days ?? DEFAULT_RETENTION_LOOKBACK_DAYS;
  const flowKey = parsed.data.playbook_key ?? DEFAULT_RETENTION_FLOW_KEY;
  try {
    const generated = await withGenerationRun(clubId, flowKey, "Generate", async () => {
      await requireRetentionSchemaReady();
      return generateRetentionDrafts(clubId, requestedLookbackDays, flowKey);
    });
    const responseStats = {
      ...generated.stats,
      // Keep the existing stats.errors detail array and expose its count separately.
      errors: generated.errors,
      error_count: generated.errors.length,
    };
    const missing = generated.errors.find((message) => isRetentionSchemaMissing(new Error(message)));
    if (missing) {
      res.status(503).json({
        run_id: generated.run_id,
        schema_ready: false,
        lookback_days: generated.lookback_days,
        created: generated.stats.created,
        skipped: generated.stats.skipped,
        drafted: generated.stats.drafted,
        needs_context: generated.stats.needs_context,
        manual_edit: generated.stats.manual_edit,
        skipped_candidates: generated.stats.skipped_candidates,
        errors: generated.errors,
        stats: responseStats,
        coupon_check: generated.coupon_check,
        drafts: generated.drafts,
      });
      return;
    }
    res.json({
      run_id: generated.run_id,
      schema_ready: true,
      lookback_days: generated.lookback_days,
      created: generated.stats.created,
      skipped: generated.stats.skipped,
      drafted: generated.stats.drafted,
      needs_context: generated.stats.needs_context,
      manual_edit: generated.stats.manual_edit,
      skipped_candidates: generated.stats.skipped_candidates,
      errors: generated.errors,
      stats: responseStats,
      coupon_check: generated.coupon_check,
      drafts: generated.drafts,
    });
  } catch (error: any) {
    if (isRetentionSchemaMissing(error) || error.status === 503) {
      const stats = {
        found: 0,
        verified: 0,
        new_ltp_players: 0,
        created: 0,
        skipped: 0,
        drafted: 0,
        needs_context: 0,
        manual_edit: 0,
        skipped_candidates: 0,
        error_count: 1,
        skipped_by_reason: {
          no_phone: 0,
          opted_out: 0,
          duplicate: 0,
          holdout: 0,
          marketing_consent: 0,
          missing_player: 0,
          invalid_trigger: 0,
          out_of_window: 0,
          already_returned: 0,
        },
        errors: [error.message],
      };
      res.status(503).json({
        run_id: error.run_id ?? null,
        schema_ready: false,
        lookback_days: requestedLookbackDays,
        created: 0,
        skipped: 0,
        drafted: 0,
        needs_context: 0,
        manual_edit: 0,
        skipped_candidates: 0,
        errors: [error.message],
        stats,
        coupon_check: { code: null, valid: null, warning: null },
        drafts: [],
      });
      return;
    }
    res.status(500).json({ error: error.message, run_id: error.run_id ?? null });
  }
});

router.post("/retention/candidates/:id/regenerate", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const result = await withGenerationRun(clubId, DEFAULT_RETENTION_FLOW_KEY, "Regenerate", async () => {
      await requireRetentionSchemaReady();
      return regenerateRetentionCandidate(clubId, req.params.id as string);
    });
    return res.json(result);
  } catch (error: any) {
    const schemaMissing = isRetentionSchemaMissing(error) || error.status === 503;
    const stale = /changed since|expected_body|expected_context|expected_updated_at|concurrent/i.test(error.message);
    return res.status(error.status ?? (schemaMissing ? 503 : stale ? 409 : 500)).json({
      run_id: error.run_id ?? null,
      schema_ready: !schemaMissing,
      error: error.message,
    });
  }
});

const RetryContextSchema = z.object({
  candidate_ids: z.array(z.string().uuid()).min(1).max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Candidate IDs must be distinct"),
}).strict();

router.post("/retention/retry-context", requireClub, async (req, res) => {
  const parsed = RetryContextSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide 1–50 distinct candidate UUIDs" });
  try {
    return res.json(await withGenerationRun((req as ClubScopedRequest).clubId, DEFAULT_RETENTION_FLOW_KEY, "Retry context batch", async () => {
      await requireRetentionSchemaReady();
      return retryRetentionContextBatch((req as ClubScopedRequest).clubId, parsed.data.candidate_ids);
    }));
  } catch (error: any) {
    return res.status(error.status ?? 500).json({ schema_ready: error.status !== 503, error: error.message, run_id: error.run_id ?? null });
  }
});

router.post("/retention/candidates/:id/retry-context", requireClub, async (req, res) => {
  const parsed = RetryContextSchema.safeParse({ candidate_ids: [req.params.id] });
  if (!parsed.success || !z.object({}).strict().safeParse(req.body ?? {}).success) {
    return res.status(400).json({ error: "A valid candidate UUID and empty request body are required" });
  }
  try {
    return res.json(await withGenerationRun((req as ClubScopedRequest).clubId, DEFAULT_RETENTION_FLOW_KEY, "Retry context", async () => {
      await requireRetentionSchemaReady();
      return retryRetentionContextBatch((req as ClubScopedRequest).clubId, parsed.data.candidate_ids);
    }));
  } catch (error: any) {
    return res.status(error.status ?? 500).json({ schema_ready: error.status !== 503, error: error.message, run_id: error.run_id ?? null });
  }
});

router.patch("/retention/candidates/:id", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = EditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "body must be a non-empty string" });
  try {
    const candidate = await loadCandidate(clubId, req.params.id as string);
    if (!candidate) return res.status(404).json({ error: "Retention candidate not found" });
    if (isSequenceFlowKey(candidate.playbook_key)) {
      await requireLtpSequenceSchemaReady();
      if (candidate.sequence_status !== "active" || !candidate.context.ltp_text) {
        return res.status(409).json({ error: "Only an active rebuilt LTP sequence can be edited" });
      }
    }
    if (!["drafted", "needs_context", "manual_edit"].includes(candidate.status)) {
      return res.status(409).json({ error: "Only a draft or flagged candidate can be edited" });
    }
    const { data: playbook, error: playbookError } = await supabase.from("retention_playbooks")
      .select("*").eq("key", candidate.playbook_key).maybeSingle();
    if (playbookError) throw new Error(playbookError.message);
    if (!playbook) return res.status(409).json({ error: "Retention playbook was not found" });
    try {
      validateRetentionTextBody(parsed.data.body, candidate.context, playbook as RetentionPlaybook);
    } catch (error: any) {
      return res.status(400).json({ error: error.message, validation_errors: error.validation_errors ?? [error.message] });
    }

    let data: unknown;
    let error: { message: string } | null;
    if (candidate.status === "needs_context" || candidate.status === "manual_edit") {
      await requireRetentionSchemaReady();
      const { data: message, error: messageError } = candidate.message_id
        ? await supabase.from("messages").select("body").eq("id", candidate.message_id).maybeSingle()
        : { data: null, error: null };
      if (messageError) throw new Error(messageError.message);
      const result = await supabase.rpc("retention_manual_edit_candidate", {
        p_id: candidate.id,
        p_club_id: clubId,
        p_body: parsed.data.body,
        p_expected_body: message?.body ?? null,
        p_expected_context: candidate.context,
        p_expected_updated_at: candidate.updated_at,
      });
      data = result.data;
      error = result.error;
    } else {
      const result = await supabase.rpc("retention_update_candidate", {
        p_id: candidate.id,
        p_club_id: clubId,
        p_action: "edit",
        p_body: parsed.data.body,
        p_actor: null,
        p_scheduled_at: null,
      });
      data = result.data;
      error = result.error;
    }
    if (error) throw new Error(error.message);
    return res.json(data);
  } catch (error: any) {
    const schemaMissing = isRetentionSchemaMissing(error) || error.status === 503;
    const stale = /changed since|expected_body|expected_context|expected_updated_at|concurrent/i.test(error.message);
    return res.status(error.status ?? (schemaMissing ? 503 : stale ? 409 : 500)).json({ schema_ready: !schemaMissing, error: error.message });
  }
});

router.post("/retention/candidates/:id/approve", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = ApproverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "approved_by and the exact expected_body shown during review are required" });
  try {
    await requireRetentionSchemaReady();
    const candidate = await loadCandidate(clubId, req.params.id as string);
    if (!candidate) return res.status(404).json({ error: "Retention candidate not found" });
    let schedule: Date | undefined;
    if (parsed.data.send_at_et) {
      const time = parseSendTimeEt(parsed.data.send_at_et);
      if (!time) return res.status(400).json({ error: "send_at_et must be HH:MM between 08:30 and 19:30 New York time" });
      schedule = etWallClock(toEtDate(new Date()), time.hour, time.minute);
      if (schedule.getTime() <= Date.now() + 60_000) {
        return res.status(409).json({ error: `${parsed.data.send_at_et} New York time has already passed today; approve without a time to send now` });
      }
    }
    return res.json(await approveCandidate(clubId, candidate, parsed.data.approved_by, parsed.data.expected_body, schedule));
  } catch (error: any) {
    const missingSchema = isRetentionSchemaMissing(error) || error.status === 503;
    return res.status(error.status ?? (missingSchema ? 503 : 500)).json({ schema_ready: !missingSchema, error: error.message });
  }
});

// Lapsing-regular win-back: build today's drafts now (no approvals, no sends).
router.post("/retention/winback/run", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const result = await runWinback(clubId);
    logWinbackResult(result);
    const status = result.status === "not_installed" ? 503 : 200;
    return res.status(status).json({
      ...result,
      ...(result.status === "not_installed" ? { error: "Apply migration 032_winback_flow.sql first" } : {}),
      ...(result.status === "stale_data" ? { error: `Attendance data only runs through ${result.data_through ?? "nothing"}; run the nightly sync first` } : {}),
    });
  } catch (error: any) {
    return res.status(error.status ?? 500).json({ error: error.message });
  }
});

router.post("/retention/candidates/:id/skip", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const { data, error } = await supabase.rpc("retention_update_candidate", {
      p_id: req.params.id,
      p_club_id: clubId,
      p_action: "skip",
      p_body: null,
      p_actor: null,
      p_scheduled_at: null,
    });
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (error: any) {
    res.status(isRetentionSchemaMissing(error) ? 503 : 500).json({ schema_ready: !isRetentionSchemaMissing(error), error: error.message });
  }
});

router.post("/retention/playbooks/:key/approve", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = BulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "approved_by, candidate_ids, and exact expected_bodies are required" });
  try {
    await requireRetentionSchemaReady();
    const ids = [...new Set(parsed.data.candidate_ids)];
    const missingExpected = ids.filter((id) => !Object.prototype.hasOwnProperty.call(parsed.data.expected_bodies, id));
    if (missingExpected.length) {
      return res.status(400).json({ error: "Missing expected body snapshots for candidate IDs", candidate_ids: missingExpected });
    }
    const { data, error } = await supabase.from("retention_candidates").select("*").eq("club_id", clubId)
      .eq("playbook_key", req.params.key).eq("status", "drafted").in("id", ids);
    if (error) throw new Error(error.message);
    const bulkSchedule = sanitizeScheduledSendAt(new Date(Date.now() + 60_000));
    if (!bulkSchedule) {
      return res.status(409).json({ approved: 0, error: "Could not find an open TCPA send window" });
    }
    const approved: unknown[] = [];
    const errors: { candidate_id: string; error: string; status?: number }[] = [];
    const foundIds = new Set((data ?? []).map((row: any) => row.id));
    for (const id of ids) {
      if (!foundIds.has(id)) errors.push({ candidate_id: id, error: "Candidate is not a draft in this playbook and club" });
    }
    const dateMismatches = (data ?? []).filter((row: any) =>
      !retentionSendDateMatchesSchedule(row.context?.send_date_et, bulkSchedule),
    );
    if (dateMismatches.length) {
      return res.status(409).json({
        approved: 0,
        error: "The intended ET send date changed. Regenerate and review candidates before approving.",
        candidate_ids: dateMismatches.map((row: any) => row.id),
      });
    }
    for (const row of data as RetentionCandidate[]) {
      try {
        approved.push(await approveCandidate(
          clubId, row, parsed.data.approved_by, parsed.data.expected_bodies[row.id], bulkSchedule,
        ));
      } catch (error: any) {
        errors.push({ candidate_id: row.id, error: error.message, status: error.status ?? 500 });
      }
    }
    return res.json({ approved: approved.length, candidates: approved, errors });
  } catch (error: any) {
    const schemaMissing = isRetentionSchemaMissing(error) || error.status === 503;
    return res.status(error.status ?? (schemaMissing ? 503 : 500)).json({ schema_ready: !schemaMissing, error: error.message });
  }
});

export default router;