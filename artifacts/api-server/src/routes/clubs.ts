import { Router, type IRouter } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";

const router: IRouter = Router();

// ─── GET /api/clubs — list all clubs ─────────────────────────────────────────

router.get("/", async (_req, res) => {
  const { data, error } = await supabase
    .from("clubs")
    .select("id, slug, name, timezone")
    .order("name", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ clubs: data ?? [] });
});

// ─── GET /api/clubs/by-slug/:slug — single club by slug ──────────────────────
// Mounted BEFORE /:id to prevent :id from swallowing this path.

router.get("/by-slug/:slug", async (req, res) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(slug)) {
    res.status(400).json({ error: "Invalid slug format" });
    return;
  }
  const { data, error } = await supabase
    .from("clubs")
    .select("id, slug, name, timezone, scheduled_sync_time, platform")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Club not found", slug });
    return;
  }
  res.json({ club: data });
});

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

router.patch("/:id/settings", async (req, res) => {
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
