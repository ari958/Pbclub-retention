import { supabase } from "./supabaseClient";
import { alertOperator } from "./operatorMonitoring";
import { backgroundJobsEnabled } from "./backgroundPolicy";
import { logger } from "./logger";

/** Unique message_id preserves the first callback time across provider retries. */
export async function recordCarrierOptOutEvent(playerId: string, messageId: string, occurredAt: string) {
  const player = await supabase.from("players").select("club_id").eq("id", playerId).maybeSingle();
  if (player.error || !player.data?.club_id) throw new Error("Opt-out event player unavailable");
  const inserted = await supabase.from("sms_optout_events").upsert({
    club_id: player.data.club_id, player_id: playerId, message_id: messageId,
    occurred_at: occurredAt, source: "carrier_21610",
  }, { onConflict: "message_id", ignoreDuplicates: true });
  if (inserted.error) throw new Error("Cannot record carrier opt-out; install migration 022");
  const event = await supabase.from("sms_optout_events").select("id")
    .eq("message_id", messageId).maybeSingle();
  if (event.error || !event.data?.id) throw new Error("Recorded carrier opt-out unavailable");
  return String(event.data.id);
}

/** No test/dev transport, and no alerts for historical backfills, even on replay. */
export async function alertOptOutEvent(eventId: string) {
  const event = await supabase.from("sms_optout_events").select("alerted_at,is_backfill").eq("id", eventId).maybeSingle();
  if (event.error || !event.data) throw new Error("Opt-out alert event unavailable");
  if (event.data.alerted_at || event.data.is_backfill || !backgroundJobsEnabled()) return;
  const context = await supabase.from("sms_optouts")
    .select("name,event_source,playbook_key,step,body").eq("id", eventId).maybeSingle();
  if (context.error || !context.data) throw new Error("Opt-out alert context unavailable");
  const row = context.data;
  const key = `sms-optout:${eventId}`;
  const accepted = await alertOperator(key,
    `Opt-out: ${row.name}. Source: ${row.event_source}. Flow: ${row.playbook_key ?? "unattributed"}. `
    + `Step: ${row.step ?? "unattributed"}. Preceding text: ${row.body ?? "(no preceding outbound text)"}`);
  if (!accepted) throw new Error("Opt-out alert could not be accepted");
  // A deduplicated claim can also mean a previous ambiguous provider outcome.
  // Only provider-acceptance evidence allows us to mark this event alerted.
  const incident = await supabase.from("operator_alert_incidents").select("incident_id")
    .eq("condition_key", key).maybeSingle();
  if (incident.error || !incident.data) throw new Error("Opt-out alert incident unavailable");
  const delivery = await supabase.from("operator_alert_events").select("id")
    .eq("incident_id", incident.data.incident_id).eq("phase", "alert").eq("status", "sent").maybeSingle();
  if (delivery.error || !delivery.data) throw new Error("Opt-out alert requires reconciliation; no automatic resend");
  const saved = await supabase.from("sms_optout_events").update({ alerted_at: new Date().toISOString() })
    .eq("id", eventId).is("alerted_at", null);
  if (saved.error) throw new Error("Cannot acknowledge opt-out alert");
}

/** API replicas may not hold the worker lease; the elected watchdog drains
 * unalerted live events after a crash or a callback on a non-leader replica. */
export async function alertPendingOptOutEvents() {
  if (!backgroundJobsEnabled()) return;
  const pending = await supabase.from("sms_optout_events").select("id")
    .eq("is_backfill", false).is("alerted_at", null).order("created_at").limit(100);
  if (pending.error) throw new Error("Cannot inspect pending opt-out alerts; install migration 022");
  for (const event of pending.data ?? []) {
    try { await alertOptOutEvent(event.id); }
    catch (error) {
      logger.error({ event_id: event.id, reason: error instanceof Error ? error.message : "Alert unavailable" },
        "Opt-out operator alert remains pending; reserved claims must be reconciled, not resent");
    }
  }
}
