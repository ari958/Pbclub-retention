import { Router, type IRouter } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
// @ts-ignore — plain JS module
import { syncSinglePlayer } from "../syncPlayerAttendance.js";
// @ts-ignore — plain JS module
import { syncEventAttendance } from "../syncEventAttendance.js";
import { getJob, startJob, finishJob, appendJobLog, isCancelled, requestCancel } from "../lib/jobStore";
import { runNightlyChain } from "../lib/scheduler";

const router: IRouter = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

const SYNC_TIMEOUT_MS = 30_000;
const STALE_HOURS = 6;

const JOB_SYNC_ALL    = "sync_all";
const JOB_SYNC_EVENTS = "sync_events";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout after ${ms}ms for ${label}`)),
      ms
    );
    promise
      .then((v) => { clearTimeout(timer); resolve(v); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ─── Background sync runner ───────────────────────────────────────────────────

async function runSyncAll() {
  const staleThreshold = new Date(
    Date.now() - STALE_HOURS * 60 * 60 * 1000
  ).toISOString();

  let players: any[] = [];
  let hasLastSyncedAt = true;

  const withCol = await supabase
    .from("players")
    .select("id, external_id, last_synced_at")
    .not("external_id", "is", null);

  if (withCol.error) {
    if (withCol.error.code === "42703" || withCol.error.message?.includes("last_synced_at")) {
      await appendJobLog(JOB_SYNC_ALL, "last_synced_at column missing — syncing all players");
      hasLastSyncedAt = false;
      const fallback = await supabase
        .from("players")
        .select("id, external_id")
        .not("external_id", "is", null);
      if (fallback.error) throw new Error(fallback.error.message);
      players = fallback.data ?? [];
    } else {
      throw new Error(withCol.error.message);
    }
  } else {
    players = withCol.data ?? [];
  }

  const eligible = hasLastSyncedAt
    ? players.filter((p: any) => !p.last_synced_at || new Date(p.last_synced_at) < new Date(staleThreshold))
    : players;

  const skipped = players.length - eligible.length;
  await appendJobLog(JOB_SYNC_ALL, `${players.length} linked players — ${eligible.length} stale, ${skipped} fresh (skipping)`);

  let synced = 0;
  let errors = 0;
  let timeouts = 0;

  for (let i = 0; i < eligible.length; i++) {
    // Check cancellation flag in DB
    if (await isCancelled(JOB_SYNC_ALL)) {
      await appendJobLog(JOB_SYNC_ALL, "Cancelled — stopping after current player");
      throw Object.assign(new Error("Sync cancelled by operator"), { name: "CancelledError" });
    }

    const player = eligible[i];

    try {
      const result = await withTimeout(
        syncSinglePlayer(player.id, player.external_id),
        SYNC_TIMEOUT_MS,
        `player ${player.id}`
      );

      await supabase
        .from("players")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("id", player.id);

      synced++;
      await appendJobLog(JOB_SYNC_ALL, `[${i + 1}/${eligible.length}] OK ${player.id} — inserted=${(result as any).inserted ?? 0}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const isTimeout = message.includes("Timeout");
      if (isTimeout) timeouts++;
      else errors++;
      await appendJobLog(JOB_SYNC_ALL, `[${i + 1}/${eligible.length}] ${isTimeout ? "TIMEOUT" : "ERROR"} ${player.id}: ${message}`);
    }
  }

  return { total: players.length, eligible: eligible.length, synced, skipped, errors, timeouts };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const SyncPlayerSchema = z.object({
  player_id: z.string().min(1, "player_id is required"),
  external_id: z.string().min(1, "external_id is required"),
});

router.post("/sync/player", async (req, res) => {
  const parsed = SyncPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  const { player_id, external_id } = parsed.data;
  try {
    const result = await syncSinglePlayer(player_id, external_id);
    req.log.info({ player_id, external_id, ...result }, "Manual player sync completed");
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err, player_id, external_id }, "Manual player sync failed");
    res.status(500).json({ error: message });
  }
});

