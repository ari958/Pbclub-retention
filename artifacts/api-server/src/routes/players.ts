import { Router, type IRouter } from "express";
// @ts-ignore — plain JS module
import { assembleProfile } from "../assembleProfile.js";

const router: IRouter = Router();

router.get("/players/:id/profile", async (req, res) => {
  try {
    const data = await assembleProfile(req.params.id);
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("JSON object requested, multiple (or no) rows returned")) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    req.log.error({ err }, "Failed to assemble player profile");
    res.status(500).json({ error: message });
  }
});

export default router;
