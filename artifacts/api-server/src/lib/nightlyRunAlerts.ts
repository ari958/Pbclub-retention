import { supabase } from "./supabaseClient";
import { logger } from "./logger";

/** Find today's scheduled instant using the club timezone, including DST.
 * Never use the host's timezone or a fixed UTC offset. */
export function nightlyScheduleWindow(now: Date, time: string, timezone: string) {
  const parts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  const local = parts(now);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(local.year, local.month - 1, local.day, hour, minute);
  let timestamp = desired;
  for (let iteration = 0; iteration < 3; iteration++) {
    const p = parts(new Date(timestamp));
    const displayed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    timestamp += desired - displayed;
  }
  const day = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  return { day, scheduledAt: new Date(timestamp), deadline: new Date(timestamp + 2 * 3600_000) };
}

export async function checkNightlyRunAlerts(
  clubId: string, time: string | null, timezone: string,
  alert: (key: string, text: string) => Promise<unknown>, now = new Date(),
) {
  if (!time) return;
  try {
    const window = nightlyScheduleWindow(now, time, timezone);
    const latest = await supabase.from("nightly_sync_runs").select("id,status,steps")
      .eq("club_id", clubId).order("started_at", { ascending: false }).order("id", { ascending: false })
      .limit(1).maybeSingle();
    if (latest.error) throw latest.error;
    if (latest.data?.status === "failed") {
      const steps = Array.isArray(latest.data.steps) ? latest.data.steps : [];
      const step = [...steps].reverse().find((item: any) => item.status === "failed");
      await alert(`nightly-run-failed:${latest.data.id}`,
        `Nightly sync failed at ${step?.name ?? "startup/finalization"}. Check sync history and job logs.`);
    }
    if (now.getTime() < window.deadline.getTime()) return;
    const completed = await supabase.from("nightly_sync_runs").select("id")
      .eq("club_id", clubId).in("status", ["success", "partial"])
      .gte("finished_at", window.scheduledAt.toISOString())
      .lte("finished_at", window.deadline.toISOString()).limit(1).maybeSingle();
    if (completed.error) throw completed.error;
    if (!completed.data) {
      // This key is deliberately NOT normalized to the old generic condition.
      // The existing atomic operator incident claim prevents repeated submissions
      // across ticks/restarts; the local date permits a new alert tomorrow.
      await alert(`nightly-missed:${clubId}:${window.day}`,
        `Nightly sync for ${window.day} did not complete within two hours of ${time} (${timezone}). Check sync history.`);
    }
  } catch (error) {
    logger.warn({ error }, "Nightly run alert check unavailable; no speculative alert submitted");
  }
}
