import { supabase } from "./supabaseClient";
import { logger } from "./logger";
import { verifyStoredLtpDestinations } from "./ltpTestDestinations";

export function requireLtpTestOverride(): void {
  if (!process.env.SMS_TEST_OVERRIDE_TO?.trim()) {
    throw Object.assign(new Error("SMS_TEST_OVERRIDE_TO is required for LTP test tooling"), { status: 403 });
  }
}

export async function resetSimulatedLtpTestMessage(clubId: string, candidateId: string, actor: string): Promise<void> {
  requireLtpTestOverride();
  const { error } = await supabase.rpc("retention_ltp_test_reset", {
    p_club_id: clubId, p_candidate_id: candidateId, p_actor: actor, p_override_enabled: true,
  });
  if (error) {
    const missing = /schema cache|could not find the function|does not exist/i.test(error.message);
    throw Object.assign(new Error(missing
      ? "Apply migration 016_ltp_simulation_reset_and_draft_timestamps.sql in the existing Supabase SQL Editor first"
      : error.message), { status: missing ? 503 : error.code === "42501" ? 403 : 409 });
  }
}

/** Adapt the reset marker to the installed retry-context RPC's reason enum.
 * Keep needs_context throughout; never promote stale text to an approvable draft.
 */
export async function prepareLtpSimulationResetRetry(clubId: string, candidate: {
  id: string; status: string; context: Record<string, any>; updated_at: string;
}): Promise<void> {
  requireLtpTestOverride();
  if (candidate.status !== "needs_context" || candidate.context?.reason !== "test_reset_requires_rebuild") {
    throw Object.assign(new Error("Only a reset awaiting fresh context can enter recovery"), { status: 409 });
  }
  const { data, error } = await supabase.from("retention_candidates").update({
    context: { ...candidate.context, reason: "context_lookup_failed", recovery_reason: "test_reset_requires_rebuild" },
  }).eq("id", candidate.id).eq("club_id", clubId).eq("status", "needs_context")
    .eq("updated_at", candidate.updated_at).eq("context", JSON.stringify(candidate.context))
    .select("id").maybeSingle();
  if (error || !data) throw Object.assign(new Error(error?.message ?? "Reset candidate changed before context recovery"), { status: 409 });
}

export async function ltpTestRpc(operation: string, clubId: string, payload: Record<string, unknown>) {
  let sequenceId: string | null = null;
  const actor = typeof payload.actor === "string" ? payload.actor : "unknown";
  try {
  let checkedPayload = payload;
  if (operation === "backdate" && typeof payload.candidate_id === "string") {
    const { data: candidate, error } = await supabase.from("retention_candidates")
      .select("sequence_id").eq("club_id", clubId).eq("id", payload.candidate_id).maybeSingle();
    if (error || !candidate?.sequence_id) throw Object.assign(new Error("Candidate sequence could not be verified"), { status: 403 });
    sequenceId = candidate.sequence_id;
  }
  requireLtpTestOverride();
  if (operation === "backdate") {
    if (!sequenceId) throw Object.assign(new Error("Sequence is required"), { status: 403 });
    const { data: sequence, error: se } = await supabase.from("retention_sequences")
      .select("step1_sent_at,step2_sent_at,step1_message_id,step2_message_id")
      .eq("club_id", clubId).eq("id", sequenceId).single();
    const { data: candidates, error: ce } = await supabase.from("retention_candidates")
      .select("message_id").eq("club_id", clubId).eq("sequence_id", sequenceId);
    if (se || ce || !sequence || !candidates) throw new Error("Sequence messages could not be verified");
    if ((sequence.step1_sent_at && !sequence.step1_message_id) || (sequence.step2_sent_at && !sequence.step2_message_id)) {
      throw new Error("A sent step has no linked message");
    }
    const ids = [...new Set([sequence.step1_message_id, sequence.step2_message_id,
      ...candidates.map(c => c.message_id)].filter(Boolean))];
    const { data: messages, error: me } = await supabase.from("messages")
      .select("id,twilio_message_sid,status,sent_at").in("id", ids);
    if (me || !messages || messages.length !== ids.length) throw new Error("Linked message evidence is missing");
    const sent = messages.filter(m => m.status === "sent" || m.id === sequence.step1_message_id
      || (sequence.step2_sent_at && m.id === sequence.step2_message_id));
    const destinations = await verifyStoredLtpDestinations(sent, process.env.SMS_TEST_OVERRIDE_TO!.trim());
    checkedPayload = { ...payload, override_to: process.env.SMS_TEST_OVERRIDE_TO!.trim(),
      verified_destinations: destinations, destination_evidence_source: "twilio_stored" };
  }
  const { data, error } = await supabase.rpc("retention_ltp_test_rpc", {
    p_club_id: clubId, p_operation: operation, p_payload: checkedPayload, p_override_enabled: true,
  });
  if (error) {
    const missing = /schema cache|could not find the function|does not exist/i.test(error.message);
    throw Object.assign(new Error(missing
      ? "Apply migration 015_ltp_test_tools.sql in the existing Supabase SQL Editor first"
      : error.message), { status: missing ? 503 : error.code === "42501" ? 403 : 409 });
  }
  if (operation === "backdate") logger.info({ sequence_id: sequenceId, operator: actor, candidate_id: payload.candidate_id }, "LTP backdate used");
  return data;
  } catch (error) {
    if (operation === "backdate") logger.warn({ sequence_id: sequenceId, operator: actor,
      candidate_id: payload.candidate_id, reason: error instanceof Error ? error.message : "Verification failed" }, "LTP backdate refused");
    // Do not expose provider error details (which can contain phone numbers).
    if (operation === "backdate") throw Object.assign(new Error("LTP backdate refused; override and all stored destinations must be verified"), { status: 403 });
    throw error;
  }
}

