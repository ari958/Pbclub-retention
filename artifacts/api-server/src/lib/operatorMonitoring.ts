import twilio from "twilio";
import { createHash } from "node:crypto";
import { supabase } from "./supabaseClient";
import { logger } from "./logger";
import { backgroundJobsEnabled } from "./backgroundPolicy";
import { withBackgroundLock } from "./backgroundLock";
import { getDefaultClubSlug } from "./clubResolver";

const startedAt = Date.now();
const recentAlerts = new Map<string, number>();
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
  if (!backgroundJobsEnabled()) return;
  const dedupeKey = `alert:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  if (Date.now() - (recentAlerts.get(dedupeKey) ?? 0) < 60 * 60 * 1000) return;
  try {
    await withBackgroundLock(dedupeKey, async () => {
      const { data, error } = await supabase.from("operator_runtime").select("updated_at").eq("name", dedupeKey).maybeSingle();
      if (error) throw error;
      if (data && Date.now() - Date.parse(data.updated_at) < 60 * 60 * 1000) return;
      const to = process.env.ALERT_OPERATOR_TO;
      const from = process.env.TWILIO_PHONE_NUMBER;
      if (!to || !/^\+[1-9]\d{7,14}$/.test(to) || !from) {
        throw new Error("ALERT_OPERATOR_TO and TWILIO_PHONE_NUMBER are required for operator alerts");
      }
      const body = `PB Club operator alert: ${text}`.slice(0, 1000);
      if (alertTransportForTests) await alertTransportForTests(to, from, body);
      else await twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!).messages.create({ to, from, body });
      await recordRuntime(dedupeKey, "sent");
      recentAlerts.set(dedupeKey, Date.now());
    });
  } catch (error) {
    logger.error({ err: error, alert: key }, "Operator alert failed");
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
      reasons.push({ key: `nightly:${health.last_nightly_sync.at}`, text: "Nightly sync failed or was cancelled. Check job logs." });
    }
    if (health.schedule?.time) {
      const timezone = health.schedule.timezone;
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
      const value = (type: string) => parts.find((p) => p.type === type)!.value;
      const [hour, minute] = health.schedule.time.split(":").map(Number);
      const nowMinutes = Number(value("hour")) * 60 + Number(value("minute"));
      const today = `${value("year")}-${value("month")}-${value("day")}`;
      const elapsedMinutes = (nowMinutes - hour * 60 - minute + 1440) % 1440;
      const scheduledAt = Math.floor(now / 60_000) * 60_000 - elapsedMinutes * 60_000;
      const lastAt = health.schedule.last_started_at ?? health.last_nightly_sync.at;
      if (elapsedMinutes >= 60 && (!lastAt || Date.parse(lastAt) < scheduledAt)) {
        reasons.push({ key: `nightly_missing:${today}`, text: "Nightly sync has not run within one hour of its scheduled time." });
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
    for (const reason of operatorAlertReasons(health)) await alertOperator(reason.key, reason.text);
    // Also detects kill-switch changes made outside this API.
    const { data: previous, error } = await supabase.from("operator_runtime").select("result,updated_at").eq("name", "kill-switch").maybeSingle();
    if (error) throw error;
    if (health.paused !== null) {
      const state = health.paused ? "paused" : "resumed";
      if (previous && previous.result !== state) await alertOperator(`kill_switch:${state}:${previous.updated_at ?? ""}`, `SMS kill switch changed: ${state}.`);
      await recordRuntime("kill-switch", state);
    }
  });
}

export function startOperatorWatchdog() {
  if (!backgroundJobsEnabled()) return;
  setInterval(() => void runOperatorWatchdog().catch((err) => logger.error({ err }, "Operator watchdog failed")), 60_000);
}
