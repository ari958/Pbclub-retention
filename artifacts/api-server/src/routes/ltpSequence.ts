import { Router, type IRouter } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { regenerateLtpCandidateBatch, reshuffleLtpCandidate } from "../lib/retentionEngine";
import { LtpSequenceConfigSchema } from "../lib/ltpPhraseBuilder";
import ltpTestToolsRouter from "./ltpTestTools";

const router: IRouter = Router();
router.use(ltpTestToolsRouter);
const CandidateIdsSchema = z.object({
  candidate_ids: z.array(z.string().uuid()).min(1).max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Candidate IDs must be distinct"),
}).strict();
const EmptyBodySchema = z.object({}).strict();

export async function requireLtpSequenceSchemaReady() {
  const { data, error } = await supabase.rpc("retention_sequence_ready");
  if (error || data !== true) {
    throw Object.assign(new Error(
      "Apply migration 013_retention_ltp_sequence.sql in the existing Supabase SQL Editor before using the two-step LTP sequence",
    ), { status: 503 });
  }
}

function operationErrorStatus(error: any): number {
  if (error.status) return error.status;
  if (/schema cache|could not find the function|does not exist/i.test(error.message)) return 503;
  if (/changed since|capacity_exhausted|concurrent|only .*draft|not active|approved|scheduled|claimed|not eligible/i.test(error.message)) return 409;
  return 500;
}

router.post("/retention/regenerate-batch", requireClub, async (req, res) => {
  const parsed = CandidateIdsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide 1–50 distinct candidate UUIDs" });
  try {
    await requireLtpSequenceSchemaReady();
    return res.json(await regenerateLtpCandidateBatch(
      (req as ClubScopedRequest).clubId, parsed.data.candidate_ids,
    ));
  } catch (error: any) {
    const status = operationErrorStatus(error);
    return res.status(status).json({ schema_ready: status !== 503, error: error.message, run_id: error.run_id ?? null });
  }
});

router.post("/retention/candidates/:id/reshuffle", requireClub, async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success || !EmptyBodySchema.safeParse(req.body ?? {}).success) {
    return res.status(400).json({ error: "A valid candidate UUID and empty request body are required" });
  }
  try {
    await requireLtpSequenceSchemaReady();
    return res.json(await reshuffleLtpCandidate((req as ClubScopedRequest).clubId, req.params.id as string));
  } catch (error: any) {
    const status = operationErrorStatus(error);
    return res.status(status).json({ schema_ready: status !== 503, error: error.message, run_id: error.run_id ?? null });
  }
});

router.patch("/retention/playbooks/:key/config", requireClub, async (req, res) => {
  if (req.params.key !== "ltp_followup") return res.status(400).json({ error: "Phrase configuration is supported only for ltp_followup" });
  const parsed = z.object({ ltp_sequence_config: LtpSequenceConfigSchema }).strict().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid LTP phrase configuration",
      validation_errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }
  try {
    await requireLtpSequenceSchemaReady();
    const { data, error } = await supabase.from("retention_playbooks")
      .update({ ltp_sequence_config: parsed.data.ltp_sequence_config })
      .eq("key", "ltp_followup").select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: "LTP playbook not found" });
    return res.json(data);
  } catch (error: any) {
    const status = operationErrorStatus(error);
    return res.status(status).json({ schema_ready: status !== 503, error: error.message });
  }
});

export default router;