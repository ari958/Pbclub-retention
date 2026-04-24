import { Router, type IRouter } from "express";
import { createClient } from "@supabase/supabase-js";
// @ts-ignore — plain JS module
import { importAllPlayers } from "../importAllPlayers.js";

const router: IRouter = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// ─── Job state ────────────────────────────────────────────────────────────────

type JobStatus = "idle" | "running" | "cancelled" | "done" | "error";

let jobStatus: JobStatus = "idle";
let jobStartedAt: string | null = null;
let jobFinishedAt: string | null = null;
let jobStats: Record<string, number> | null = null;
let jobError: string | null = null;
let jobCancelled = false;
const jobLogs: string[] = [];

function appendLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  jobLogs.push(line);
  if (jobLogs.length > 2000) jobLogs.splice(0, jobLogs.length - 2000);
  console.log(line);
}

function resetJob() {
  jobStatus = "running";
  jobStartedAt = new Date().toISOString();
  jobFinishedAt = null;
  jobStats = null;
  jobError = null;
  jobCancelled = false;
  jobLogs.length = 0;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/import/players
 *
 * Triggers a full PodPlay → Supabase player import + attendance sync.
 * Designed to run nightly; manually triggerable via Hoppscotch for testing.
 * Returns 202 immediately — poll GET /api/import/status for progress.
 * Use POST /api/import/cancel to stop a running job and restart fresh.
 */
router.post("/import/players", async (req, res) => {
  if (jobStatus === "running") {
    res.status(409).json({
      error: "Import already running. POST /api/import/cancel to stop it first.",
      startedAt: jobStartedAt,
      recentLogs: jobLogs.slice(-10),
    });
    return;
  }

  // Read club schedule context for logging
  let club: { name?: string; scheduled_sync_time?: string; timezone?: string } | null = null;
  try {
    const { data } = await supabase
      .from("clubs")
      .select("name, scheduled_sync_time, timezone")
      .limit(1)
      .maybeSingle();
    club = data;
  } catch {
    // non-fatal — schedule columns may not exist yet
  }

  resetJob();

  appendLog("Import triggered via POST /api/import/players");
  if (club?.scheduled_sync_time) {
    appendLog(`Club: ${club.name} | Nightly schedule: ${club.scheduled_sync_time} ${club.timezone ?? "UTC"}`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    appendLog("WARNING: SUPABASE_SERVICE_ROLE_KEY not set — inserts may fail due to RLS");
  }

  res.status(202).json({
    status: "started",
    message: "Import running in background. Poll GET /api/import/status for progress.",
    startedAt: jobStartedAt,
  });

  importAllPlayers(appendLog, () => jobCancelled)
    .then((stats: Record<string, number>) => {
      jobStats = stats;
      jobStatus = "done";
      jobFinishedAt = new Date().toISOString();
      appendLog("Import finished successfully");
    })
    .catch((err: Error) => {
      jobFinishedAt = new Date().toISOString();
      if (err.name === "CancelledError") {
        jobStatus = "cancelled";
        appendLog("Import cancelled — safe to restart via POST /api/import/players");
      } else {
        jobError = err.message;
        jobStatus = "error";
        appendLog(`Import failed: ${err.message}`);
      }
    });
});

/**
 * POST /api/import/cancel
 *
 * Signals the running import to stop at the next player boundary.
 * The job will finish its current player then exit cleanly.
 * Once status is "cancelled", POST /api/import/players can be called again.
 */
router.post("/import/cancel", (req, res) => {
  if (jobStatus !== "running") {
    res.status(400).json({
      error: `No import currently running (status: ${jobStatus})`,
      status: jobStatus,
    });
    return;
  }

  jobCancelled = true;
  appendLog("Cancellation requested — stopping after current player…");

  res.json({
    status: "cancelling",
    message: "Import will stop after the current player completes. Poll GET /api/import/status to confirm.",
  });
});

/**
 * GET /api/import/status
 * Returns current job state, stats, and recent log lines.
 */
router.get("/import/status", (_req, res) => {
  res.json({
    status: jobStatus,
    startedAt: jobStartedAt,
    finishedAt: jobFinishedAt,
    stats: jobStats,
    error: jobError,
    cancelling: jobStatus === "running" && jobCancelled,
    recentLogs: jobLogs.slice(-50),
  });
});

export default router;
