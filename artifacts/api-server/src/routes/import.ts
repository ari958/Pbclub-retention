import { Router, type IRouter } from "express";
import { createClient } from "@supabase/supabase-js";
// @ts-ignore — plain JS module
import { importAllPlayers } from "../importAllPlayers.js";

const router: IRouter = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// In-memory job state (single-server, single job at a time)
type JobStatus = "idle" | "running" | "done" | "error";
let jobStatus: JobStatus = "idle";
let jobStartedAt: string | null = null;
let jobFinishedAt: string | null = null;
let jobStats: Record<string, number> | null = null;
let jobError: string | null = null;
const jobLogs: string[] = [];

function appendLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  jobLogs.push(line);
  // Keep last 2000 log lines to avoid unbounded growth
  if (jobLogs.length > 2000) jobLogs.splice(0, jobLogs.length - 2000);
  console.log(line);
}

/**
 * POST /api/import/players
 *
 * Triggers a full PodPlay → Supabase player import + attendance sync.
 * This is designed to run as a nightly scheduled job; the API endpoint
 * allows manual triggering via Hoppscotch for testing.
 *
 * Returns 202 immediately — progress is logged to stdout.
 * Poll GET /api/import/status to track progress.
 */
router.post("/import/players", async (req, res) => {
  if (jobStatus === "running") {
    res.status(409).json({
      error: "Import already running",
      startedAt: jobStartedAt,
      logs: jobLogs.slice(-20),
    });
    return;
  }

  // Read club's scheduled sync context for logging
  const { data: club } = await supabase
    .from("clubs")
    .select("name, scheduled_sync_time, timezone")
    .limit(1)
    .maybeSingle();

  jobStatus = "running";
  jobStartedAt = new Date().toISOString();
  jobFinishedAt = null;
  jobStats = null;
  jobError = null;
  jobLogs.length = 0;

  appendLog(`Import triggered manually via POST /api/import/players`);
  if (club?.scheduled_sync_time) {
    appendLog(`Club ${club.name} — nightly schedule: ${club.scheduled_sync_time} ${club.timezone ?? "UTC"}`);
  }

  // Return immediately — run in background
  res.status(202).json({
    status: "started",
    message: "Import running in background. Poll GET /api/import/status for progress.",
    startedAt: jobStartedAt,
  });

  // Run the import asynchronously
  importAllPlayers(appendLog)
    .then((stats: Record<string, number>) => {
      jobStats = stats;
      jobStatus = "done";
      jobFinishedAt = new Date().toISOString();
      appendLog(`Import finished successfully`);
    })
    .catch((err: Error) => {
      jobError = err.message;
      jobStatus = "error";
      jobFinishedAt = new Date().toISOString();
      appendLog(`Import failed: ${err.message}`);
    });
});

/**
 * GET /api/import/status
 * Returns the current import job status and recent logs.
 */
router.get("/import/status", (_req, res) => {
  res.json({
    status: jobStatus,
    startedAt: jobStartedAt,
    finishedAt: jobFinishedAt,
    stats: jobStats,
    error: jobError,
    recentLogs: jobLogs.slice(-50),
  });
});

export default router;
