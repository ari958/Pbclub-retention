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

// ─── Cache ────────────────────────────────────────────────────────────────────
// Prevents one PodPlay API call per player during batch agent runs.
// Cache TTL: 10 minutes — programs don't change that fast.

const CACHE_TTL_MS = 10 * 60 * 1000;
let cachedPrograms = null;
let cacheExpiresAt = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSkillLevel(tags) {
  if (!Array.isArray(tags)) return null;
  for (const level of SKILL_LEVEL_TAGS) {
    if (tags.includes(level)) return level;
  }
  return null;
}

const ET_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "long",
  month: "short",
  day: "numeric",
});

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
  const rawStartTime = event.startTime ?? null;
  const start_time = rawStartTime
    ? ET_DATE_FMT.format(new Date(rawStartTime))
    : null;
  return {
    name: event.name,
    description: event.description?.trim() || null,
    program_type: event.customType ?? event.type ?? null,
    price,
    price_member,
    skill_level: extractSkillLevel(tags),
    tags,
    spots_remaining,
    start_time,
    start_time_iso: event.startTime ?? null,
    signup_url: event.id ? `${PODPLAY_WEB_BASE}/events/${event.id}` : null,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch upcoming programs from PodPlay, formatted for the agent.
 * Results are cached for 10 minutes — safe to call once per agent run
 * in a batch of 50 players without hammering the PodPlay API.
 *
 * Pass force=true to bypass the cache (e.g. in tests).
 */
export async function fetchAvailablePrograms(force = false) {
  const now = Date.now();

  // Return cached result if still valid
  if (!force && cachedPrograms !== null && now < cacheExpiresAt) {
    return cachedPrograms;
  }

  const res = await fetch(`${PODPLAY_BASE}/events`, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`PodPlay /events returned ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const events = data.items ?? [];
  const nowDate = new Date();

  const upcoming = events.filter((e) => {
    if (e.isCanceled) return false;
    if (e.status !== "PUBLISHED") return false;
    if (new Date(e.startTime) <= nowDate) return false;
    const programType = e.customType ?? e.type ?? null;
    if (programType && EXCLUDED_PROGRAM_TYPES.has(programType)) return false;
    const description = e.description?.trim();
    if (!description) return false;
    if (e.name?.includes("AJ's Wicked Wednesday")) return false;
    return true;
  });

  upcoming.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  const seen = new Set();
  const deduped = [];
  for (const e of upcoming) {
    if (!seen.has(e.name)) {
      seen.add(e.name);
      deduped.push(e);
    }
  }

  const result = deduped.map(formatProgram);

  // Store in cache
  cachedPrograms = result;
  cacheExpiresAt = now + CACHE_TTL_MS;

  return result;
}