export interface LtpTestControl {
  original_sent_at: string;
  effective_sent_at: string;
  simulated_booking: boolean;
}

/** Test controls are invisible when the override is absent, not real eligibility. */
export async function readLtpTestControl(clubId: string, sequenceId: string): Promise<LtpTestControl | null> {
  if (!process.env.SMS_TEST_OVERRIDE_TO?.trim()) return null;
  const { data, error } = await supabase.from("retention_ltp_test_controls")
    .select("original_sent_at,effective_sent_at,simulated_booking")
    .eq("club_id", clubId).eq("sequence_id", sequenceId).maybeSingle();
  if (error) {
    // Old deployments remain operational before this additive migration.
    if (error.code === "PGRST205" || error.code === "42P01") return null;
    throw new Error(`Could not verify LTP test control: ${error.message}`);
  }
  return data;
}

/**
 * Compatibility with legacy databases whose messages.sent_at defaults to now().
 * Only freshly created, unapproved test step-2 drafts may lose that creation-time
 * default. Verified sent messages, delivery evidence, and real drafts are excluded.
 */
export async function normalizeCreatedLtpTestDrafts(clubId: string, saved: any[]): Promise<void> {
  requireLtpTestOverride();
  if (!Array.isArray(saved)) throw new Error("Test save returned invalid candidate rows");
  const drafts = saved.filter((c) => c.step === 2 && c.status === "drafted");
  if (!drafts.length) return;
  if (drafts.some((c) => c.club_id !== clubId || c.context?.ltp_test_mode !== true || !c.created_at)) {
    throw new Error("Only newly created test step-2 drafts can normalize creation-time defaults");
  }
  const { data: controls, error: controlError } = await supabase.from("retention_ltp_test_controls")
    .select("candidate_id").eq("club_id", clubId).in("sequence_id", drafts.map((c) => c.sequence_id));
  if (controlError || controls?.length !== drafts.length) throw new Error("Verified test controls are required");
  // The wrapper validates original test-send/ledger evidence even when an
  // existing step-2 candidate means this read-only due call returns no rows.
  await ltpTestRpc("due", clubId, { candidate_ids: controls.map((c: any) => c.candidate_id) });
  for (const candidate of drafts) {
    const { data: message, error } = await supabase.from("messages")
      .select("id,status,sent_at,approved_at,scheduled_send_at,dispatch_claimed_at,retention_delivery_kind,delivery_status,delivered_at")
      .eq("id", candidate.message_id).eq("player_id", candidate.player_id).maybeSingle();
    if (error || !message || message.status !== "pending" || message.approved_at
      || message.scheduled_send_at || message.dispatch_claimed_at || message.retention_delivery_kind
      || message.delivery_status || message.delivered_at) {
      throw new Error("Draft changed or has approval/dispatch/delivery evidence; no timestamp normalized");
    }
    if (message.sent_at === null) continue;
    if (Date.parse(message.sent_at) !== Date.parse(candidate.created_at)) {
      throw new Error("Unexpected draft timestamp; no timestamp normalized");
    }
    const { data: updated, error: updateError } = await supabase.from("messages").update({ sent_at: null })
      .eq("id", candidate.message_id).eq("player_id", candidate.player_id).eq("status", "pending")
      .eq("sent_at", message.sent_at).is("approved_at", null).is("scheduled_send_at", null)
      .is("dispatch_claimed_at", null).is("retention_delivery_kind", null)
      .is("delivery_status", null).is("delivered_at", null).select("id").maybeSingle();
    if (updateError || !updated) throw new Error(updateError?.message ?? "Draft changed before normalization");
  }
}
