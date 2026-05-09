// @ts-ignore — plain JS module
import { importAllPlayers } from "../importAllPlayers.js";
// @ts-ignore — plain JS module
import { syncEventAttendance } from "../syncEventAttendance.js";
import { getJob, startJob, finishJob, appendJobLog, isCancelled } from "./jobStore";
import { computeLevelConfidence } from "./levelConfidence";
import { sendFeedbackForRecentEvents } from "./postSessionFeedback";
import { computeBuddyPairs } from "./socialGraph";
import { runChurnScoreBatch } from "./churnScore";
import { runMilestoneBatch } from "./milestoneCheck";
import { runMonthlyRecapBatch } from "./monthlyRecap";
import { logger } from "./logger";
import { supabase } from "./supabaseClient";

const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const JOB_NIGHTLY             = "nightly_sync";
const JOB_IMPORT              = "import_players";
const JOB_EVENTS              = "sync_events";
const JOB_CONFIDENCE_NIGHTLY  = "confidence_nightly";
const INCREMENTAL_DAYS        = 14;

async function getClubSchedule(): Promise<{ scheduledTime: string; timezone: string } | null> {
  try {
    const { data, error } = await supabase
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

    // Step 3: Incremental confidence recompute for players with recent tagged sessions
    await startJob(JOB_CONFIDENCE_NIGHTLY);
    await appendJobLog(JOB_CONFIDENCE_NIGHTLY, `Confidence nightly started — window: last ${INCREMENTAL_DAYS} days`);
    try {
      const cutoff = new Date(Date.now() - INCREMENTAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentRows, error: recentErr } = await supabase
        .from("attendances")
        .select("player_id")
        .gte("attended_at", cutoff)
        .not("player_id", "is", null)
        .not("level", "is", null);         // only players with level-tagged records

      if (recentErr) throw new Error(recentErr.message);

      const recentPlayerIds = [...new Set((recentRows ?? []).map((r: any) => r.player_id as string))];
      await appendJobLog(JOB_CONFIDENCE_NIGHTLY, `Recomputing confidence for ${recentPlayerIds.length} players`);

      for (const pid of recentPlayerIds) {
        await computeLevelConfidence(pid);
      }

      await finishJob(JOB_CONFIDENCE_NIGHTLY, "done", { players_computed: recentPlayerIds.length });
      await appendJobLog(JOB_CONFIDENCE_NIGHTLY, `Recomputed confidence for ${recentPlayerIds.length} players`);
      await appendJobLog(JOB_NIGHTLY, `Step 3 complete — confidence recomputed for ${recentPlayerIds.length} players`);
    } catch (err: any) {
      await finishJob(JOB_CONFIDENCE_NIGHTLY, "error", undefined, err.message);
      await appendJobLog(JOB_NIGHTLY, `Confidence recompute error (non-fatal): ${err.message}`);
    }

    // Step 4: Buddy pair graph (non-fatal)
    try {
      await appendJobLog(JOB_NIGHTLY, "Step 4: updating buddy pair graph");
      const result = await computeBuddyPairs();
      const statsLine = Object.entries(result.stats).map(([k, v]) => `${k}: ${v}`).join(", ");
      await appendJobLog(JOB_NIGHTLY, `Step 4 complete — ${statsLine}`);
      if (result.errors?.length) {
        await appendJobLog(JOB_NIGHTLY, `Step 4 had ${result.errors.length} non-fatal errors`);
      }
    } catch (err: any) {
      await appendJobLog(JOB_NIGHTLY, `Buddy pair update error (non-fatal): ${err.message}`);
    }

    // Step 5: Churn score recompute (non-fatal, awaited directly)
    //
    // Behavior change from previous fetch-localhost pattern: this now blocks
    // until the entire batch finishes before Step 6 starts. Previously the
    // fetch returned 202 immediately and Step 6 ran concurrently against
    // stale churn scores. Total nightly chain runtime grows by ~6 minutes
    // (typical churn batch duration) but Step 6 (milestones) now runs
    // against fresh churn data — correctness win.
    try {
      await appendJobLog(JOB_NIGHTLY, "Step 5: recomputing churn scores");
      const result = await runChurnScoreBatch();
      const statsLine = Object.entries(result.stats).map(([k, v]) => `${k}: ${v}`).join(", ");
      await appendJobLog(JOB_NIGHTLY, `Step 5 complete — ${statsLine}`);
      if (result.errors?.length) {
        await appendJobLog(JOB_NIGHTLY, `Step 5 had ${result.errors.length} non-fatal errors`);
      }
    } catch (err: any) {
      await appendJobLog(JOB_NIGHTLY, `Churn score recompute error (non-fatal): ${err.message}`);
    }

    // Step 6: Milestone check (non-fatal)
    try {
      await appendJobLog(JOB_NIGHTLY, "Step 6: checking player milestones");
      const result = await runMilestoneBatch();
      const statsLine = Object.entries(result.stats).map(([k, v]) => `${k}: ${v}`).join(", ");
      await appendJobLog(JOB_NIGHTLY, `Step 6 complete — ${statsLine}`);
      if (result.errors?.length) {
        await appendJobLog(JOB_NIGHTLY, `Step 6 had ${result.errors.length} non-fatal errors`);
      }
    } catch (err: any) {
      await appendJobLog(JOB_NIGHTLY, `Milestone check error (non-fatal): ${err.message}`);
    }

    // Step 7: Monthly recap — only on 1st of month (non-fatal)
    try {
      const now = new Date();
      if (now.getDate() === 1) {
        const priorMonth = now.getMonth() === 0 ? 12 : now.getMonth();
        const priorYear  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
        await appendJobLog(JOB_NIGHTLY, `Step 7: generating monthly recaps for ${priorYear}-${priorMonth}`);
        const result = await runMonthlyRecapBatch(priorMonth, priorYear);
        const statsLine = Object.entries(result.stats).map(([k, v]) => `${k}: ${v}`).join(", ");
        await appendJobLog(JOB_NIGHTLY, `Step 7 complete — ${statsLine}`);
        if (result.errors?.length) {
          await appendJobLog(JOB_NIGHTLY, `Step 7 had ${result.errors.length} non-fatal errors`);
        }
      } else {
        await appendJobLog(JOB_NIGHTLY, "Step 7: monthly recap skipped (not 1st of month)");
      }
    } catch (err: any) {
      await appendJobLog(JOB_NIGHTLY, `Monthly recap error (non-fatal): ${err.message}`);
    }

    // Mark nightly_sync done
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

  // Feedback poller — runs every 30 minutes, independent of nightly chain
  setInterval(async () => {
    try {
      const fbLog = (msg: string) => logger.info(msg);
      const result = await sendFeedbackForRecentEvents(fbLog, 0.5);
      // windowHours = 0.5 = look back 30 minutes only
      if (result.eventsFound > 0) {
        logger.info(result, "[feedback-poller] Feedback texts triggered");
      }
    } catch (err) {
      logger.error({ err }, "[feedback-poller] Error — will retry next interval");
    }
  }, 30 * 60 * 1000); // every 30 minutes

  logger.info("[scheduler] Feedback poller started — checking every 30 minutes");

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
