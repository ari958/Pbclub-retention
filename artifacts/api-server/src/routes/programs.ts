import { Router, type IRouter } from "express";
// @ts-ignore — plain JS module
import { fetchAvailablePrograms } from "../fetchAvailablePrograms.js";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { supabase } from "../lib/supabaseClient";

const router: IRouter = Router();

// ── Legacy: available programs from PodPlay ───────────────────────────────────
router.get("/programs", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;
  try {
    const programs = await fetchAvailablePrograms(clubId);
    res.json({ count: programs.length, programs });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "Failed to fetch available programs");
    res.status(502).json({ error: message });
  }
});

// ── Program catalog: archetypes + latest ratings ───────────────────────────────
//
// GET /api/programs/catalog?clubId=<uuid>
//
// Returns every active archetype for the club, each annotated with the
// latest computed rating slices (daily_peak × season). SELECT-only from
// dashboard; all writes happen via the nightly scheduler.
//
// Response shape:
//   { computed_at: ISO | null, archetypes: CatalogEntry[] }
//
// CatalogEntry:
//   { id, canonical_name, canonical_type, match_priority,
//     overrides_podplay_type, ratings: RatingSlice[] }
//
// RatingSlice:
//   { daily_peak, season, fill_rate, event_count, median_velocity_days,
//     new_player_share, modal_price_regular, modal_price_member, computed_at }

router.get("/programs/catalog", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;

  try {
    // 1. Active archetypes for this club
    const { data: archetypes, error: archErr } = await supabase
      .from("programs")
      .select(
        "id, canonical_name, canonical_type, match_priority, overrides_podplay_type, active",
      )
      .eq("club_id", clubId)
      .eq("active", true)
      .not("canonical_name", "is", null)
      .order("match_priority", { ascending: true });

    if (archErr) {
      req.log.error({ archErr }, "programs/catalog: failed to fetch archetypes");
      return res.status(500).json({ error: archErr.message });
    }

    if (!archetypes?.length) {
      return res.json({ computed_at: null, archetypes: [] });
    }

    const programIds = archetypes.map((a: any) => a.id as string);

    // 2. Latest ratings for these archetypes
    //    program_ratings has UNIQUE(program_id, daily_peak, season) so
    //    each program has at most 4 rows (2 daily_peak × 2 season).
    const { data: ratings, error: ratingErr } = await supabase
      .from("program_ratings")
      .select(
        "program_id, daily_peak, season, fill_rate, event_count, " +
          "median_velocity_days, new_player_share, " +
          "modal_price_regular, modal_price_member, computed_at",
      )
      .eq("club_id", clubId)
      .in("program_id", programIds);

    if (ratingErr) {
      req.log.error({ ratingErr }, "programs/catalog: failed to fetch ratings");
      return res.status(500).json({ error: ratingErr.message });
    }

    // Group ratings by program_id
    const ratingsByProgram = new Map<string, object[]>();
    for (const r of ratings ?? []) {
      const pid = (r as any).program_id as string;
      if (!ratingsByProgram.has(pid)) ratingsByProgram.set(pid, []);
      ratingsByProgram.get(pid)!.push(r);
    }

    // Latest computed_at across all rating rows (for the response envelope)
    let latestComputedAt: string | null = null;
    for (const r of ratings ?? []) {
      const ca = (r as any).computed_at as string | null;
      if (ca && (!latestComputedAt || ca > latestComputedAt)) {
        latestComputedAt = ca;
      }
    }

    // 3. Assemble response
    const catalog = (archetypes as any[]).map((arch) => ({
      id: arch.id,
      canonical_name: arch.canonical_name,
      canonical_type: arch.canonical_type,
      match_priority: arch.match_priority,
      overrides_podplay_type: arch.overrides_podplay_type,
      ratings: (ratingsByProgram.get(arch.id) ?? []).map((r: any) => ({
        daily_peak: r.daily_peak,
        season: r.season,
        fill_rate: r.fill_rate,
        event_count: r.event_count,
        median_velocity_days: r.median_velocity_days,
        new_player_share: r.new_player_share,
        modal_price_regular: r.modal_price_regular,
        modal_price_member: r.modal_price_member,
        computed_at: r.computed_at,
      })),
    }));

    return res.json({ computed_at: latestComputedAt, archetypes: catalog });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "programs/catalog: unexpected error");
    return res.status(500).json({ error: message });
  }
});

export default router;
