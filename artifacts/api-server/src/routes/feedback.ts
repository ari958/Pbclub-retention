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

export default router;
