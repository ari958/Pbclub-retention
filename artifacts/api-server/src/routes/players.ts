import { Router, type IRouter } from "express";
import { z } from "zod";
// @ts-ignore — plain JS module
import { assembleProfile } from "../assembleProfile.js";
import { computeLevelConfidence } from "../lib/levelConfidence";
import { supabase } from "../lib/supabaseClient";

const router: IRouter = Router();

// ─── GET /api/players/:id/profile ────────────────────────────────────────────

router.get("/players/:id/profile", async (req, res) => {
  try {
    const data = await assembleProfile(req.params.id);
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const supabaseError = (err as any)?.supabaseError;
    req.log.error(
      {
        err,
        supabase: supabaseError
          ? {
              message: supabaseError.message,
              code: supabaseError.code,
              hint: supabaseError.hint,
              details: supabaseError.details,
            }
          : undefined,
      },
      "Failed to assemble player profile",
    );
    if (
      supabaseError?.code === "PGRST116" ||
      message.includes("JSON object requested, multiple (or no) rows returned")
    ) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    res.status(500).json({ error: message });
  }
});

// ─── POST /api/players/:id/progression ───────────────────────────────────────

router.post("/players/:id/progression", async (req, res) => {
  const { status, assessed_by } = req.body as {
    status: string | null;
    assessed_by?: string;
  };

  const validStatuses = ["ready-to-advance", "developing", "at-ceiling", null];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: "Invalid progression status" });
    return;
  }

  const { data: current } = await supabase
    .from("players")
    .select("progression_status")
    .eq("id", req.params.id)
    .single();

  const { error } = await supabase
    .from("players")
    .update({
      progression_status: status,
      progression_previous: current?.progression_status ?? null,
      progression_assessed_at: new Date().toISOString(),
      progression_assessed_by: assessed_by ?? "operator",
    })
    .eq("id", req.params.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ updated: true, previous: current?.progression_status, current: status });
});

// ─── PATCH /api/players/:id/coach-level ──────────────────────────────────────

const CoachLevelSchema = z.object({
  coach_assigned_level: z.string().min(1),
  coach_level_notes: z.string().optional(),
  coach_level_set_by: z.string().optional(),
});

router.patch("/players/:id/coach-level", async (req, res) => {
  const parsed = CoachLevelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { coach_assigned_level, coach_level_notes, coach_level_set_by } = parsed.data;

  // Validate level exists in taxonomy for this club
  const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
  const { data: taxRow } = await supabase
    .from("level_taxonomy")
    .select("level")
    .eq("level", coach_assigned_level)
    .eq("club_id", CLUB_ID)
    .maybeSingle();

  if (!taxRow) {
    res.status(400).json({ error: `Level "${coach_assigned_level}" not found in level_taxonomy for this club` });
    return;
  }

  const { data: updated, error } = await supabase
    .from("players")
    .update({
      coach_assigned_level,
      coach_level_notes: coach_level_notes ?? null,
      coach_level_set_by: coach_level_set_by ?? null,
      coach_level_set_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Recompute confidence for all levels this player has attended
  computeLevelConfidence(req.params.id).catch(() => {});

  // Return updated player + fresh confidence rows
  const { data: confidence } = await supabase
    .from("level_confidence")
    .select("level, score, certainty, sessions, peer_positive, peer_total, last_computed")
    .eq("player_id", req.params.id);

  res.json({ player: updated, level_confidence: confidence ?? [] });
});

// ─── GET /api/players/:id/confidence ─────────────────────────────────────────

router.get("/players/:id/confidence", async (req, res) => {
  const { data: confidence, error } = await supabase
    .from("level_confidence")
    .select("level, score, certainty, sessions, peer_positive, peer_total, last_computed")
    .eq("player_id", req.params.id)
    .order("score", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Fetch taxonomy for rank ordering (scoped to this club)
  const { data: taxonomy } = await supabase
    .from("level_taxonomy")
    .select("level, rank")
    .eq("club_id", "c8976e15-e002-4619-bb4b-b1a70f5cd7ab")
    .order("rank", { ascending: true });

  const taxMap = new Map<string, number>(
    (taxonomy ?? []).map((t: any) => [t.level as string, t.rank as number])
  );

  const sorted = (confidence ?? []).sort((a: any, b: any) => {
    const ra = taxMap.get(a.level) ?? 999;
    const rb = taxMap.get(b.level) ?? 999;
    return ra - rb;
  });

  res.json(sorted);
});

// ─── PATCH /api/players/:id — generic field update (DUPR etc.) ───────────────

const PlayerPatchSchema = z.object({
  dupr_rating: z.number().min(1).max(6).optional(),
}).passthrough();

router.patch("/players/:id", async (req, res) => {
  const parsed = PlayerPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.dupr_rating !== undefined) {
    updates.dupr_rating = parsed.data.dupr_rating;
    updates.dupr_updated_at = new Date().toISOString();
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No recognised fields to update" });
    return;
  }

  const { data: updated, error } = await supabase
    .from("players")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Recompute confidence after DUPR change
  computeLevelConfidence(req.params.id).catch(() => {});

  res.json(updated);
});

// ─── GET /api/players/winback-stats ──────────────────────────────────────────
// Wrapped in try/catch so a missing column or empty data never crashes the dashboard

router.get("/players/winback-stats", async (_req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

    const [conversionsRes, totalSentRes] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .eq("status", "sent")
        .not("converted_at", "is", null)
        .gte("created_at", thirtyDaysAgo),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .eq("status", "sent")
        .gte("created_at", thirtyDaysAgo),
    ]);

    const converted = conversionsRes.count ?? 0;
    const totalSent = totalSentRes.count ?? 0;
    const conversionRate =
      totalSent > 0 ? Math.round((converted / totalSent) * 100) : null;

    res.json({
      period_days: 30,
      messages_sent: totalSent,
      conversions: converted,
      conversion_rate_pct: conversionRate,
    });
  } catch (err: unknown) {
    // Never let this endpoint crash the dashboard — return null stats
    res.json({
      period_days: 30,
      messages_sent: 0,
      conversions: 0,
      conversion_rate_pct: null,
    });
  }
});

export default router;
