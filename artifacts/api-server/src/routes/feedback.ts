import { Router, type IRouter } from "express";
import { sendFeedbackForEvent, sendFeedbackForRecentEvents } from "../lib/postSessionFeedback";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";

const router: IRouter = Router();

/**
 * POST /api/feedback/send-post-session
 *
 * Body (optional): { event_id: string }
 *   - With event_id: process that specific event only
 *   - Without:       process all events that ended in the last 2 hours
 */
router.post("/feedback/send-post-session", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
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
        await sendFeedbackForEvent(event_id, clubId, log);
      } else {
        await sendFeedbackForRecentEvents(clubId, log);
      }
    } catch (err: any) {
      req.log.error({ err }, "[feedback] send-post-session background error");
    }
  })();
});

// ─── Test / dev routes ────────────────────────────────────────────────────────

router.post("/feedback/test/send-event", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const { event_id } = req.body as { event_id?: string };

  if (!event_id) {
    res.status(400).json({ error: "event_id is required" });
    return;
  }

  try {
    const log = (msg: string) => req.log.info(msg);
    const stats = await sendFeedbackForEvent(event_id, clubId, log);
    res.json({ success: true, stats });
  } catch (err: any) {
    req.log.error({ err }, "[feedback/test] send-event failed");
    res.status(500).json({ error: err.message });
  }
});

router.post("/feedback/test/poll-now", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const log = (msg: string) => req.log.info(msg);
    const result = await sendFeedbackForRecentEvents(clubId, log, 2);
    res.json({ success: true, result });
  } catch (err: any) {
    req.log.error({ err }, "[feedback/test] poll-now failed");
    res.status(500).json({ error: err.message });
  }
});

export default router;
