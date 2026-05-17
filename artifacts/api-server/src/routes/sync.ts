import { Router, type IRouter } from "express";
import { z } from "zod";
// @ts-ignore — plain JS module
import { syncSinglePlayer } from "../syncPlayerAttendance.js";
// @ts-ignore — plain JS module
import { syncEventAttendance } from "../syncEventAttendance.js";
import { getJob, startJob, finishJob, appendJobLog, isCancelled, requestCancel } from "../lib/jobStore";
import { runNightlyChain } from "../lib/scheduler";
import { computeLevelConfidence } from "../lib/levelConfidence";
import { computeChurnScore, computeChurnScoreAndReturn, runChurnScoreBatch, JOB_CHURN } from "../lib/churnScore";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";

const router: IRouter = Router();

const SYNC_TIMEOUT_MS = 30_000;
const STALE_HOURS = 6;

const JOB_SYNC_ALL    = "sync_all";
const JOB_SYNC_EVENTS = "sync_events";

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

async function runSyncAll(clubId: string) {
  const staleThreshold = new Date(
    Date.now() - STALE_HOURS * 60 * 60 * 1000
  ).toISOString();

  let players: any[] = [];
  let hasLastSyncedAt = true;

  const probe = await supabase
    .from("players")
    .select("id, external_id, last_synced_at")
    .eq("club_id", clubId)
    .not("external_id", "is", null)
    .limit(1);

  if (probe.error && (probe.error.code === "42703" || probe.error.message?.includes("last_synced_at"))) {
    await appendJobLog(JOB_SYNC_ALL, "last_synced_at column missing — syncing all players");
    hasLastSyncedAt = false;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("players")
        .select("id, external_id")
        .eq("club_id", clubId)
        .not("external_id", "is", null)
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      players.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }
  } else if (probe.error) {
    throw new Error(probe.error.message);
  } else {
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("players")
        .select("id, external_id, last_synced_at")
        .eq("club_id", clubId)
        .not("external_id", "is", null)
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      players.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }
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

router.post("/sync/player", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const parsed = SyncPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  const { player_id, external_id } = parsed.data;

  // Cross-tenant guard
  const { data: player } = await supabase
    .from("players")
    .select("id")
    .eq("id", player_id)
    .eq("club_id", clubId)
    .maybeSingle();
  if (!player) {
    res.status(404).json({ error: "Player not found in this club" });
    return;
  }

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

router.post("/sync/all", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const current = await getJob(JOB_SYNC_ALL, { withLogs: true });

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

  runSyncAll(clubId)
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
  const job = await getJob(JOB_SYNC_ALL, { withLogs: true });
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

router.post("/sync/events", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const current = await getJob(JOB_SYNC_EVENTS);

  if (current.status === "running") {
    return res.status(409).json({ error: "Event sync already running" });
  }

  await startJob(JOB_SYNC_EVENTS);
  await appendJobLog(JOB_SYNC_EVENTS, "Job started");

  (async () => {
    try {
      const stats = await syncEventAttendance(
        clubId,
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
  const job = await getJob(JOB_SYNC_EVENTS, { withLogs: true });
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
  const job = await getJob(JOB_NIGHTLY, { withLogs: true });
  res.json({
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    stats: job.stats,
    error: job.error,
    recentLogs: job.logs.slice(-50),
  });
});

// ─── Level confidence batch recompute ─────────────────────────────────────────

const JOB_CONFIDENCE = "compute_confidence";

router.post("/sync/level-confidence", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const current = await getJob(JOB_CONFIDENCE);
  if (current.status === "running") {
    return res.status(409).json({ error: "Confidence compute already running" });
  }

  await startJob(JOB_CONFIDENCE);
  await appendJobLog(JOB_CONFIDENCE, "Batch confidence compute started");

  (async () => {
    try {
      const { data: rows, error } = await supabase
        .from("attendances")
        .select("player_id")
        .not("player_id", "is", null)
        .not("level", "is", null);

      if (error) throw new Error(error.message);

      // Scope to this club's players
      const allIds = [...new Set((rows ?? []).map((r: any) => r.player_id as string))];

      // Filter to players belonging to this club
      const clubPlayerIds: string[] = [];
      for (let i = 0; i < allIds.length; i += 100) {
        const chunk = allIds.slice(i, i + 100);
        const { data: clubPlayers } = await supabase
          .from("players")
          .select("id")
          .eq("club_id", clubId)
          .in("id", chunk);
        clubPlayerIds.push(...(clubPlayers ?? []).map((p: any) => p.id));
      }

      await appendJobLog(JOB_CONFIDENCE, `Computing confidence for ${clubPlayerIds.length} players`);

      let count = 0;
      for (const playerId of clubPlayerIds) {
        await computeLevelConfidence(playerId);
        count++;
        if (count % 50 === 0) {
          await appendJobLog(JOB_CONFIDENCE, `Computed confidence for ${count}/${clubPlayerIds.length} players...`);
        }
      }

      await finishJob(JOB_CONFIDENCE, "done", { players_computed: count });
      await appendJobLog(JOB_CONFIDENCE, `Done — computed confidence for ${count} players`);
    } catch (err: any) {
      await finishJob(JOB_CONFIDENCE, "error", undefined, err.message);
      await appendJobLog(JOB_CONFIDENCE, `Failed: ${err.message}`);
    }
  })();

  return res.status(202).json({
    message: "Confidence compute started",
    statusUrl: "/api/sync/level-confidence/status",
  });
});

router.get("/sync/level-confidence/status", async (_req, res) => {
  const job = await getJob(JOB_CONFIDENCE, { withLogs: true });
  res.json({
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    stats: job.stats,
    error: job.error,
    recentLogs: job.logs.slice(-50),
  });
});

// ─── Churn Score routes ────────────────────────────────────────────────────────

router.post("/sync/churn-scores", async (_req, res) => {
  (async () => {
    await runChurnScoreBatch();
  })();

  return res.status(202).json({
    message: "Churn score computation started",
    statusUrl: "/api/sync/churn-scores/status",
  });
});

router.get("/sync/churn-scores/status", async (_req, res) => {
  const job = await getJob(JOB_CHURN, { withLogs: true });
  res.json({
    status: job.status,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    stats: job.stats,
    error: job.error,
    recentLogs: job.logs.slice(-50),
  });
});

router.post("/sync/churn-scores/cancel", async (_req, res) => {
  await requestCancel(JOB_CHURN);
  res.json({ message: "Cancel requested" });
});

router.post("/sync/churn-scores/test", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { player_id } = req.body ?? {};
  if (!player_id || typeof player_id !== "string") {
    return res.status(400).json({ error: "player_id is required" });
  }
  // Cross-tenant guard
  const { data: player } = await supabase
    .from("players")
    .select("id")
    .eq("id", player_id)
    .eq("club_id", clubId)
    .maybeSingle();
  if (!player) {
    return res.status(404).json({ error: "Player not found in this club" });
  }
  try {
    const result = await computeChurnScoreAndReturn(player_id);
    if (!result) {
      return res.status(404).json({ error: "Player not found or is Never Visited" });
    }
    return res.json({ player_id, ...result });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
