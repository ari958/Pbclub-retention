import { Router, type IRouter } from "express";
// @ts-ignore — plain JS module
import { dedupeAttendances } from "../dedupeAttendances.js";

const router: IRouter = Router();

// ─── Job state ────────────────────────────────────────────────────────────────

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
  if (jobLogs.length > 2000) jobLogs.splice(0, jobLogs.length - 2000);
  console.log(line);
}

/**
 * POST /api/admin/dedupe-attendances
 *
 * One-time script to remove duplicate attendance rows where
 * (player_id, program_name, attended_at) is the same but id differs.
 * Keeps the first id in each group, deletes the rest in batches of 500.
 *
 * Requires DELETE permission on the attendances table:
 *   GRANT DELETE ON attendances TO anon, authenticated;
 *
 * Returns 202 immediately — poll GET /api/admin/dedupe-attendances/status.
 */
router.post("/admin/dedupe-attendances", (_req, res) => {
  if (jobStatus === "running") {
    res.status(409).json({
      error: "Dedupe already running.",
      startedAt: jobStartedAt,
      recentLogs: jobLogs.slice(-10),
    });
    return;
  }

  jobStatus = "running";
  jobStartedAt = new Date().toISOString();
  jobFinishedAt = null;
  jobStats = null;
  jobError = null;
  jobLogs.length = 0;

  appendLog("Dedupe triggered via POST /api/admin/dedupe-attendances");

  res.status(202).json({
    status: "started",
    message: "Deduplication running in background. Poll GET /api/admin/dedupe-attendances/status for progress.",
    startedAt: jobStartedAt,
  });

  dedupeAttendances(appendLog)
    .then((stats: Record<string, number>) => {
      jobStats = stats;
      jobStatus = "done";
      jobFinishedAt = new Date().toISOString();
      appendLog(`Dedupe finished — ${stats.deleted} rows deleted, ${stats.errors} batch errors`);
    })
    .catch((err: Error) => {
      jobError = err.message;
      jobStatus = "error";
      jobFinishedAt = new Date().toISOString();
      appendLog(`Dedupe failed: ${err.message}`);
    });
});

/**
 * GET /api/admin/dedupe-attendances/status
 * Returns current job state, stats, and recent log lines.
 */
router.get("/admin/dedupe-attendances/status", (_req, res) => {
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
