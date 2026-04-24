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

const SyncPlayerSchema = z.object({
  player_id: z.string().min(1, "player_id is required"),
  external_id: z.string().min(1, "external_id is required"),
});

router.post("/sync/player", async (req, res) => {
  const parsed = SyncPlayerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
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

const SYNC_TIMEOUT_MS = 10_000;
const STALE_HOURS = 6;

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

router.post("/sync/all", async (req, res) => {
  const staleThreshold = new Date(
    Date.now() - STALE_HOURS * 60 * 60 * 1000
  ).toISOString();

  // Try fetching with last_synced_at; fall back to without if column is missing
  let players: any[] | null = null;
  let hasLastSyncedAt = true;

  const withCol = await supabase
    .from("players")
    .select("id, external_id, last_synced_at")
    .not("external_id", "is", null);

  if (withCol.error) {
    if (withCol.error.code === "42703" || withCol.error.message?.includes("last_synced_at")) {
      req.log.warn(
        "sync/all: last_synced_at column missing — syncing all players. " +
        "Add it with: ALTER TABLE players ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;"
      );
      hasLastSyncedAt = false;
      const fallback = await supabase
        .from("players")
        .select("id, external_id")
        .not("external_id", "is", null);
      if (fallback.error) {
        req.log.error({ err: fallback.error }, "sync/all: failed to fetch players");
        res.status(500).json({ error: fallback.error.message });
        return;
      }
      players = fallback.data ?? [];
    } else {
      req.log.error({ err: withCol.error }, "sync/all: failed to fetch players");
      res.status(500).json({ error: withCol.error.message });
      return;
    }
  } else {
    players = withCol.data ?? [];
  }

  // Filter stale locally
  const eligible = hasLastSyncedAt
    ? players.filter((p: any) => {
        if (!p.last_synced_at) return true;
        return new Date(p.last_synced_at) < new Date(staleThreshold);
      })
    : players;

  req.log.info(
    { total: players?.length ?? 0, eligible: eligible.length },
    "sync/all: starting batch"
  );

  let synced = 0;
  let skippedStale = (players?.length ?? 0) - eligible.length;
  let errors = 0;
  const results: { player_id: string; status: string; detail?: string }[] = [];

  for (const player of eligible) {
    try {
      const result = await withTimeout(
        syncSinglePlayer(player.id, player.external_id),
        SYNC_TIMEOUT_MS,
        `player ${player.id}`
      );

      // Update last_synced_at on success
      await supabase
        .from("players")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("id", player.id);

      synced++;
      results.push({ player_id: player.id, status: "ok", detail: JSON.stringify(result) });
      req.log.info({ player_id: player.id }, "sync/all: player synced");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const isTimeout = message.includes("Timeout");
      errors++;
      results.push({
        player_id: player.id,
        status: isTimeout ? "timeout" : "error",
        detail: message,
      });
      req.log.warn(
        { player_id: player.id, err: message },
        `sync/all: player ${isTimeout ? "timed out" : "failed"}`
      );
    }
  }

  req.log.info({ synced, skippedStale, errors }, "sync/all: complete");

  res.json({
    synced,
    skipped: skippedStale,
    errors,
    results,
  });
});

export default router;
