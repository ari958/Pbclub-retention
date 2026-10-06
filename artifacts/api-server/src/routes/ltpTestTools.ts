import { Router, type IRouter } from "express";
import { z } from "zod";
import { LtpTestActionBody, DraftLtpTestStep2Body } from "@workspace/api-zod";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { supabase } from "../lib/supabaseClient";
import { ltpTestRpc, requireLtpTestOverride, readLtpTestControl, resetSimulatedLtpTestMessage } from "../lib/ltpTestTools";
import { generateDueLtpStep2Drafts, regenerateRetentionCandidate } from "../lib/retentionEngine";
import { recheckLtpSequenceDispatch } from "../lib/ltpSequenceLifecycle";
import type { RetentionCandidate } from "../lib/retentionTypes";

const router: IRouter = Router();
const actionSchema = LtpTestActionBody.extend({ actor: z.string().trim().min(1).max(120) }).strict();
const idsSchema = DraftLtpTestStep2Body.strict()
  .refine(({ candidate_ids }) => new Set(candidate_ids).size === candidate_ids.length);

router.use("/retention/test-tools", (_req, res, next) => {
  try { requireLtpTestOverride(); next(); }
  catch (error: any) { res.status(403).json({ error: error.message }); }
});
router.post("/retention/test-tools/candidates/:id", requireClub, async (req, res): Promise<void> => {
  const parsed = actionSchema.safeParse(req.body);
  const id = z.string().uuid().safeParse(req.params.id);
  if (!parsed.success || !id.success) { res.status(400).json({ error: "Candidate UUID, action, and actor are required" }); return; }
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    if (parsed.data.action === "reset_simulated") {
      await resetSimulatedLtpTestMessage(clubId, id.data, parsed.data.actor);
      res.json(await regenerateRetentionCandidate(clubId, id.data));
      return;
    }
    if (parsed.data.action !== "dispatch_check") {
      let sourceId = id.data;
      if (parsed.data.action === "simulate_booking") {
        const { data: selected, error } = await supabase.from("retention_candidates")
          .select("step,sequence_id").eq("id", sourceId).eq("club_id", clubId).maybeSingle();
        if (error || !selected) throw Object.assign(new Error("Candidate not found"), { status: 404 });
        if (selected.step === 2) {
          const { data: source, error: sourceError } = await supabase.from("retention_candidates")
            .select("id").eq("club_id", clubId).eq("sequence_id", selected.sequence_id).eq("step", 1).maybeSingle();
          if (sourceError || !source) throw new Error("Source test step 1 is missing");
          sourceId = source.id;
        }
      }
      res.json(await ltpTestRpc(parsed.data.action, clubId, { candidate_id: sourceId, actor: parsed.data.actor }));
      return;
    }
    const { data: candidate, error } = await supabase.from("retention_candidates")
      .select("*").eq("id", id.data).eq("club_id", clubId).maybeSingle();
    if (error || !candidate || candidate.step !== 2 || candidate.sequence_status !== "active"
      || candidate.status !== "drafted" || !candidate.sequence_id) {
      throw Object.assign(new Error("An active unapproved test step-2 draft is required"), { status: 409 });
    }
    const control = await readLtpTestControl(clubId, candidate.sequence_id);
    if (!control?.simulated_booking) throw Object.assign(new Error("Enable simulated booking before this no-send check"), { status: 409 });
    const { data: message, error: messageError } = await supabase.from("messages")
      .select("body,approved_at,scheduled_send_at,sent_at").eq("id", candidate.message_id).maybeSingle();
    if (messageError || !message || message.approved_at || message.scheduled_send_at || message.sent_at) {
      throw Object.assign(new Error("Dispatch check never operates on approved, scheduled, or sent messages"), { status: 409 });
    }
    // Same pre-claim booking check and atomic exit used by Twilio dispatch.
    // Deliberately never call the transport, claim, approve, or queue a send.
    const check = await recheckLtpSequenceDispatch(candidate as RetentionCandidate, {}, message.body);
    if (!check.booked) throw new Error("Expected simulated booking was not found; no state changed");
    await ltpTestRpc("exit_booked", clubId, { message_id: candidate.message_id, actor: parsed.data.actor });
    res.json({ blocked: true, sequence_status: "exited_booked", draft_withdrawn: true, sent: false, source: check.booked.source });
  } catch (error: any) { res.status(error.status ?? 500).json({ error: error.message }); }
});
router.post("/retention/test-tools/draft-step2", requireClub, async (req, res): Promise<void> => {
  const parsed = idsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Select 1–50 distinct test step-1 UUIDs" }); return; }
  try { res.json(await generateDueLtpStep2Drafts((req as ClubScopedRequest).clubId, parsed.data.candidate_ids)); }
  catch (error: any) { res.status(error.status ?? 500).json({ error: error.message }); }
});
export default router;
