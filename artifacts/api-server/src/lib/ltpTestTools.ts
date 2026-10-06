import { supabase } from "./supabaseClient";

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

export async function ltpTestRpc(operation: string, clubId: string, payload: Record<string, unknown>) {
  requireLtpTestOverride();
  const { data, error } = await supabase.rpc("retention_ltp_test_rpc", {
    p_club_id: clubId, p_operation: operation, p_payload: payload, p_override_enabled: true,
  });
  if (error) {
    const missing = /schema cache|could not find the function|does not exist/i.test(error.message);
    throw Object.assign(new Error(missing
      ? "Apply migration 015_ltp_test_tools.sql in the existing Supabase SQL Editor first"
      : error.message), { status: missing ? 503 : error.code === "42501" ? 403 : 409 });
  }
  return data;
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
