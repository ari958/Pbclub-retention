/**
 * classifyEvent — pure event-to-archetype classifier.
 *
 * Archetypes are loaded from the programs table (match_rules JSONB).
 * classifyEvent() is a pure function: no DB access, fully testable.
 *
 * Match rules (per programs row):
 *   keywords              string[]  — any must appear in lowercased event name (substring)
 *                                    empty array = catch-all (matches any event of right type)
 *   require_podplay_types string[]  — event's podplay type must be in this list
 *                                    empty array = matches any type (used by 60&60 override)
 *
 * Priority: archetypes sorted ascending by match_priority; first match wins.
 *
 * Exclusions: Private Event / Co-Working / Kids Class / Leagues / Tournaments
 * are rejected before archetype matching. A small set of one-time special
 * event names are also excluded by keyword.
 */

import { supabase } from "./supabaseClient";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MatchRules {
  keywords: string[];
  require_podplay_types: string[];
}

export interface Archetype {
  id: string;
  canonical_name: string;
  canonical_type: "open_play" | "clinic";
  match_priority: number;
  overrides_podplay_type: boolean;
  match_rules: MatchRules;
}

export interface EventInput {
  name: string;
  podplayType: string;
  tags?: string[];
  startTime?: string;
}

export interface ClassifyResult {
  archetypeId: string;
  archetypeName: string;
  canonicalType: "open_play" | "clinic";
  isExcluded: false;
  reason: string;
}

export interface ExcludeResult {
  archetypeId: null;
  archetypeName: null;
  canonicalType: null;
  isExcluded: true;
  reason: string;
}

export type Classification = ClassifyResult | ExcludeResult;

// ── Exclusion rules ───────────────────────────────────────────────────────────

const EXCLUDED_TYPES = new Set([
  "Private Event",
  "Co-Working",
  "Kids Class",
  "Leagues",
  "Tournaments",
  "Party",
]);

// One-time special events that are typed "Open Play" but are not programs
const EXCLUDED_NAME_SUBSTRINGS = [
  "grand opening",
  "new years eve party",
  "special event night @ pb club",
  "test session",
  "dupr open play test",
];

// ── Peak / season / level helpers ─────────────────────────────────────────────

export const TIMEZONE = "America/New_York";
export const PEAK_MONTHS = new Set([10, 11, 12, 1, 2, 3]);
const LEVEL_TAGS = [
  "Beginner",
  "Advanced Beginner",
  "Intermediate",
  "Advanced Intermediate",
  "Advanced",
  "All Levels",
  "All Level",
];

function tzParts(
  iso: string,
  opts: Intl.DateTimeFormatOptions,
): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, ...opts })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
}

export function isDailyPeak(startTime: string): boolean {
  const p = tzParts(startTime, { weekday: "short", hour: "numeric", hour12: false });
  if (p.weekday === "Sat" || p.weekday === "Sun") return true;
  const h = parseInt(p.hour, 10);
  return h >= 18 && h <= 21;
}

export function isPeakSeason(startTime: string): boolean {
  const p = tzParts(startTime, { month: "numeric" });
  return PEAK_MONTHS.has(parseInt(p.month, 10));
}

export function getLevelFromTags(tags: string[]): string | null {
  for (const t of LEVEL_TAGS) {
    if (tags.includes(t)) return t === "All Level" ? "All Levels" : t;
  }
  return null;
}

// ── Core classifier (pure function) ──────────────────────────────────────────

/**
 * Classify a single event against a sorted list of archetypes.
 * Archetypes MUST be pre-sorted by match_priority ascending.
 */
export function classifyEvent(
  event: EventInput,
  archetypes: Archetype[],
): Classification {
  const name = event.name ?? "";
  const nameLow = name.toLowerCase();
  const podplayType = event.podplayType ?? "";

  // 1. Excluded by type
  if (EXCLUDED_TYPES.has(podplayType)) {
    return {
      archetypeId: null,
      archetypeName: null,
      canonicalType: null,
      isExcluded: true,
      reason: `excluded type: ${podplayType}`,
    };
  }

  // 2. Excluded by name keyword
  for (const sub of EXCLUDED_NAME_SUBSTRINGS) {
    if (nameLow.includes(sub)) {
      return {
        archetypeId: null,
        archetypeName: null,
        canonicalType: null,
        isExcluded: true,
        reason: `excluded event name: matched "${sub}"`,
      };
    }
  }

  // 3. Match against archetypes (sorted by priority asc)
  for (const arch of archetypes) {
    const rules = arch.match_rules;
    const typeOk =
      arch.overrides_podplay_type ||
      rules.require_podplay_types.length === 0 ||
      rules.require_podplay_types.includes(podplayType);
    if (!typeOk) continue;

    const keywordOk =
      rules.keywords.length === 0 ||
      rules.keywords.some((kw) => nameLow.includes(kw.toLowerCase()));
    if (!keywordOk) continue;

    return {
      archetypeId: arch.id,
      archetypeName: arch.canonical_name,
      canonicalType: arch.canonical_type,
      isExcluded: false,
      reason: `matched archetype "${arch.canonical_name}" (priority ${arch.match_priority})`,
    };
  }

  // 4. No match
  return {
    archetypeId: null,
    archetypeName: null,
    canonicalType: null,
    isExcluded: true,
    reason: `no matching archetype for name="${name}" type="${podplayType}"`,
  };
}

// ── DB loader ─────────────────────────────────────────────────────────────────

export async function loadArchetypes(clubId: string): Promise<Archetype[]> {
  const { data, error } = await supabase
    .from("programs")
    .select(
      "id, canonical_name, canonical_type, match_priority, overrides_podplay_type, match_rules",
    )
    .eq("club_id", clubId)
    .eq("active", true)
    .not("canonical_name", "is", null)
    .order("match_priority", { ascending: true });

  if (error) throw new Error(`loadArchetypes: ${error.message}`);
  if (!data?.length) throw new Error(`loadArchetypes: no active archetypes for club ${clubId}`);

  return data.map((row: any) => ({
    id: row.id as string,
    canonical_name: row.canonical_name as string,
    canonical_type: row.canonical_type as "open_play" | "clinic",
    match_priority: row.match_priority as number,
    overrides_podplay_type: row.overrides_podplay_type as boolean,
    match_rules: row.match_rules as MatchRules,
  }));
}
