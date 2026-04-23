const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";
const PODPLAY_WEB_BASE = "https://pbclub.podplay.app";

const EXCLUDED_PROGRAM_TYPES = new Set(["Private Event", "Private", "Tournaments"]);

const SKILL_LEVEL_TAGS = [
  "Beginner",
  "Advanced Beginner",
  "Low Intermediate",
  "Intermediate",
  "Advanced Intermediate",
  "All Levels",
  "All Level",
];

/**
 * Extract a skill level from a tags array by matching against known level keywords.
 * @param {string[]} tags
 * @returns {string|null}
 */
function extractSkillLevel(tags) {
  if (!Array.isArray(tags)) return null;
  for (const level of SKILL_LEVEL_TAGS) {
    if (tags.includes(level)) return level;
  }
  return null;
}

/**
 * Format a raw PodPlay event into the available_programs shape the agent expects.
 * @param {object} event
 * @returns {object}
 */
function formatProgram(event) {
  const rate = event.admissionRate;
  const price =
    rate && typeof rate === "object"
      ? (rate.regular ?? rate.member ?? null)
      : null;
  const price_member =
    rate && typeof rate === "object" ? (rate.member ?? null) : null;

  const capacity = event.guests?.max ?? null;
  const currentSignups = event.signups?._total ?? 0;
  const spots_remaining =
    capacity != null && capacity > 0 ? Math.max(0, capacity - currentSignups) : null;

  const tags = Array.isArray(event.tags) ? event.tags : [];

  return {
    name: event.name,
    description: event.description?.trim() || null,
    program_type: event.customType ?? event.type ?? null,
    price,
    price_member,
    skill_level: extractSkillLevel(tags),
    tags,
    spots_remaining,
    start_time: event.startTime ?? null,
    signup_url: event.id ? `${PODPLAY_WEB_BASE}/events/${event.id}` : null,
  };
}

/**
 * Fetch upcoming events from PodPlay and return them formatted
 * as the available_programs array the agent expects.
 *
 * Filters to events that:
 * - Start in the future (startTime > now)
 * - Are not cancelled
 * - Have a PUBLISHED status
 * - Are not Private Event, Private, or Tournaments program types
 * - Have a non-empty description
 * - Do not contain "AJ's Wicked Wednesday" in the name
 *
 * Deduplicates by program name, keeping the earliest upcoming instance.
 *
 * @returns {Promise<Array<{name: string, description: string|null, program_type: string|null, price: number|null, price_member: number|null, skill_level: string|null, tags: string[], spots_remaining: number|null, start_time: string|null}>>}
 */
export async function fetchAvailablePrograms() {
  const res = await fetch(`${PODPLAY_BASE}/events`, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`PodPlay /events returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const events = data.items ?? [];

  const now = new Date();

  const upcoming = events.filter((e) => {
    if (e.isCanceled) return false;
    if (e.status !== "PUBLISHED") return false;
    if (new Date(e.startTime) <= now) return false;

    const programType = e.customType ?? e.type ?? null;
    if (programType && EXCLUDED_PROGRAM_TYPES.has(programType)) return false;

    const description = e.description?.trim();
    if (!description) return false;

    if (e.name?.includes("AJ's Wicked Wednesday")) return false;

    return true;
  });

  // Sort by startTime ascending so earliest instance comes first
  upcoming.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  // Deduplicate by name — keep only the earliest upcoming instance
  const seen = new Set();
  const deduped = [];
  for (const e of upcoming) {
    if (!seen.has(e.name)) {
      seen.add(e.name);
      deduped.push(e);
    }
  }

  return deduped.map(formatProgram);
}
