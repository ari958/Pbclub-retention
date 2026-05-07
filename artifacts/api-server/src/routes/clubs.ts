import { Router, type IRouter } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";

const router: IRouter = Router();

// ─── PATCH /api/clubs/:id/settings ───────────────────────────────────────────

const ClubSettingsSchema = z
  .object({
    scheduled_sync_time: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Must be HH:MM format')
      .optional(),
    timezone: z.string().min(1).optional(),
  })
  .refine(
    (d) => d.scheduled_sync_time !== undefined || d.timezone !== undefined,
    { message: "At least one field (scheduled_sync_time or timezone) is required" },
  );

router.patch("/clubs/:id/settings", async (req, res) => {
  const parsed = ClubSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.scheduled_sync_time !== undefined)
    updates.scheduled_sync_time = parsed.data.scheduled_sync_time;
  if (parsed.data.timezone !== undefined)
    updates.timezone = parsed.data.timezone;

  const { data, error } = await supabase
    .from("clubs")
    .update(updates)
    .eq("id", req.params.id)
    .select("id, scheduled_sync_time, timezone")
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

export default router;
