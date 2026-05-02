import { Router, type IRouter } from "express";
import { sendFeedbackForEvent, sendFeedbackForRecentEvents } from "../lib/postSessionFeedback";

const router: IRouter = Router();

/**
 * POST /api/feedback/send-post-session
 *
 * Body (optional): { event_id: string }
 *   - With event_id: process that specific event only
 *   - Without:       process all events that ended in the last 2 hours
 *
 * Returns 202 immediately; processing runs in the background.
 */
router.post("/feedback/send-post-session", async (req, res) => {
  const { event_id } = req.body as { event_id?: string };
  const log = (msg: string) => req.log.info(msg);

  res.status(202).json({
    status: "started",
    message: event_id
      ? `Processing feedback for event ${event_id}`
      : "Processing events that ended in the last 2 hours",
  });

  (async () => {
    try {
      if (event_id) {
        await sendFeedbackForEvent(event_id, log);
      } else {
        await sendFeedbackForRecentEvents(log);
      }
    } catch (err: any) {
      req.log.error({ err }, "[feedback] send-post-session background error");
    }
  })();
});

// ─── Test / dev routes ────────────────────────────────────────────────────────

/**
 * POST /api/feedback/test/send-event
 * Body: { event_id: string }
 * Sends feedback texts for a specific event immediately.
 */
router.post("/feedback/test/send-event", async (req, res) => {
  const { event_id } = req.body as { event_id?: string };

  if (!event_id) {
    res.status(400).json({ error: "event_id is required" });
    return;
  }

  try {
    const log = (msg: string) => req.log.info(msg);
    const stats = await sendFeedbackForEvent(event_id, log);
    res.json({ success: true, stats });
  } catch (err: any) {
    req.log.error({ err }, "[feedback/test] send-event failed");
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/feedback/test/poll-now
 * Triggers a 2-hour lookback immediately — useful for testing against
 * events that already ended without waiting for the 30-minute poller.
 */
router.post("/feedback/test/poll-now", async (req, res) => {
  try {
    const log = (msg: string) => req.log.info(msg);
    const result = await sendFeedbackForRecentEvents(log, 2);
    res.json({ success: true, result });
  } catch (err: any) {
    req.log.error({ err }, "[feedback/test] poll-now failed");
    res.status(500).json({ error: err.message });
  }
});

export default router;
