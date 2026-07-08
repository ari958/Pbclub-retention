import { Router, type IRouter } from "express";
// @ts-ignore — plain JS module
import { fetchAvailablePrograms } from "../fetchAvailablePrograms.js";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { supabase } from "../lib/supabaseClient";
import { computeProgramRatingsForWindow, fetchVariantsForClub } from "../lib/programRatings";

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

const VALID_DAYS = new Set([7, 30, 90]);

router.get("/programs/catalog", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;

  try {
    // ── Windowed path: ?days=7|30|90 → live computation from event_fill ─────
    const daysRaw = req.query.days;
    if (daysRaw !== undefined) {
      const days = parseInt(daysRaw as string, 10);
      if (!VALID_DAYS.has(days)) {
        return res.status(400).json({ error: "days must be 7, 30, or 90" });
      }
      const result = await computeProgramRatingsForWindow(clubId, days);
      return res.json(result);
    }

    // ── Default path: precomputed program_ratings ─────────────────────────
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

    // 2. Latest ratings — collapse season → 2 rows per archetype (daily_peak only)
    //    program_ratings stores up to 4 rows per archetype (daily_peak × season).
    //    We merge peak + off_peak season into one row per daily_peak value,
    //    using weighted-average fill_rate and summed event_count.
    const { data: ratings, error: ratingErr } = await supabase
      .from("program_ratings")
      .select(
        "program_id, daily_peak, season, fill_rate, event_count, " +
          "median_velocity_days, new_player_share, computed_at",
      )
      .eq("club_id", clubId)
      .in("program_id", programIds);

    if (ratingErr) {
      req.log.error({ ratingErr }, "programs/catalog: failed to fetch ratings");
      return res.status(500).json({ error: ratingErr.message });
    }

    // Merge season rows: key = `${program_id}|${daily_peak}`
    interface MergedSlot {
      fill_rate: number | null;
      event_count: number;
      median_velocity_days: number | null;
      new_player_share: number | null;
      computed_at: string | null;
    }
    const merged = new Map<string, MergedSlot>();
    let latestComputedAt: string | null = null;

    for (const r of ratings ?? []) {
      const key = `${(r as any).program_id}|${(r as any).daily_peak}`;
      const n2   = (r as any).event_count as number ?? 0;
      const fill2  = (r as any).fill_rate  as number | null;
      const vel2   = (r as any).median_velocity_days as number | null;
      const share2 = (r as any).new_player_share     as number | null;
      const ca     = (r as any).computed_at as string | null;
      if (ca && (!latestComputedAt || ca > latestComputedAt)) latestComputedAt = ca;

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { fill_rate: fill2, event_count: n2, median_velocity_days: vel2, new_player_share: share2, computed_at: ca });
      } else {
        const n1    = existing.event_count;
        const total = n1 + n2;
        existing.event_count = total;
        // Weighted-average fill_rate
        if (existing.fill_rate !== null && fill2 !== null)
          existing.fill_rate = Math.round(((existing.fill_rate * n1 + fill2 * n2) / total) * 1000) / 1000;
        else if (fill2 !== null)
          existing.fill_rate = fill2;
        // Velocity — take the season with more events (medians can't be properly weighted)
        if (vel2 !== null && (existing.median_velocity_days === null || n2 > n1))
          existing.median_velocity_days = vel2;
        // new_player_share — weighted average
        if (existing.new_player_share !== null && share2 !== null)
          existing.new_player_share = Math.round(((existing.new_player_share * n1 + share2 * n2) / total) * 1000) / 1000;
        else if (share2 !== null)
          existing.new_player_share = share2;
      }
    }

    // 3. Variants from event_fill (all-time, no cutoff for precomputed path)
    const variantMap = await fetchVariantsForClub(clubId);

    // 4. Assemble response
    const catalog = (archetypes as any[]).map((arch) => {
      const pid = arch.id as string;
      const archRatings: object[] = [];
      for (const dp of [true, false]) {
        const slot = merged.get(`${pid}|${dp}`);
        if (slot) {
          archRatings.push({
            daily_peak:            dp,
            fill_rate:             slot.fill_rate,
            event_count:           slot.event_count,
            median_velocity_days:  slot.median_velocity_days,
            new_player_share:      slot.new_player_share,
          });
        }
      }
      return {
        id:                   arch.id,
        canonical_name:       arch.canonical_name,
        canonical_type:       arch.canonical_type,
        match_priority:       arch.match_priority,
        overrides_podplay_type: arch.overrides_podplay_type,
        ratings:  archRatings,
        variants: variantMap.get(pid) ?? [],
      };
    });

    return res.json({ computed_at: latestComputedAt, archetypes: catalog });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err }, "programs/catalog: unexpected error");
    return res.status(500).json({ error: message });
  }
});

export default router;
