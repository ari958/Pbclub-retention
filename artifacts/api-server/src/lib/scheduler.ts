import { createClient } from "@supabase/supabase-js";
// @ts-ignore — plain JS module
import { importAllPlayers } from "../importAllPlayers.js";
// @ts-ignore — plain JS module
import { syncEventAttendance } from "../syncEventAttendance.js";
import { getJob, startJob, finishJob, appendJobLog, isCancelled } from "./jobStore";
import { logger } from "./logger";

const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const JOB_NIGHTLY        = "nightly_sync";
const JOB_IMPORT         = "import_players";
const JOB_EVENTS         = "sync_events";
const INCREMENTAL_DAYS   = 14;

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );
}

async function getClubSchedule(): Promise<{ scheduledTime: string; timezone: string } | null> {
  try {
    const { data, error } = await getSupabase()
      .from("clubs")
      .select("scheduled_sync_time, timezone")
      .eq("id", CLUB_ID)
      .maybeSingle();
    if (error || !data?.scheduled_sync_time) return null;
    return {
      scheduledTime: data.scheduled_sync_time as string,
      timezone: (data.timezone as string) ?? "America/New_York",
    };
  } catch {
    return null;
  }
}

function isTimeToRun(scheduledTime: string, timezone: string): boolean {
  const [h, m] = scheduledTime.split(":").map(Number);
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const nowH = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const nowM = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return nowH === h && nowM === m;
}

export async function runNightlyChain(): Promise<void> {
  logger.info("[scheduler] Starting nightly chain");
  await startJob(JOB_NIGHTLY);
  await appendJobLog(JOB_NIGHTLY, "Nightly chain started");

  try {
    // Step 1: Player import
    await startJob(JOB_IMPORT);
    await appendJobLog(JOB_IMPORT, "Nightly: player import started");
    try {
      const importStats: Record<string, number> = await importAllPlayers(
        (msg: string) => appendJobLog(JOB_IMPORT, msg),
        () => isCancelled(JOB_IMPORT),
        true  // skipAttendanceSync — nightly chain handles this in step 2
      );
      await finishJob(JOB_IMPORT, "done", importStats);
      await appendJobLog(JOB_IMPORT, "Nightly: player import finished");
    } catch (err: any) {
      const wasCancelled = err.name === "CancelledError";
      await finishJob(JOB_IMPORT, wasCancelled ? "cancelled" : "error", undefined, err.message);
      await appendJobLog(JOB_IMPORT, `Nightly: player import ${wasCancelled ? "cancelled" : "failed"}: ${err.message}`);
      throw err;
    }

    // Step 2: Incremental event sync (last 14 days)
    await startJob(JOB_EVENTS);
    await appendJobLog(JOB_EVENTS, `Nightly: incremental event sync (last ${INCREMENTAL_DAYS} days)`);
    try {
      const syncStats: Record<string, number> = await syncEventAttendance(
        (msg: string) => appendJobLog(JOB_EVENTS, msg),
        () => isCancelled(JOB_EVENTS),
        INCREMENTAL_DAYS
      );
      const cancelled = await isCancelled(JOB_EVENTS);
      await finishJob(JOB_EVENTS, cancelled ? "cancelled" : "done", syncStats);
      await appendJobLog(JOB_EVENTS, `Nightly: event sync ${cancelled ? "cancelled" : "finished"}`);
      if (cancelled) {
        throw Object.assign(new Error("Event sync cancelled by operator"), { name: "CancelledError" });
      }
    } catch (err: any) {
      const wasCancelled = err.name === "CancelledError";
      if (!wasCancelled) {
        await finishJob(JOB_EVENTS, "error", undefined, err.message);
        await appendJobLog(JOB_EVENTS, `Nightly: event sync failed: ${err.message}`);
      }
      throw err;
    }

    // Step 3: Mark nightly_sync done
    await finishJob(JOB_NIGHTLY, "done");
    await appendJobLog(JOB_NIGHTLY, "Nightly chain completed successfully");
    logger.info("[scheduler] Nightly chain completed");
  } catch (err: any) {
    const wasCancelled = err.name === "CancelledError";
    await finishJob(JOB_NIGHTLY, wasCancelled ? "cancelled" : "error", undefined, err.message);
    await appendJobLog(JOB_NIGHTLY, `Nightly chain ${wasCancelled ? "cancelled" : "failed"}: ${err.message}`);
    logger.error({ err }, "[scheduler] Nightly chain ended with error");
  }
}

export function startScheduler(): void {
  logger.info("[scheduler] Scheduler started — checking every 60s");

  setInterval(async () => {
    try {
      const schedule = await getClubSchedule();
      if (!schedule) return;

      if (!isTimeToRun(schedule.scheduledTime, schedule.timezone)) return;

      const nightlyJob = await getJob(JOB_NIGHTLY);
      if (nightlyJob.status === "running") {
        logger.info("[scheduler] Nightly job already running — skipping tick");
        return;
      }

      logger.info(
        { scheduledTime: schedule.scheduledTime, timezone: schedule.timezone },
        "[scheduler] Time matched — triggering nightly chain"
      );

      runNightlyChain().catch((err) => {
        logger.error({ err }, "[scheduler] Uncaught error in nightly chain");
      });
    } catch (err) {
      logger.error({ err }, "[scheduler] Tick error — will retry next interval");
    }
  }, 60_000);
}
