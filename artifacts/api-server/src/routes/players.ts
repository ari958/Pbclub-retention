import { Router, type IRouter } from "express";
import { z } from "zod";
// @ts-ignore — plain JS module
import { assembleProfile } from "../assembleProfile.js";
import { computeLevelConfidence } from "../lib/levelConfidence";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";

const router: IRouter = Router();

// ─── Cross-tenant guard ───────────────────────────────────────────────────────

async function verifyPlayerBelongsToClub(
  playerId: string,
  clubId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("players")
    .select("id")
    .eq("id", playerId)
    .eq("club_id", clubId)
    .maybeSingle();
  return !!data;
}

// ─── GET /api/players — paginated list for the active club ───────────────────

router.get("/players", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const limit = Math.min(Number(req.query.limit) || 1000, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const { data, error } = await supabase
    .from("players")
    .select(
      "id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id, sms_opt_in, dupr_rating, churn_risk, churn_score"
    )
    .eq("club_id", clubId)
    .order("name")
    .range(offset, offset + limit - 1);

  if (error) {
    req.log.error({ error }, "GET /players list failed");
    res.status(500).json({ error: "Failed to fetch players" });
    return;
  }

  res.json({ players: data ?? [], total: (data ?? []).length, offset, limit });
});

// ─── GET /api/players/:id/profile ────────────────────────────────────────────

router.get("/players/:id/profile", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const belongs = await verifyPlayerBelongsToClub(req.params.id as string, clubId);
  if (!belongs) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
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

router.post("/players/:id/progression", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const belongs = await verifyPlayerBelongsToClub(req.params.id as string, clubId);
  if (!belongs) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

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
  coach_assigned_level: z.string().min(1).nullable(),
  coach_level_notes: z.string().optional(),
  coach_level_set_by: z.string().optional(),
});

router.patch("/players/:id/coach-level", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const belongs = await verifyPlayerBelongsToClub(req.params.id as string, clubId);
  if (!belongs) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const parsed = CoachLevelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { coach_assigned_level, coach_level_notes, coach_level_set_by } = parsed.data;

  if (coach_assigned_level !== null) {
    const { data: taxRow } = await supabase
      .from("level_taxonomy")
      .select("level")
      .eq("level", coach_assigned_level)
      .eq("club_id", clubId)
      .maybeSingle();

    if (!taxRow) {
      res.status(400).json({ error: `Level "${coach_assigned_level}" not found in level_taxonomy for this club` });
      return;
    }
  }

  const { data: updated, error } = await supabase
    .from("players")
    .update({
      coach_assigned_level,
      coach_level_notes: coach_level_notes ?? null,
      coach_level_set_by: coach_level_set_by ?? null,
      coach_level_set_at: coach_assigned_level !== null ? new Date().toISOString() : null,
    })
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  computeLevelConfidence(req.params.id as string).catch(() => {});

  const { data: confidence } = await supabase
    .from("level_confidence")
    .select("level, score, certainty, sessions, peer_positive, peer_total, last_computed")
    .eq("player_id", req.params.id);

  res.json({ player: updated, level_confidence: confidence ?? [] });
});

// ─── PATCH /api/players/:id/notes ────────────────────────────────────────────

const NotesSchema = z.object({
  notes: z.string().nullable(),
});

router.patch("/players/:id/notes", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const belongs = await verifyPlayerBelongsToClub(req.params.id as string, clubId);
  if (!belongs) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const parsed = NotesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  const { error } = await supabase
    .from("players")
    .update({ notes: parsed.data.notes })
    .eq("id", req.params.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ updated: true });
});

// ─── PATCH /api/players/:id/coach-level-notes ─────────────────────────────────

const CoachLevelNotesSchema = z.object({
  coach_level_notes: z.string().nullable(),
});

router.patch("/players/:id/coach-level-notes", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const belongs = await verifyPlayerBelongsToClub(req.params.id as string, clubId);
  if (!belongs) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const parsed = CoachLevelNotesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }

  const { error } = await supabase
    .from("players")
    .update({ coach_level_notes: parsed.data.coach_level_notes })
    .eq("id", req.params.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ updated: true });
});

// ─── GET /api/players/:id/confidence ─────────────────────────────────────────

router.get("/players/:id/confidence", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const belongs = await verifyPlayerBelongsToClub(req.params.id as string, clubId);
  if (!belongs) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const { data: confidence, error } = await supabase
    .from("level_confidence")
    .select("level, score, certainty, sessions, peer_positive, peer_total, last_computed")
    .eq("player_id", req.params.id)
    .order("score", { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const { data: taxonomy } = await supabase
    .from("level_taxonomy")
    .select("level, rank")
    .eq("club_id", clubId)
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

router.patch("/players/:id", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  const belongs = await verifyPlayerBelongsToClub(req.params.id as string, clubId);
  if (!belongs) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

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

  computeLevelConfidence(req.params.id as string).catch(() => {});

  res.json(updated);
});

// ─── GET /api/players/winback-stats ──────────────────────────────────────────

router.get("/players/winback-stats", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

    const [conversionsRes, totalSentRes] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("club_id", clubId)
        .eq("direction", "outbound")
        .eq("status", "sent")
        .not("converted_at", "is", null)
        .gte("created_at", thirtyDaysAgo),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("club_id", clubId)
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
  } catch (_err: unknown) {
    res.json({
      period_days: 30,
      messages_sent: 0,
      conversions: 0,
      conversion_rate_pct: null,
    });
  }
});

export default router;
