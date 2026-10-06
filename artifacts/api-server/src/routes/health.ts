import { Router, type IRouter } from "express";
import { runtimeHealth } from "../lib/operatorMonitoring";

const router: IRouter = Router();
router.get("/healthz", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { schedule: _schedule, ...health } = await runtimeHealth();
    res.status(health.status === "ok" ? 200 : 503).json(health);
  } catch {
    res.status(503).json({ status: "degraded", db_reachable: false,
      last_queue_tick_at: null, last_nightly_sync: { result: "unknown", at: null },
      sms_live: process.env.SMS_LIVE === "true", paused: null });
  }
});
export default router;
