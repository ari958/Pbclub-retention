import { supabase } from "./supabaseClient";
import { isSequenceFlowKey } from "./retentionFlows";
import { retentionSendDateMatchesSchedule } from "./retentionDates";
import { validateRetentionCoupon } from "./retentionCoupons";
import { sanitizeScheduledSendAt } from "./playerTiming";
import { isStaleReviewedBodyError } from "./retentionApproval";
import { assertRetentionDraftFresh } from "./retentionFreshness";
import { validateRetentionTextBody } from "./retentionText";
import type { RetentionCandidate, RetentionContext } from "./retentionTypes";

export async function requireLtpSequenceSchemaReady() {
  const { data, error } = await supabase.rpc("retention_sequence_ready");
  if (error || data !== true) {
    throw Object.assign(new Error(
      "Apply migration 013_retention_ltp_sequence.sql in the existing Supabase SQL Editor before using the two-step LTP sequence",
    ), { status: 503 });
  }
}

/**
 * Approve one drafted retention candidate and schedule its send. Shared by the
 * operator approval routes and the nightly auto-approver so both run the exact
 * same checks (freshness, sequence state, text rules, coupon, TCPA window,
 * send date) and the same atomic RPC.
 */
export async function approveCandidate(
  clubId: string,
  candidate: RetentionCandidate,
  approvedBy: string,
  expectedBody: string,
  requestedSchedule?: Date,
) {
  assertRetentionDraftFresh(candidate);
  if (candidate.status !== "drafted") {
    throw Object.assign(new Error("Only drafted candidates can be approved"), { status: 409 });
  }
  if (isSequenceFlowKey(candidate.playbook_key)) {
    await requireLtpSequenceSchemaReady();
    if (candidate.sequence_status !== "active" || !candidate.context.ltp_text
      || candidate.context.reason != null || candidate.context.ltp_text.step !== candidate.step) {
      throw Object.assign(new Error("Rebuild and review an active two-step LTP draft before approving"), { status: 409 });
    }
  }
  const context = candidate.context as RetentionContext;
  try {
    validateRetentionTextBody(expectedBody, context, {
      key: candidate.playbook_key,
      name: candidate.playbook_key,
      enabled: true,
      promo_code: context.promo?.code ?? null,
      offer_text: context.promo?.offer_text ?? null,
      next_program_names: [],
      message_guidance: null,
      holdout_pct: 0,
    });
  } catch (error: any) {
    throw Object.assign(new Error(error.message), { status: 409 });
  }
  if ((candidate.step ?? 1) === 1 && context.promo?.code) {
    const validation = await validateRetentionCoupon(clubId, context.promo.code);
    if (!validation.valid) throw Object.assign(new Error(validation.warning ?? "Promotion could not be verified"), { status: 409 });
  }
  const schedule = requestedSchedule ?? sanitizeScheduledSendAt(new Date(Date.now() + 60_000));
  if (!schedule) throw Object.assign(new Error("Could not find an open TCPA send window"), { status: 409 });
  if (!retentionSendDateMatchesSchedule(context.send_date_et, schedule)) {
    throw Object.assign(
      new Error("The intended ET send date changed. Regenerate and review this candidate before approving."),
      { status: 409 },
    );
  }
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
