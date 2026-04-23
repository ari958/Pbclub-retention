import { Router, type IRouter } from "express";
import { z } from "zod";
// @ts-ignore — plain JS module
import { syncSinglePlayer } from "../syncPlayerAttendance.js";

const router: IRouter = Router();

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

export default router;
