import { Router, type IRouter } from "express";
import { z } from "zod";
import { getJob } from "../lib/jobStore";
import { generateMonthlyRecap, runMonthlyRecapBatch } from "../lib/monthlyRecap";
import { checkPlayerMilestones, runMilestoneBatch } from "../lib/milestoneCheck";

const router: IRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function priorMonth(): { month: number; year: number } {
  const now = new Date();
  const m = now.getMonth(); // 0-indexed
  return m === 0
    ? { month: 12, year: now.getFullYear() - 1 }
    : { month: m, year: now.getFullYear() };
}

// ─── Monthly Recap ─────────────────────────────────────────────────────────────

const MonthlyBatchSchema = z.object({
  month: z.number().int().min(1).max(12).optional(),
  year:  z.number().int().min(2020).optional(),
});

router.post("/recap/monthly", async (req, res) => {
  const parsed = MonthlyBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { month, year } = { ...priorMonth(), ...parsed.data };

  // Fire-and-forget — the job tracks state
  runMonthlyRecapBatch(month, year).catch((err) =>
    req.log.error({ err }, "[recap] monthly batch error")
  );

  res.json({ success: true, message: `Monthly recap batch started for ${year}-${month}` });
});

router.get("/recap/monthly/status", async (_req, res) => {
  const job = await getJob("monthly_recap", { withLogs: true });
  res.json(job);
});

const MonthlyTestSchema = z.object({
  player_id: z.string().uuid(),
  month: z.number().int().min(1).max(12).optional(),
  year:  z.number().int().min(2020).optional(),
  dry_run: z.boolean().optional().default(true),
});

router.post("/recap/monthly/test", async (req, res) => {
  const parsed = MonthlyTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { player_id, dry_run } = parsed.data;
  const { month, year } = { ...priorMonth(), ...parsed.data };

  try {
    const result = await generateMonthlyRecap(player_id, month, year, dry_run);
    res.json({ success: true, ...result });
  } catch (err: any) {
    req.log.error({ err }, "[recap] monthly test error");
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Milestones ────────────────────────────────────────────────────────────────

router.post("/recap/milestones", async (req, res) => {
  runMilestoneBatch().catch((err) =>
    req.log.error({ err }, "[recap] milestone batch error")
  );
  res.json({ success: true, message: "Milestone batch started" });
});

router.get("/recap/milestones/status", async (_req, res) => {
  const job = await getJob("milestone_check", { withLogs: true });
  res.json(job);
});

const MilestoneTestSchema = z.object({
  player_id: z.string().uuid(),
  dry_run: z.boolean().optional().default(true),
});

router.post("/recap/milestones/test", async (req, res) => {
  const parsed = MilestoneTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { player_id, dry_run } = parsed.data;

  try {
    const result = await checkPlayerMilestones(player_id, dry_run);
    res.json({ success: true, ...result });
  } catch (err: any) {
    req.log.error({ err }, "[recap] milestone test error");
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
