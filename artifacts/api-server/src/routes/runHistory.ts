import { Router, type IRouter } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { GetGenerationRunsResponse, GetNightlyRunsResponse } from "@workspace/api-zod";

const router: IRouter = Router();
for (const [path, table, schema] of [
  ["/retention/generation-runs", "retention_generation_runs", GetGenerationRunsResponse],
  ["/sync/nightly/runs", "nightly_sync_runs", GetNightlyRunsResponse],
] as const) {
  router.get(path, requireClub, async (req, res): Promise<void> => {
    const parsed = z.object({ run_id: z.string().uuid().optional() }).safeParse({ run_id: req.query.run_id });
    if (!parsed.success) { res.status(400).json({ error: "Invalid run ID" }); return; }
    try {
      const clubId = (req as ClubScopedRequest).clubId;
      let query = supabase.from(table).select("*").eq("club_id", clubId)
        .order("started_at", { ascending: false }).order("id", { ascending: false }).limit(14);
      if (parsed.data.run_id) query = query.eq("id", parsed.data.run_id);
      const [runs, club] = await Promise.all([
        query,
        supabase.from("clubs").select("timezone,scheduled_sync_time").eq("id", clubId).single(),
      ]);
      if (runs.error) {
        if (["42P01", "PGRST205"].includes(runs.error.code)) {
          res.status(503).json({ schema_ready: false, error: "Run history is unavailable until migration 029 is installed. Generation and sync remain unchanged." });
          return;
        }
        throw runs.error;
      }
      if (club.error) throw club.error;
      if (parsed.data.run_id && !runs.data?.length) { res.status(404).json({ error: "Run not found in this club" }); return; }
      res.json(schema.parse({ schema_ready: true, timezone: club.data.timezone ?? "America/New_York",
        scheduled_time: club.data.scheduled_sync_time ?? null, runs: runs.data ?? [] }));
    } catch (error) {
      req.log.error({ error }, "Run history read failed");
      res.status(500).json({ error: "Run history could not be loaded" });
    }
  });
}
export default router;
