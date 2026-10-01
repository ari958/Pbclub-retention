import { Router, type IRouter } from "express";
import { z } from "zod";
import { GenerateRetentionDraftsBody } from "@workspace/api-zod";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { isRetentionOnlyMode, requiresMarketingConsent } from "../lib/retentionPolicy";
import { generateRetentionDrafts, isRetentionSchemaMissing } from "../lib/retentionEngine";
import { DEFAULT_RETENTION_LOOKBACK_DAYS, MAX_RETENTION_LOOKBACK_DAYS } from "../lib/retentionDates";
import { validateRetentionCoupon } from "../lib/retentionCoupons";
import { sanitizeScheduledSendAt } from "../lib/playerTiming";
import { isStaleReviewedBodyError } from "../lib/retentionApproval";
import type { RetentionCandidate, RetentionContext, RetentionMessage, RetentionPlaybook } from "../lib/retentionTypes";
import {
  applyCandidateStatusFilter,
  CANDIDATE_STATUSES,
  decorateApprovalCandidates,
  parseApprovalListStatus,
} from "../lib/retentionApprovals";

const router: IRouter = Router();
const ExpectedBodySchema = z.string().refine((value) => value.trim().length > 0);
const ApproverSchema = z.object({ approved_by: z.string().trim().min(1), expected_body: ExpectedBodySchema });
const EditSchema = z.object({ body: z.string().trim().min(1) });
const BulkSchema = z.object({
  approved_by: z.string().trim().min(1),
  candidate_ids: z.array(z.string().uuid()).min(1),
  expected_bodies: z.record(z.string(), ExpectedBodySchema),
});
const KillSwitchSchema = z.object({ enabled: z.boolean() });
const RetentionGenerationInputSchema = GenerateRetentionDraftsBody.extend({
  lookback_days: z.number().int().positive().optional(),
}).strict();