router.post("/sync/all", async (_req, res) => {
  const current = await getJob(JOB_SYNC_ALL);

  if (current.status === "running") {
    res.status(409).json({
      error: "Sync already running. POST /api/sync/cancel to stop it first.",
      startedAt: current.started_at,
      recentLogs: current.logs.slice(-10),
    });
    return;
  }

  await startJob(JOB_SYNC_ALL);
  await appendJobLog(JOB_SYNC_ALL, "Triggered via POST /api/sync/all");

  res.status(202).json({
    status: "started",
    message: "Sync running in background. Poll GET /api/sync/status for progress.",
    startedAt: new Date().toISOString(),
  });

  runSyncAll()
    .then(async (stats) => {
      await finishJob(JOB_SYNC_ALL, "done", stats);
      await appendJobLog(JOB_SYNC_ALL, `Done — synced=${stats.synced} skipped=${stats.skipped} errors=${stats.errors} timeouts=${stats.timeouts}`);
    })
    .catch(async (err: Error) => {
      if (err.name === "CancelledError") {
        await finishJob(JOB_SYNC_ALL, "cancelled");
        await appendJobLog(JOB_SYNC_ALL, "Cancelled — safe to restart");
      } else {
        await finishJob(JOB_SYNC_ALL, "error", undefined, err.message);
        await appendJobLog(JOB_SYNC_ALL, `Failed — ${err.message}`);
      }
    });
});

router.post("/sync/cancel", async (_req, res) => {
  const current = await getJob(JOB_SYNC_ALL);

  if (current.status !== "running") {
    res.status(400).json({
      error: `No sync currently running (status: ${current.status})`,
      status: current.status,
    });
    return;
  }

  await requestCancel(JOB_SYNC_ALL);
  await appendJobLog(JOB_SYNC_ALL, "Cancellation requested — stopping after current player…");

  res.json({
    status: "cancelling",
    message: "Sync will stop after the current player completes. Poll GET /api/sync/status to confirm.",
  });
});

router.get("/sync/status", async (_req, res) => {
  const job = await getJob(JOB_SYNC_ALL);
  res.json({
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    stats: job.stats,
    error: job.error,
    recentLogs: job.logs.slice(-50),
  });
});

// ─── Event-centric sync ───────────────────────────────────────────────────────

router.post("/sync/events", async (_req, res) => {
  const current = await getJob(JOB_SYNC_EVENTS);

  if (current.status === "running") {
    return res.status(409).json({ error: "Event sync already running" });
  }

  await startJob(JOB_SYNC_EVENTS);
  await appendJobLog(JOB_SYNC_EVENTS, "Job started");

  (async () => {
    try {
      const stats = await syncEventAttendance(
        (msg: string) => appendJobLog(JOB_SYNC_EVENTS, msg),
        () => isCancelled(JOB_SYNC_EVENTS)
      );
      const wasCancelled = await isCancelled(JOB_SYNC_EVENTS);
      await finishJob(JOB_SYNC_EVENTS, wasCancelled ? "cancelled" : "done", stats);
      await appendJobLog(JOB_SYNC_EVENTS, `Job finished — status: ${wasCancelled ? "cancelled" : "done"}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const wasCancelled = msg.includes("cancelled by operator");
      await finishJob(JOB_SYNC_EVENTS, wasCancelled ? "cancelled" : "error", undefined, msg);
      await appendJobLog(JOB_SYNC_EVENTS, `${wasCancelled ? "Cancelled" : "ERROR"}: ${msg}`);
    }
  })();

  return res.status(202).json({
    message: "Event sync started",
    statusUrl: "/api/sync/events/status",
  });
});

router.get("/sync/events/status", async (_req, res) => {
  const job = await getJob(JOB_SYNC_EVENTS);
  res.json({
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    stats: job.stats,
    error: job.error,
    recentLogs: job.logs.slice(-50),
  });
});

router.post("/sync/events/cancel", async (_req, res) => {
  const current = await getJob(JOB_SYNC_EVENTS);
  if (current.status !== "running") {
    return res.status(409).json({ error: "No event sync currently running" });
  }
  await requestCancel(JOB_SYNC_EVENTS);
  await appendJobLog(JOB_SYNC_EVENTS, "Cancellation requested");
  return res.json({ message: "Cancellation requested" });
});

// ─── Nightly chain ────────────────────────────────────────────────────────────

const JOB_NIGHTLY = "nightly_sync";

router.post("/sync/nightly", async (_req, res) => {
  const current = await getJob(JOB_NIGHTLY);
  if (current.status === "running") {
    return res.status(409).json({ error: "Nightly sync already running" });
  }

  runNightlyChain().catch(() => {});

  return res.status(202).json({
    message: "Nightly chain started (import → incremental event sync)",
    statusUrl: "/api/sync/nightly/status",
  });
});

router.get("/sync/nightly/status", async (_req, res) => {
  const job = await getJob(JOB_NIGHTLY);
  res.json({
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    stats: job.stats,
    error: job.error,
    recentLogs: job.logs.slice(-50),
  });
});

export default router;
