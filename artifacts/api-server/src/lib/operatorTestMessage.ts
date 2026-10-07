import { randomUUID } from "node:crypto";
import { supabase } from "./supabaseClient";
import { DispatchAudit } from "./dispatchAudit";
import { assertSmsKillSwitchOff, submitProductionSms, SmsPolicyBlockedError, getSmsTransportTime } from "./twilio";
import { isInsideSendWindow } from "./playerTiming";

export const OPERATOR_TEST_TEXT = "PB Club production test. No action needed.";
export function operatorTestAvailable() { return !!process.env.SMS_TEST_OVERRIDE_TO?.trim(); }
const requireOverride = () => {
  const to = process.env.SMS_TEST_OVERRIDE_TO?.trim();
  if (!to || !/^\+[1-9]\d{7,14}$/.test(to)) {
    throw Object.assign(new Error("A valid SMS_TEST_OVERRIDE_TO is required"), { status: 403 });
  }
  return to;
};

// No candidate, player, sequence, or approval is created by this explicit operator action.
export async function sendOperatorTestMessage(clubId: string, actor: string) {
  const to = requireOverride();
  if (process.env.SMS_LIVE !== "true") throw new SmsPolicyBlockedError("Live sending is off; operator test blocked");
  await assertSmsKillSwitchOff(clubId);
  if (!isInsideSendWindow(getSmsTransportTime())) throw new SmsPolicyBlockedError("Outside the TCPA send window");
  const id = randomUUID();
  const token = randomUUID();
  const audit = new DispatchAudit(id);
  // Ledger audit is persisted before provider submission, so failures are also accounted for.
  const { error: messageError } = await supabase.from("messages").insert({
    id, direction: "outbound", body: OPERATOR_TEST_TEXT, sent_by: "agent",
    player_id: null, conversation_id: null, status: "pending", sent_at: null,
    approved_at: null, approved_by: null, approved_body: null,
    retention_delivery_kind: "test", simulated: false, delivery_status: null,
    dispatch_token: token, dispatch_claimed_at: new Date().toISOString(),
  });
  if (messageError) throw new Error(`Cannot record operator test: ${messageError.message}`);
  const { error: ledgerError } = await supabase.from("contact_ledger").insert({
    club_id: clubId, message_id: id, player_id: null, intended_player_id: null,
    is_test: true, source: "system", purpose: "operator_test", channel: "sms",
    outcome: JSON.stringify({ action: "operator_test", actor, result: "attempted" }), sent_at: new Date().toISOString(),
  });
  if (ledgerError) {
    await supabase.from("messages").update({ status: "failed", error_message: "Operator test ledger unavailable; not submitted" }).eq("id", id);
    throw new Error(`Cannot audit operator test: ${ledgerError.message}`);
  }
  try {
    if (requireOverride() !== to) throw new SmsPolicyBlockedError("Test override changed; refusing dispatch");
    const result = await submitProductionSms(clubId, to, OPERATOR_TEST_TEXT, audit, undefined, id);
    const at = getSmsTransportTime().toISOString();
    const { error } = await supabase.from("messages").update({
      status: "sent", twilio_message_sid: result.sid, sent_at: at,
    }).eq("id", id).eq("dispatch_token", token).eq("status", "pending");
    if (error) throw new Error(`Twilio accepted ${result.sid}, but message bookkeeping failed; reconcile before retrying`);
    // A receipt can arrive before the provider response is recorded. Never replace it with "queued".
    const { error: receiptError } = await supabase.from("messages").update({ delivery_status: result.status })
      .eq("id", id).is("delivery_status", null);
    if (receiptError) throw new Error(`Twilio accepted ${result.sid}, but status bookkeeping failed; reconcile before retrying`);
    const { error: ledgerUpdateError } = await supabase.from("contact_ledger").update({
      sent_at: at, outcome: JSON.stringify({ action: "operator_test", actor, result: "accepted", sid: result.sid }),
    }).eq("message_id", id);
    if (ledgerUpdateError) throw new Error(`Twilio accepted ${result.sid}, but ledger bookkeeping failed; reconcile before retrying`);
    audit.end("pass");
    return { message_id: id, twilio_sid: result.sid, delivery_status: result.status, status: "sent" };
  } catch (error) {
    audit.end("error", { error: String(error) });
    await supabase.from("messages").update({ status: "failed", error_message: String(error) }).eq("id", id);
    throw error;
  }
}

export async function getOperatorTestMessages(clubId: string) {
  const { data: ledger, error: ledgerError } = await supabase.from("contact_ledger")
    .select("message_id,outcome").eq("club_id", clubId).eq("source", "system").eq("is_test", true)
    .order("created_at", { ascending: false }).limit(50);
  if (ledgerError) throw new Error(ledgerError.message);
  const ids = (ledger ?? []).filter(row => {
    try { return JSON.parse(row.outcome ?? "{}").action === "operator_test"; } catch { return false; }
  }).map(row => row.message_id);
  if (!ids.length) return [];
  const { data, error } = await supabase.from("messages")
    .select("id,status,twilio_message_sid,delivery_status,error_message,sent_at,delivered_at")
    .in("id", ids).order("created_at", { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => ({ ...row, message_id: row.id, twilio_sid: row.twilio_message_sid }));
}
