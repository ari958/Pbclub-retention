import { Router, type IRouter } from "express";
// @ts-ignore — plain JS module
import { fetchAvailablePrograms } from "../fetchAvailablePrograms.js";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";

const router: IRouter = Router();

router.get("/programs", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const programs = await fetchAvailablePrograms(clubId);
    res.json({ count: programs.length, programs });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "Failed to fetch available programs");
    res.status(502).json({ error: message });
  }
});

export default router;
