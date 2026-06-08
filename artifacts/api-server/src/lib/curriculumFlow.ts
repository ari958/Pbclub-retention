import { supabase } from "./supabaseClient.js";

// ⚠️  SWAP POINT — provisional rung mapping until the Selkirk unified curriculum
// definition is available. Everything rung-related routes through RUNG_CONFIG so
// the real definition can replace this one object without touching detector logic.
//
// When Selkirk's definition lands, update:
//   1. noRungTags   — any event tags that are inclusive and carry no skill signal
//   2. keywordMap   — program_name keyword → canonical level name (most-specific first)
//
// Do NOT scatter rung assumptions into detectors, routes, or the scheduler.
export const RUNG_CONFIG = {
  // Tags present on attendances.level that signal "all skill levels welcome" —
  // they carry no specific rung signal and resolve to null.
  noRungTags: new Set(["All Levels", "All Level"]),

  // Ordered most-specific-first: first matching pattern wins.
  // Patterns are matched case-insensitively against attendance.program_name.
  keywordMap: [
    { pattern: /advanced\s+intermediate/i, level: "Advanced Intermediate" },
    { pattern: /low\s+intermediate/i,      level: "Low Intermediate"      },
    { pattern: /intermediate/i,            level: "Intermediate"          },
    { pattern: /advanced\s+beginner/i,     level: "Advanced Beginner"     },
    { pattern: /beginner/i,               level: "Beginner"              },
  ] as { pattern: RegExp; level: string }[],
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaxonomyEntry = { level: string; rank: number };

export type AttendanceForRung = {
  level: string | null;
  program_name: string | null;
};

export type RungTimelineEntry = {
  attended_at: string;
  level: string;
  rank: number;
  event_id: string | null;
};

// ─── loadTaxonomy ─────────────────────────────────────────────────────────────

// In-module cache keyed by clubId — avoids redundant DB round-trips within a
// single process lifetime. Safe because taxonomy is rarely mutated.
const _taxonomyCache = new Map<string, TaxonomyEntry[]>();

export async function loadTaxonomy(clubId: string): Promise<TaxonomyEntry[]> {
  const hit = _taxonomyCache.get(clubId);
  if (hit) return hit;

  const { data, error } = await supabase
    .from("level_taxonomy")
    .select("level, rank")
    .eq("club_id", clubId)
    .order("rank", { ascending: true });

  if (error) throw new Error(`loadTaxonomy(${clubId}): ${error.message}`);

  const entries: TaxonomyEntry[] = (data ?? []).map((r) => ({
    level: String(r.level),
    rank:  Number(r.rank),
  }));

  _taxonomyCache.set(clubId, entries);
  return entries;
}

// ─── resolveAttendanceRung ────────────────────────────────────────────────────

// Pure — no DB access, no throws.
// Priority:
//   1. attendance.level tag (populated at sync time from extractSkillLevel(event.tags))
//      → if it is a ranked level (not a noRungTag), look it up in taxonomy.
//   2. attendance.program_name keyword match (fallback for events without skill tags).
//   3. null — unresolvable; counts as "no rung signal" and is dropped from timelines.
export function resolveAttendanceRung(
  attendance: AttendanceForRung,
  taxonomy: TaxonomyEntry[]
): TaxonomyEntry | null {
  const byLevel = new Map(taxonomy.map((t) => [t.level, t]));

  // Priority 1 — explicit tag
  try {
    const tag = attendance.level;
    if (tag !== null && tag !== undefined && !RUNG_CONFIG.noRungTags.has(tag)) {
      const entry = byLevel.get(tag);
      if (entry) return entry;
    }
  } catch {
    /* defensive — fall through */
  }

  // Priority 2 — program_name keyword
  try {
    const name = attendance.program_name;
    if (name) {
      for (const { pattern, level } of RUNG_CONFIG.keywordMap) {
        if (pattern.test(name)) {
          const entry = byLevel.get(level);
          if (entry) return entry;
        }
      }
    }
  } catch {
    /* defensive — fall through */
  }

  return null;
}

// ─── buildPlayerRungTimeline ──────────────────────────────────────────────────

// Paginated fetch of all attendances for a player, each resolved to a rung.
// Null-resolved attendances are dropped.  Result is ordered oldest → newest.
export async function buildPlayerRungTimeline(
  playerId: string
): Promise<RungTimelineEntry[]> {
  const { data: playerRow, error: playerErr } = await supabase
    .from("players")
    .select("club_id")
    .eq("id", playerId)
    .maybeSingle();

  if (playerErr) {
    throw new Error(
      `buildPlayerRungTimeline: player lookup failed for ${playerId}: ${playerErr.message}`
    );
  }
  if (!playerRow) {
    throw new Error(`buildPlayerRungTimeline: player ${playerId} not found`);
  }

  const clubId = String(playerRow.club_id);
  const taxonomy = await loadTaxonomy(clubId);

  const PAGE = 1000;
  let offset = 0;
  const timeline: RungTimelineEntry[] = [];

  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("attended_at, level, event_id, program_name")
      .eq("player_id", playerId)
      .order("attended_at", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) {
      throw new Error(
        `buildPlayerRungTimeline: attendances fetch failed for ${playerId}: ${error.message}`
      );
    }

    for (const row of data ?? []) {
      const rung = resolveAttendanceRung(
        {
          level:        row.level        as string | null,
          program_name: row.program_name as string | null,
        },
        taxonomy
      );
      if (rung) {
        timeline.push({
          attended_at: String(row.attended_at),
          level:       rung.level,
          rank:        rung.rank,
          event_id:    row.event_id as string | null,
        });
      }
    }

    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }

  return timeline;
}