async function retentionMode(clubId: string) {
  const { data: club, error } = await supabase.from("clubs").select("sms_kill_switch").eq("id", clubId).maybeSingle();
  return {
    retention_only: isRetentionOnlyMode(),
    require_marketing_consent: requiresMarketingConsent(),
    sms_live: process.env.SMS_LIVE === "true",
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
  const [all, drafted, approved, skipped, sent] = await Promise.all([
    countFor(),
    ...CANDIDATE_STATUSES.map((status) => countFor(status)),
  ]);
  return { all, drafted, approved, skipped, sent };
}

async function loadCandidate(clubId: string, id: string) {
  const { data, error } = await supabase.from("retention_candidates").select("*").eq("id", id).eq("club_id", clubId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as RetentionCandidate | null;
}

async function approveCandidate(clubId: string, candidate: RetentionCandidate, approvedBy: string, expectedBody: string) {
  const context = candidate.context as RetentionContext;
  if (context.promo?.code) {
    const validation = await validateRetentionCoupon(clubId, context.promo.code);
    if (!validation.valid) throw Object.assign(new Error(validation.warning ?? "Promotion could not be verified"), { status: 409 });
  }
  const schedule = sanitizeScheduledSendAt(new Date(Date.now() + 60_000));
  if (!schedule) throw Object.assign(new Error("Could not find an open TCPA send window"), { status: 409 });
  const { data, error } = await supabase.rpc("retention_update_candidate", {
    p_id: candidate.id,
    p_club_id: clubId,
    p_action: "approve",
    p_body: expectedBody,
    p_actor: approvedBy.trim(),
    p_scheduled_at: schedule.toISOString(),
  });
  if (error) {
    throw Object.assign(new Error(error.message), { status: isStaleReviewedBodyError(error.message) ? 409 : 500 });
  }
  return data;
}

router.get("/retention/approvals", requireClub, async (req, res): Promise<void> => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsedStatus = parseApprovalListStatus(req.query.status);
  if (!parsedStatus.success) {
    res.status(400).json({ error: "status must be one of all, drafted, approved, skipped, sent" });
    return;
  }
  const status = parsedStatus.data;
  try {
    const { data: playbooks, error: playbookError } = await supabase.from("retention_playbooks").select("*").order("key");
    if (playbookError) throw new Error(playbookError.message);
    const candidates = await fetchAllRows<RetentionCandidate>((from, to) => {
      let query = supabase.from("retention_candidates").select("*").eq("club_id", clubId);
      query = applyCandidateStatusFilter(query, status);
      return query.order("created_at", { ascending: false }).range(from, to);
    });
    const counts = await fetchCandidateCounts(clubId);
    const playerIds = [...new Set(candidates.map((c) => c.player_id))];
    const messageIds = [...new Set(candidates.map((c) => c.message_id).filter(Boolean))] as string[];
    const [playerRows, messageRows] = await Promise.all([
      fetchByIds("players", "id,name", playerIds, clubId),
      fetchByIds("messages", "id,body,status,approved_at,approved_by,scheduled_send_at,sent_at,simulated", messageIds),
    ]);
    const players = new Map(playerRows.map((row: any) => [row.id, row]));
    const messages = new Map(messageRows.map((row: any) => [row.id, row]));
    const mode = await retentionMode(clubId);
    const couponWarnings = await Promise.all((playbooks ?? [])
      .filter((playbook: RetentionPlaybook) => playbook.enabled && playbook.promo_code)
      .map(async (playbook: RetentionPlaybook) => (await validateRetentionCoupon(clubId, playbook.promo_code!)).warning));
    const warnings = [...new Set([
      ...candidates.map((candidate) => candidate.context?.coupon_warning),
      ...couponWarnings,
      mode.kill_switch_warning,
    ].filter(Boolean))] as string[];
    res.json({
      schema_ready: true,
      playbooks: (playbooks ?? []) as RetentionPlaybook[],
      candidates: decorateApprovalCandidates(candidates, players, messages) as (RetentionCandidate & {
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
  if (!parsed.success) return res.status(400).json({ error: "enabled must be a boolean" });
  const { data, error } = await supabase.from("clubs")
    .update({ sms_kill_switch: parsed.data.enabled })
    .eq("id", clubId)
    .select("id,sms_kill_switch")
    .maybeSingle();
  if (error) return res.status(500).json({ error: `Could not update SMS kill switch: ${error.message}` });
  if (!data) return res.status(404).json({ error: "Club not found; SMS kill switch was not changed" });
  return res.json({ enabled: data.sms_kill_switch === true });
});

router.post("/retention/generate", requireClub, async (req, res): Promise<void> => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = RetentionGenerationInputSchema.safeParse(req.body === undefined ? {} : req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "lookback_days must be a positive integer" });
    return;
  }
  const requestedLookbackDays = parsed.data.lookback_days ?? DEFAULT_RETENTION_LOOKBACK_DAYS;
  try {
    const generated = await generateRetentionDrafts(clubId, requestedLookbackDays);
    const responseStats = {
      ...generated.stats,
      // Keep the existing stats.errors detail array and expose its count separately.
      errors: generated.errors,
      error_count: generated.errors.length,
    };
    const missing = generated.errors.find((message) => isRetentionSchemaMissing(new Error(message)));
    if (missing) {
      res.status(503).json({
        schema_ready: false,
        lookback_days: generated.lookback_days,
        created: generated.stats.created,
        skipped: generated.stats.skipped,
        errors: generated.errors,
        stats: responseStats,
        coupon_check: generated.coupon_check,
        drafts: generated.drafts,
      });
      return;
    }
    res.json({
      schema_ready: true,
      lookback_days: generated.lookback_days,
      created: generated.stats.created,
      skipped: generated.stats.skipped,
      errors: generated.errors,
      stats: responseStats,
      coupon_check: generated.coupon_check,
      drafts: generated.drafts,
    });
  } catch (error: any) {
    if (isRetentionSchemaMissing(error)) {
      const stats = {
        found: 0,
        verified: 0,
        new_ltp_players: 0,
        created: 0,
        skipped: 0,
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
        },
        errors: [error.message],
      };
      res.status(503).json({
        schema_ready: false,
        lookback_days: Math.min(requestedLookbackDays, MAX_RETENTION_LOOKBACK_DAYS),
        created: 0,
        skipped: 0,
        errors: [error.message],
        stats,
        coupon_check: { code: null, valid: null, warning: null },
        drafts: [],
      });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

router.patch("/retention/candidates/:id", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = EditSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "body must be a non-empty string" });
  try {
    const { data, error } = await supabase.rpc("retention_update_candidate", {
      p_id: req.params.id,
      p_club_id: clubId,
      p_action: "edit",
      p_body: parsed.data.body,
      p_actor: null,
      p_scheduled_at: null,
    });
    if (error) throw new Error(error.message);
    return res.json(data);
  } catch (error: any) {
    return res.status(isRetentionSchemaMissing(error) ? 503 : 500).json({ schema_ready: !isRetentionSchemaMissing(error), error: error.message });
  }
});

router.post("/retention/candidates/:id/approve", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = ApproverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "approved_by and the exact expected_body shown during review are required" });
  try {
    const candidate = await loadCandidate(clubId, req.params.id as string);
    if (!candidate) return res.status(404).json({ error: "Retention candidate not found" });
    return res.json(await approveCandidate(clubId, candidate, parsed.data.approved_by, parsed.data.expected_body));
  } catch (error: any) {
    return res.status(error.status ?? (isRetentionSchemaMissing(error) ? 503 : 500)).json({ schema_ready: !isRetentionSchemaMissing(error), error: error.message });
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
    const ids = [...new Set(parsed.data.candidate_ids)];
    const missingExpected = ids.filter((id) => !Object.prototype.hasOwnProperty.call(parsed.data.expected_bodies, id));
    if (missingExpected.length) {
      return res.status(400).json({ error: "Missing expected body snapshots for candidate IDs", candidate_ids: missingExpected });
    }
    const { data, error } = await supabase.from("retention_candidates").select("*").eq("club_id", clubId)
      .eq("playbook_key", req.params.key).eq("status", "drafted").in("id", ids);
    if (error) throw new Error(error.message);
    const approved: unknown[] = [];
    const errors: { candidate_id: string; error: string; status?: number }[] = [];
    const foundIds = new Set((data ?? []).map((row: any) => row.id));
    for (const id of ids) {
      if (!foundIds.has(id)) errors.push({ candidate_id: id, error: "Candidate is not a draft in this playbook and club" });
    }
    for (const row of data as RetentionCandidate[]) {
      try {
        approved.push(await approveCandidate(clubId, row, parsed.data.approved_by, parsed.data.expected_bodies[row.id]));
      } catch (error: any) {
        errors.push({ candidate_id: row.id, error: error.message, status: error.status ?? 500 });
      }
    }
    return res.json({ approved: approved.length, candidates: approved, errors });
  } catch (error: any) {
    return res.status(error.status ?? (isRetentionSchemaMissing(error) ? 503 : 500)).json({ schema_ready: !isRetentionSchemaMissing(error), error: error.message });
  }
});

export default router;