import twilio from "twilio";
import { supabase } from "./supabaseClient";
import { logger } from "./logger";
import { backgroundJobsEnabled } from "./backgroundPolicy";
import { withBackgroundLock } from "./backgroundLock";
import { getDefaultClubSlug, resolveClubSlug } from "./clubResolver";
import { workerIdentity } from "./workerIdentity";
import { checkNightlyRunAlerts } from "./nightlyRunAlerts";

const startedAt = Date.now();
let alertTransportForTests: ((to: string, from: string, body: string) => Promise<void>) | null = null;
export function setOperatorAlertTransportForTests(transport: typeof alertTransportForTests) {
  if (process.env.NODE_ENV !== "test") throw new Error("Operator alert test transport is test-only");
  alertTransportForTests = transport;
}
export async function recordRuntime(name: string, result: string) {
  const { error } = await supabase.from("operator_runtime").upsert({ name, result, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Runtime telemetry write failed: ${error.message}`);
}

/** Operator-only infrastructure alert; never routes through a player approval or test override. */
export async function alertOperator(key: string, text: string) {
  const source = key.startsWith("nightly:") || key.startsWith("nightly-start:") || key.startsWith("nightly-run-failed:") ? "nightly-chain"
    : key.startsWith("queue-failure:") ? "sms-queue"
    : key.startsWith("send-failed:") || key.startsWith("dispatch-failed:") ? "sms-dispatch" : "watchdog";
  return observeOperatorCondition(key, true, text, source);
}
export async function resolveOperatorAlert(key: string, text: string | null = null) {
  await observeOperatorCondition(key, false, text);
}
export async function observeKillSwitch(clubId: string, source = "api") {
  // The RPC reads the current club state under a row lock.
  await observeOperatorCondition(`kill_switch:${clubId}`, true, null, source);
}
export function operatorConditionKey(key: string) {
  if (key.startsWith("nightly:")) return "nightly_failure";
  if (key.startsWith("nightly-start:")) return "nightly_start_failure";
  if (key.startsWith("nightly_missing:")) return "nightly_missing";
  if (key.startsWith("queue-failure:")) return "queue_failure";
  if (key.startsWith("send-failed:") || key.startsWith("dispatch-failed:")) {
    return `send_failure:${key.slice(key.indexOf(":") + 1)}`;
  }
  return key;
}
export async function observeOperatorCondition(key: string, active: boolean, text: string | null, source = "recovery"): Promise<boolean> {
  if (!backgroundJobsEnabled()) return false;
  const condition = operatorConditionKey(key);
  let claim: any = null;
  let sid: string | null = null;
  try {
    const to = process.env.ALERT_OPERATOR_TO;
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!to || !/^\+[1-9]\d{7,14}$/.test(to) || !from) {
      throw new Error("ALERT_OPERATOR_TO and TWILIO_PHONE_NUMBER are required for operator alerts");
    }
    const observed = await supabase.rpc("operator_observe_alert", {
      p_key: condition, p_active: active, p_text: text, p_holder: { ...workerIdentity, source },
    });
    if (observed.error) throw new Error("Incident claim failed; no alert submitted. Install migration 020.");
    claim = observed.data;
    if (!claim) return true;
    if (!claim.id || !["alert", "resolved"].includes(claim.phase) || typeof claim.text !== "string") {
      throw new Error("Invalid incident claim; no alert submitted");
    }
    const body = `PB Club operator alert: ${claim.phase === "resolved" ? "RESOLVED — " : ""}${claim.text}`.slice(0, 1000);
    logger.info({ event_id: claim.id, incident_id: claim.incident_id, condition, phase: claim.phase, holder: workerIdentity },
      "Operator alert submission claimed");
    if (alertTransportForTests) await alertTransportForTests(to, from, body);
    else sid = (await twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!).messages.create({ to, from, body })).sid;
    const saved = await supabase.from("operator_alert_events").update({
      status: "sent", provider_sid: sid, sent_at: new Date().toISOString(),
    }).eq("id", claim.id);
    if (saved.error) throw new Error("Provider acceptance could not be recorded; reconcile the claimed alert");
    logger.info({ event_id: claim.id, incident_id: claim.incident_id, condition, phase: claim.phase,
      provider_sid: sid, holder: workerIdentity }, "Operator alert submitted");
    return true;
  } catch (error) {
    if (claim?.id) {
      try {
        const failed = await supabase.from("operator_alert_events").update({
          status: "unknown", provider_sid: sid, error: "Submission or acceptance persistence failed; reconcile before any manual retry.",
        }).eq("id", claim.id);
        if (failed.error) logger.error({ event_id: claim.id }, "Could not persist alert reconciliation state; claim remains reserved");
      } catch {
        logger.error({ event_id: claim.id }, "Could not persist alert reconciliation state; claim remains reserved");
      }
    }
    // No phone numbers, credentials, raw provider errors, or automatic retries.
    logger.error({ condition, event_id: claim?.id, provider_sid: sid, holder: workerIdentity,
      reason: error instanceof Error && !claim ? error.message : "Claimed submission requires reconciliation" },
    "Operator alert failed");
    return false;
  }
}

export async function runtimeHealth() {
  const [club, runtime, nightly] = await Promise.all([
    supabase.from("clubs").select("sms_kill_switch,scheduled_sync_time,timezone").eq("slug", getDefaultClubSlug()).maybeSingle(),
    supabase.from("operator_runtime").select("name,updated_at,result").in("name", ["queue", "nightly"]),
    supabase.from("jobs").select("status,started_at,finished_at").eq("id", "nightly_sync").maybeSingle(),
  ]);
  const rows = runtime.data ?? [];
  const queue = rows.find((row: any) => row.name === "queue");
  const sync = rows.find((row: any) => row.name === "nightly");
  return {
    status: club.error || !club.data || runtime.error || nightly.error ? "degraded" : "ok",
    db_reachable: !club.error && !!club.data,
    runtime_schema_ready: !runtime.error,
    background_jobs: backgroundJobsEnabled(),
    last_queue_tick_at: queue?.updated_at ?? null,
    last_nightly_sync: {
      result: nightly.error ? "unknown" : nightly.data?.status ?? sync?.result ?? "never",
      at: nightly.data?.finished_at ?? nightly.data?.started_at ?? sync?.updated_at ?? null,
    },
    sms_live: process.env.SMS_LIVE === "true",
    paused: club.error || !club.data ? null : club.data.sms_kill_switch !== false,
    alerts_configured: !!process.env.ALERT_OPERATOR_TO,
    // Schedule is used internally by the watchdog, not included in public health.
    schedule: club.data ? { time: club.data.scheduled_sync_time, timezone: club.data.timezone || "America/New_York", last_started_at: nightly.data?.started_at ?? null } : null,
  };
}

export function operatorAlertReasons(health: Awaited<ReturnType<typeof runtimeHealth>>, now = Date.now(), workerStartedAt = startedAt) {
    const reasons: Array<{ key: string; text: string }> = [];
    const lastTick = health.last_queue_tick_at ? Date.parse(health.last_queue_tick_at) : workerStartedAt;
    if (now - lastTick >= 15 * 60 * 1000) reasons.push({ key: "queue_stale", text: "No completed queue tick for 15+ minutes. Check the worker." });
    if (health.last_nightly_sync.result === "error" || health.last_nightly_sync.result === "cancelled") {
      reasons.push({ key: "nightly_failure", text: "Nightly sync failed or was cancelled. Check job logs." });
    }
    if (health.schedule?.time) {
      const timezone = health.schedule.timezone;
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
      const value = (type: string) => parts.find((p) => p.type === type)!.value;
      const [hour, minute] = health.schedule.time.split(":").map(Number);
      const nowMinutes = Number(value("hour")) * 60 + Number(value("minute"));
      const elapsedMinutes = (nowMinutes - hour * 60 - minute + 1440) % 1440;
      const scheduledAt = Math.floor(now / 60_000) * 60_000 - elapsedMinutes * 60_000;
      const lastAt = health.schedule.last_started_at ?? health.last_nightly_sync.at;
      if (elapsedMinutes >= 120 && (!lastAt || Date.parse(lastAt) < scheduledAt)) {
         reasons.push({ key: "nightly_missing", text: "Nightly sync has not completed within two hours of its scheduled time." });
      }
    } else if (now - workerStartedAt >= 60 * 60 * 1000) {
      reasons.push({ key: "nightly_schedule_missing", text: "Nightly sync has no configured schedule. Check club settings." });
    }
    return reasons;
}

export async function runOperatorWatchdog() {
  if (!backgroundJobsEnabled()) return;
  await withBackgroundLock("operator-watchdog", async () => {
    const health = await runtimeHealth();
    const reasons = operatorAlertReasons(health);
    // Structured run history owns nightly failures/completion deadlines.
    // Do not submit a second generic alert for the same failed run.
    for (const reason of reasons.filter(item => !["nightly_failure", "nightly_missing"].includes(item.key))) {
      await alertOperator(reason.key, reason.text);
    }
    const clubId = await resolveClubSlug(getDefaultClubSlug());
    await checkNightlyRunAlerts(clubId, health.schedule?.time ?? null,
      health.schedule?.timezone ?? "America/New_York", alertOperator);
    if (health.status === "ok") {
      const active = new Set(reasons.map(reason => reason.key));
      for (const key of ["queue_stale", "nightly_failure", "nightly_missing", "nightly_schedule_missing"]) {
        if (!active.has(key) && (key !== "nightly_failure" || health.last_nightly_sync.result === "done")) {
          await resolveOperatorAlert(key);
        }
      }
      await observeKillSwitch(await resolveClubSlug(getDefaultClubSlug()), "watchdog");
      await resolveDeliveredDispatchAlerts();
      await alertUnmatchedInbound();
      // Lazy import avoids a module-init cycle with the per-event alert helper.
      await (await import("./smsOptouts")).alertPendingOptOutEvents();
    }
    // Also detects kill-switch changes made outside this API.
    if (health.paused !== null) {
      const state = health.paused ? "paused" : "resumed";
      await recordRuntime("kill-switch", state);
    }
  });
}

/** Called by the elected watchdog; tests use a fake provider transport. */
export async function alertUnmatchedInbound() {
  if (!backgroundJobsEnabled()) return;
  const { data, error } = await supabase.from("sms_inbound_receipts")
    .select("id,club_id,match_reason,kind").is("player_id", null)
    .neq("kind", "stop")
    .is("operator_alert_attempted_at", null).order("received_at", { ascending: true }).limit(100);
  if (error) throw new Error("Cannot inspect unmatched inbound inbox; install migration 021");
  for (const receipt of data ?? []) {
    const claimed = await observeOperatorCondition(`unmatched_inbound:${receipt.id}`, true,
      `Unmatched inbound ${receipt.kind === "stop" ? "STOP" : "SMS"} saved for club ${receipt.club_id}. ${receipt.match_reason === "ambiguous" ? "Multiple players share this number." : "Unknown sender."} Review Messages → Replies.`,
      "inbound-inbox");
    if (claimed) {
      const saved = await supabase.from("sms_inbound_receipts").update({ operator_alert_attempted_at: new Date().toISOString() })
        .eq("id", receipt.id);
      if (saved.error) throw new Error("Cannot acknowledge inbound alert attempt");
    }
  }
}

async function resolveDeliveredDispatchAlerts() {
  const { data, error } = await supabase.from("operator_alert_incidents")
    .select("condition_key").eq("active", true).like("condition_key", "send_failure:%");
  if (error) throw new Error("Cannot inspect dispatch incidents");
  for (const incident of data ?? []) {
    const id = incident.condition_key.slice("send_failure:".length);
    const message = await supabase.from("messages").select("delivery_status,delivered_at,twilio_message_sid,simulated")
      .eq("id", id).maybeSingle();
    if (message.error) throw new Error("Cannot inspect dispatch recovery");
    const row = message.data;
    if (row?.simulated === false && /^SM[0-9a-f]{32}$/i.test(row.twilio_message_sid ?? "")
      && (row.delivered_at || row.delivery_status === "delivered")) {
      const ledger = await supabase.from("contact_ledger").select("message_id")
        .eq("message_id", id).eq("is_test", false).limit(1);
      if (ledger.error) throw new Error("Cannot verify live delivery recovery");
      if (ledger.data?.length) {
        await resolveOperatorAlert(incident.condition_key, "Previously failed live SMS delivery is confirmed delivered.");
      }
    }
  }
}

export function startOperatorWatchdog() {
  if (!backgroundJobsEnabled()) return;
  setInterval(() => void runOperatorWatchdog().catch((err) => logger.error({ err }, "Operator watchdog failed")), 60_000);
}
