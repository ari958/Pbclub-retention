import { Router } from "express";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { getOperatorTestMessages, operatorTestAvailable, sendOperatorTestMessage } from "../lib/operatorTestMessage";
import { isSmsPolicyBlockedError } from "../lib/twilio";

const router = Router();
router.get("/operator-test-message", requireClub, async (req, res) => {
  try {
    res.json({ available: operatorTestAvailable(), messages: await getOperatorTestMessages((req as ClubScopedRequest).clubId) });
  } catch (error: any) { res.status(500).json({ error: error.message }); }
});
router.post("/operator-test-message", requireClub, async (req, res) => {
  req.log.info({ actor: res.locals.operator.actor, action: "operator_test_message" }, "Operator test requested");
  if (Object.keys(req.body ?? {}).length) return void res.status(400).json({ error: "An empty body is required; the text and recipient are fixed" });
  try {
    res.json(await sendOperatorTestMessage((req as ClubScopedRequest).clubId, res.locals.operator.actor));
  } catch (error: any) {
    req.log.warn({ actor: res.locals.operator.actor, action: "operator_test_message", reason: error.message }, "Operator test refused or failed");
    res.status(error.status ?? (isSmsPolicyBlockedError(error) ? 409 : 500)).json({ error: error.message });
  }
});
export default router;
