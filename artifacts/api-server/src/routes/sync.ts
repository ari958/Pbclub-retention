import { Router, type IRouter } from "express";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
// @ts-ignore — plain JS module
import { syncSinglePlayer } from "../syncPlayerAttendance.js";

const router: IRouter = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

// ─── Constants ────────────────────────────────────────────────────────────────

const SYNC_TIMEOUT_MS = 30_000;
const STALE_HOURS = 6;

// ─── Job state ────────────────────────────────────────────────────────────────

type SyncStatus = "idle" | "running" | "cancelled" | "done" | "error";

let syncStatus: SyncStatus = "idle";
let syncStartedAt: string | null = null;
let syncFinishedAt: string | null = null;
let syncStats: Record<string, number> | null = null;
let syncError: string | null = null;
let syncCancelled = false;
const syncLogs: string[] = [];

function appendLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  syncLogs.push(line);
  if (syncLogs.length > 2000) syncLogs.splice(0, syncLogs.length - 2000);
  console.log(line);
}

function resetJob() {
  syncStatus = "running";
  syncStartedAt = new Date().toISOString();
  syncFinishedAt = null;
  syncStats = null;
  syncError = null;
  syncCancelled = false;
  syncLogs.length = 0;
}

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

  // Fetch all linked players, with stale filter if column exists
  let players: any[] = [];
  let hasLastSyncedAt = true;

  const withCol = await supabase
    .from("players")
    .select("id, external_id, last_synced_at")
    .not("external_id", "is", null);

  if (withCol.error) {
    if (withCol.error.code === "42703" || withCol.error.message?.includes("last_synced_at")) {
      appendLog("sync/all: last_synced_at column missing — syncing all players");
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

  appendLog(`sync/all: ${players.length} linked players — ${eligible.length} stale, ${skipped} fresh (skipping)`);

  let synced = 0;
  let errors = 0;
  let timeouts = 0;

  for (let i = 0; i < eligible.length; i++) {
    if (syncCancelled) {
      appendLog("sync/all: cancelled — stopping after current player");
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
      appendLog(`sync/all: [${i + 1}/${eligible.length}] OK ${player.id} — inserted=${(result as any).inserted ?? 0}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const isTimeout = message.includes("Timeout");
      if (isTimeout) timeouts++;
      else errors++;
      appendLog(`sync/all: [${i + 1}/${eligible.length}] ${isTimeout ? "TIMEOUT" : "ERROR"} ${player.id}: ${message}`);
    }
  }

  return { total: players.length, eligible: eligible.length, synced, skipped, errors, timeouts };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/sync/player
 * Sync a single player by player_id + external_id. Synchronous (fast).
 */
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

/**
 * POST /api/sync/all
 *
 * Kicks off a background attendance sync for all stale players.
 * Returns 202 immediately. Poll GET /api/sync/status for progress.
 * Use POST /api/sync/cancel to stop a running job.
 */
router.post("/sync/all", (_req, res) => {
  if (syncStatus === "running") {
    res.status(409).json({
      error: "Sync already running. POST /api/sync/cancel to stop it first.",
      startedAt: syncStartedAt,
      recentLogs: syncLogs.slice(-10),
    });
    return;
  }

  resetJob();
  appendLog("sync/all: triggered via POST /api/sync/all");

  res.status(202).json({
    status: "started",
    message: "Sync running in background. Poll GET /api/sync/status for progress.",
    startedAt: syncStartedAt,
  });

  runSyncAll()
    .then((stats) => {
      syncStats = stats;
      syncStatus = "done";
      syncFinishedAt = new Date().toISOString();
      appendLog(`sync/all: done — synced=${stats.synced} skipped=${stats.skipped} errors=${stats.errors} timeouts=${stats.timeouts}`);
    })
    .catch((err: Error) => {
      syncFinishedAt = new Date().toISOString();
      if (err.name === "CancelledError") {
        syncStatus = "cancelled";
        appendLog("sync/all: cancelled — safe to restart via POST /api/sync/all");
      } else {
        syncError = err.message;
        syncStatus = "error";
        appendLog(`sync/all: failed — ${err.message}`);
      }
    });
});

/**
 * POST /api/sync/cancel
 * Signals the running sync to stop at the next player boundary.
 */
router.post("/sync/cancel", (_req, res) => {
  if (syncStatus !== "running") {
    res.status(400).json({
      error: `No sync currently running (status: ${syncStatus})`,
      status: syncStatus,
    });
    return;
  }

  syncCancelled = true;
  appendLog("sync/all: cancellation requested — stopping after current player…");

  res.json({
    status: "cancelling",
    message: "Sync will stop after the current player completes. Poll GET /api/sync/status to confirm.",
  });
});

/**
 * GET /api/sync/status
 * Returns current sync job state, stats, and recent log lines.
 */
router.get("/sync/status", (_req, res) => {
  res.json({
    status: syncStatus,
    startedAt: syncStartedAt,
    finishedAt: syncFinishedAt,
    stats: syncStats,
    error: syncError,
    cancelling: syncStatus === "running" && syncCancelled,
    recentLogs: syncLogs.slice(-50),
  });
});

export default router;
