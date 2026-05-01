import { Router, type IRouter } from "express";
// @ts-ignore — plain JS module
import { importAllPlayers } from "../importAllPlayers.js";
// @ts-ignore — plain JS module
import { importPhoneNumbers } from "../importPhoneNumbers.js";
import { getJob, startJob, finishJob, appendJobLog, isCancelled, requestCancel } from "../lib/jobStore";
import { supabase } from "../lib/supabaseClient";

const router: IRouter = Router();

const JOB_IMPORT_PLAYERS = "import_players";
const JOB_IMPORT_PHONES  = "import_phones";

// ─── Player import ────────────────────────────────────────────────────────────

router.post("/import/players", async (req, res) => {
  const current = await getJob(JOB_IMPORT_PLAYERS);

  if (current.status === "running") {
    res.status(409).json({
      error: "Import already running. POST /api/import/cancel to stop it first.",
      startedAt: current.started_at,
      recentLogs: current.logs.slice(-10),
    });
    return;
  }

  // Read club info for logging
  let club: { name?: string; scheduled_sync_time?: string; timezone?: string } | null = null;
  try {
    const { data } = await supabase
      .from("clubs")
      .select("name, scheduled_sync_time, timezone")
      .limit(1)
      .maybeSingle();
    club = data;
  } catch { /* non-fatal */ }

  await startJob(JOB_IMPORT_PLAYERS);
  await appendJobLog(JOB_IMPORT_PLAYERS, "Import triggered via POST /api/import/players");

  if (club?.scheduled_sync_time) {
    await appendJobLog(JOB_IMPORT_PLAYERS, `Club: ${club.name} | Nightly schedule: ${club.scheduled_sync_time} ${club.timezone ?? "UTC"}`);
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    await appendJobLog(JOB_IMPORT_PLAYERS, "WARNING: SUPABASE_SERVICE_ROLE_KEY not set — inserts may fail due to RLS");
  }

  res.status(202).json({
    status: "started",
    message: "Import running in background. Poll GET /api/import/status for progress.",
    startedAt: new Date().toISOString(),
  });

  importAllPlayers(
    (msg: string) => appendJobLog(JOB_IMPORT_PLAYERS, msg),
    () => isCancelled(JOB_IMPORT_PLAYERS)
  )
    .then(async (stats: Record<string, number>) => {
      await finishJob(JOB_IMPORT_PLAYERS, "done", stats);
      await appendJobLog(JOB_IMPORT_PLAYERS, "Import finished successfully");
    })
    .catch(async (err: Error) => {
      if (err.name === "CancelledError") {
        await finishJob(JOB_IMPORT_PLAYERS, "cancelled");
        await appendJobLog(JOB_IMPORT_PLAYERS, "Import cancelled — safe to restart");
      } else {
        await finishJob(JOB_IMPORT_PLAYERS, "error", undefined, err.message);
        await appendJobLog(JOB_IMPORT_PLAYERS, `Import failed: ${err.message}`);
      }
    });
});

router.post("/import/cancel", async (_req, res) => {
  const current = await getJob(JOB_IMPORT_PLAYERS);

  if (current.status !== "running") {
    res.status(400).json({
      error: `No import currently running (status: ${current.status})`,
      status: current.status,
    });
    return;
  }

  await requestCancel(JOB_IMPORT_PLAYERS);
  await appendJobLog(JOB_IMPORT_PLAYERS, "Cancellation requested — stopping after current player…");

  res.json({
    status: "cancelling",
    message: "Import will stop after the current player. Poll GET /api/import/status to confirm.",
  });
});

router.get("/import/status", async (_req, res) => {
  const job = await getJob(JOB_IMPORT_PLAYERS);
  res.json({
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    stats: job.stats,
    error: job.error,
    recentLogs: job.logs.slice(-50),
  });
});

// ─── Phone number import ──────────────────────────────────────────────────────

router.post("/import/phone-numbers", async (_req, res) => {
  const current = await getJob(JOB_IMPORT_PHONES);

  if (current.status === "running") {
    res.status(409).json({
      error: "Phone import already running. POST /api/import/phone-numbers/cancel to stop it first.",
      startedAt: current.started_at,
      recentLogs: current.logs.slice(-10),
    });
    return;
  }

  await startJob(JOB_IMPORT_PHONES);
  await appendJobLog(JOB_IMPORT_PHONES, "Phone import triggered via POST /api/import/phone-numbers");

  res.status(202).json({
    status: "started",
    message: "Phone import running in background. Poll GET /api/import/phone-numbers/status for progress.",
    startedAt: new Date().toISOString(),
  });

  importPhoneNumbers(
    (msg: string) => appendJobLog(JOB_IMPORT_PHONES, msg),
    () => isCancelled(JOB_IMPORT_PHONES)
  )
    .then(async (stats: Record<string, number>) => {
      await finishJob(JOB_IMPORT_PHONES, "done", stats);
      await appendJobLog(JOB_IMPORT_PHONES, "Phone import finished successfully");
    })
    .catch(async (err: Error) => {
      if (err.name === "CancelledError") {
        await finishJob(JOB_IMPORT_PHONES, "cancelled");
        await appendJobLog(JOB_IMPORT_PHONES, "Phone import cancelled — safe to restart");
      } else {
        await finishJob(JOB_IMPORT_PHONES, "error", undefined, err.message);
        await appendJobLog(JOB_IMPORT_PHONES, `Phone import failed: ${err.message}`);
      }
    });
});

router.get("/import/phone-numbers/status", async (_req, res) => {
  const job = await getJob(JOB_IMPORT_PHONES);
  res.json({
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    stats: job.stats,
    error: job.error,
    recentLogs: job.logs.slice(-50),
  });
});

router.post("/import/phone-numbers/cancel", async (_req, res) => {
  const current = await getJob(JOB_IMPORT_PHONES);
  if (current.status !== "running") {
    res.status(400).json({
      error: `No phone import currently running (status: ${current.status})`,
    });
    return;
  }
  await requestCancel(JOB_IMPORT_PHONES);
  await appendJobLog(JOB_IMPORT_PHONES, "Cancellation requested — stopping after current player…");
  res.json({
    status: "cancelling",
    message: "Phone import will stop after the current player. Poll GET /api/import/phone-numbers/status to confirm.",
  });
});

export default router;
