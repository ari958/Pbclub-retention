import { createClient } from "@supabase/supabase-js";

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

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

// ─── Per-club cache ───────────────────────────────────────────────────────────
// Key: clubId (or "default" for backward-compat calls without clubId)

const CACHE_TTL_MS = 10 * 60 * 1000;
const programCache = new Map(); // clubId -> { programs, expiresAt }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSkillLevel(tags) {
  if (!Array.isArray(tags)) return null;
  for (const level of SKILL_LEVEL_TAGS) {
    if (tags.includes(level)) return level;
  }
  return null;
}

function formatProgram(event, webBase) {
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

  // Use timezone from club if needed — for now use the start_time ISO string directly
  const start_time = rawStartTime
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", // still a fallback; proper fix is Step 8 passing tz
        weekday: "long",
        month: "short",
        day: "numeric",
      }).format(new Date(rawStartTime))
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
    signup_url: event.id ? `${webBase}/events/${event.id}` : null,
  };
}

// ─── Resolve club details ──────────────────────────────────────────────────────

async function resolveClubDetails(clubId) {
  if (clubId) {
    const { data } = await getSupabase()
      .from("clubs")
      .select("platform_api_key, platform_subdomain")
      .eq("id", clubId)
      .maybeSingle();
    if (!data?.platform_subdomain) throw new Error(`Club ${clubId} missing platform_subdomain`);
    return {
      apiKey: data.platform_api_key ?? process.env.PODPLAY_API_KEY,
      webBase: `https://${data.platform_subdomain}.podplay.app`,
      apiBase: `https://${data.platform_subdomain}.podplay.app/apis/v2`,
      cacheKey: clubId,
    };
  }

  // Transitional backward compat: agent.ts calls without clubId (Step 8 will fix).
  // Query the first club instead of hardcoding a subdomain.
  const { data } = await getSupabase()
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .limit(1)
    .maybeSingle();
  if (!data?.platform_subdomain) throw new Error("No club platform_subdomain available");
  return {
    apiKey: data.platform_api_key ?? process.env.PODPLAY_API_KEY,
    webBase: `https://${data.platform_subdomain}.podplay.app`,
    apiBase: `https://${data.platform_subdomain}.podplay.app/apis/v2`,
    cacheKey: "default",
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch upcoming programs from PodPlay, formatted for the agent.
 *
 * @param {string|null} clubId  - Club UUID. Required for multi-tenant use.
 *                                Omit only for backward compat (agent.ts, Step 8).
 * @param {boolean} force       - Bypass cache.
 */
export async function fetchAvailablePrograms(clubId = null, force = false) {
  // Handle old single-arg form: fetchAvailablePrograms(true)
  if (typeof clubId === "boolean") {
    force = clubId;
    clubId = null;
  }

  const now = Date.now();
  const { apiKey, webBase, apiBase, cacheKey } = await resolveClubDetails(clubId);

  const cached = programCache.get(cacheKey);
  if (!force && cached && now < cached.expiresAt) {
    return cached.programs;
  }

  const res = await fetch(`${apiBase}/events`, {
    headers: { "x-api-key": apiKey },
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

  const result = deduped.map((e) => formatProgram(e, webBase));

  programCache.set(cacheKey, { programs: result, expiresAt: now + CACHE_TTL_MS });
  return result;
}
