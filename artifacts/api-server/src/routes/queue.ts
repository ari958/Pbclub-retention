import { Router, type IRouter } from "express";
import { runQueueTick } from "../lib/queuePoller";

const router: IRouter = Router();

router.post("/queue/poll-now", async (req, res) => {
  try {
    const stats = await runQueueTick();
    req.log.info(stats, "[queue] poll-now complete");
    res.json({ ok: true, stats });
  } catch (err: any) {
    req.log.error({ err }, "[queue] poll-now error");
    res.status(500).json({ error: err?.message ?? "Queue tick failed" });
  }
});

export default router;
