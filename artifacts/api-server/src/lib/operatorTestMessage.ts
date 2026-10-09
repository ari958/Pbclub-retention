import { randomUUID } from "node:crypto";
import { supabase } from "./supabaseClient";
import { DispatchAudit } from "./dispatchAudit";
import { assertSmsKillSwitchOff, submitProductionSms, SmsPolicyBlockedError, getSmsTransportTime } from "./twilio";
import { isInsideSendWindow } from "./playerTiming";
import { smsLiveEnabled } from "./backgroundPolicy";

export const OPERATOR_TEST_TEXT = "PB Club production test. No action needed.";
export function operatorTestAvailable() { return !!process.env.SMS_TEST_OVERRIDE_TO?.trim(); }
const requireOverride = () => {
  const to = process.env.SMS_TEST_OVERRIDE_TO?.trim();
  if (!to || !/^\+[1-9]\d{7,14}$/.test(to)) {
    throw Object.assign(new Error("A valid SMS_TEST_OVERRIDE_TO is required"), { status: 403 });
  }
  return to;
};

/** Private audit table (migration 030). Never public.messages or contact_ledger:
 *  a test to the operator's own phone is not a player contact. */
export const OPERATOR_TEST_TABLE = "operator_test_messages";
const RECEIPT_COLUMNS = "id,status,twilio_message_sid,delivery_status,error_message,sent_at,delivered_at";

type OperatorTestRow = {
  id: string; status: string; twilio_message_sid: string | null; delivery_status: string | null;
  error_message: string | null; sent_at: string | null; delivered_at: string | null;
};
const present = (row: OperatorTestRow) => ({ ...row, message_id: row.id, twilio_sid: row.twilio_message_sid });

// No candidate, player, sequence, or approval is created by this explicit operator action.
export async function sendOperatorTestMessage(clubId: string, actor: string) {
  const to = requireOverride();
  if (!smsLiveEnabled()) throw new SmsPolicyBlockedError("Live sending is off; operator test blocked");
  await assertSmsKillSwitchOff(clubId);
  if (!isInsideSendWindow(getSmsTransportTime())) throw new SmsPolicyBlockedError("Outside the TCPA send window");
  const id = randomUUID();
  const audit = new DispatchAudit(id);
  // The audit row is persisted before provider submission, so failures are also accounted for.
  const { error: recordError } = await supabase.from(OPERATOR_TEST_TABLE).insert({
    id, club_id: clubId, actor, status: "pending",
  });
  if (recordError) throw new Error(`Cannot record operator test; install migration 030: ${recordError.message}`);
  let accepted: string | null = null;
  try {
    if (requireOverride() !== to) throw new SmsPolicyBlockedError("Test override changed; refusing dispatch");
    const result = await submitProductionSms(clubId, to, OPERATOR_TEST_TEXT, audit, undefined, id);
    accepted = result.sid;
    const at = getSmsTransportTime().toISOString();
    // An early signed receipt may already have bound this SID (or failed the test).
    const { error } = await supabase.from(OPERATOR_TEST_TABLE).update({
      status: "sent", twilio_message_sid: result.sid, sent_at: at,
    }).eq("id", id).eq("status", "pending");
    if (error) throw new Error(`Twilio accepted ${result.sid}, but test bookkeeping failed; reconcile before retrying`);
    // A receipt can arrive before the provider response is recorded. Never replace it with "queued".
    const { error: receiptError } = await supabase.from(OPERATOR_TEST_TABLE).update({ delivery_status: result.status })
      .eq("id", id).is("delivery_status", null);
    if (receiptError) throw new Error(`Twilio accepted ${result.sid}, but status bookkeeping failed; reconcile before retrying`);
    audit.end("pass");
    const { data: row } = await supabase.from(OPERATOR_TEST_TABLE).select(RECEIPT_COLUMNS).eq("id", id).maybeSingle();
    return row ? present(row as OperatorTestRow)
      : { message_id: id, twilio_sid: result.sid, delivery_status: result.status, status: "sent" };
  } catch (error) {
    audit.end("error", { error: String(error) });
    await supabase.from(OPERATOR_TEST_TABLE).update({
      status: "failed", error_message: String(error), ...(accepted ? { twilio_message_sid: accepted } : {}),
    }).eq("id", id);
    throw error;
  }
}

export async function getOperatorTestMessages(clubId: string) {
  const { data, error } = await supabase.from(OPERATOR_TEST_TABLE).select(RECEIPT_COLUMNS)
    .eq("club_id", clubId).order("created_at", { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  return ((data ?? []) as OperatorTestRow[]).map(present);
}

/**
 * Persist a signed Twilio status callback for an operator test. The callback
 * may beat SID persistence, so bind the SID only while unset and never move a
 * receipt onto a different SID. Returns whether a test row matched.
 */
export async function recordOperatorTestReceipt(
  id: string, sid: string, status: string, errorCode?: string, errorMessage?: string,
): Promise<{ matched: boolean; error: { message: string } | null }> {
  const update: Record<string, unknown> = { delivery_status: status };
  if (status === "delivered") update.delivered_at = new Date().toISOString();
  else if (status === "failed" || status === "undelivered") {
    update.status = "failed";
    if (errorCode) update.error_code = errorCode;
    if (errorMessage) update.error_message = errorMessage;
  }
  const bound = await supabase.from(OPERATOR_TEST_TABLE).update(update)
    .eq("id", id).eq("twilio_message_sid", sid).select("id");
  if (bound.error) return { matched: false, error: bound.error };
  if (bound.data?.length) return { matched: true, error: null };
  const early = await supabase.from(OPERATOR_TEST_TABLE).update({ ...update, twilio_message_sid: sid })
    .eq("id", id).is("twilio_message_sid", null).select("id");
  if (early.error) return { matched: false, error: early.error };
  return { matched: !!early.data?.length, error: null };
}
