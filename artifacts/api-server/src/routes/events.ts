import { Router, type IRouter } from "express";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { supabase } from "../lib/supabaseClient";

const router: IRouter = Router();

const EXCLUDED_SUBTYPES = new Set([
  "INTERNAL", "OPERATIONS", "PRIVATE", "PRIVATE_EVENT",
]);

interface PodPlayEvent {
  id: string;
  name: string;
  subtype: string;
  status?: string;
  startTime: string;
  admissionRating?: Record<string, unknown> | null;
  admissionRate?: Record<string, unknown> | null;
  tags?: unknown;
}

interface UpcomingEvent {
  id: string;
  name: string;
  subtype: string;
  startTime: string;
  admissionRating: Record<string, unknown> | null;
  admissionRate: Record<string, unknown> | null;
  signupUrl: string | null;
}

// Cache resets on server restart — expected.
let cache: { events: UpcomingEvent[]; fetchedAt: number; clubId: string } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchUpcomingEvents(podplayBase: string, apiKey: string): Promise<UpcomingEvent[]> {
  const headers = { "x-api-key": apiKey };
  const now = new Date();

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10_000);

  let rawEvents: PodPlayEvent[];
  try {
    const res = await fetch(`${podplayBase}/apis/v2/events`, {
      headers,
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    const body = await res.json() as { items?: PodPlayEvent[] };
    rawEvents = body.items ?? [];
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === "AbortError") {
      throw Object.assign(new Error("PodPlay API timed out"), { code: 504 });
    }
    throw Object.assign(
      new Error("Failed to fetch events from PodPlay"),
      { code: 502, details: err?.message }
    );
  }

  const filtered = rawEvents
    .filter((e) => {
      if (e.status && e.status !== "PUBLISHED") return false;
      if (new Date(e.startTime) <= now) return false;
      if (EXCLUDED_SUBTYPES.has(e.subtype)) return false;
      return true;
    })
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .slice(0, 20);

  return filtered.map((event) => ({
    id: event.id,
    name: event.name,
    subtype: event.subtype,
    startTime: event.startTime,
    admissionRating: (event.admissionRating as Record<string, unknown>) ?? null,
    admissionRate: (event.admissionRate as Record<string, unknown>) ?? null,
    signupUrl: `${podplayBase}/community/events/${event.id}`,
  }));
}

// GET /api/events/upcoming
router.get("/events/upcoming", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;

  // Return cache if fresh and for the same club
  if (cache && cache.clubId === clubId && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    res.json(cache.events);
    return;
  }

  try {
    const { data: club, error: clubErr } = await supabase
      .from("clubs")
      .select("platform_api_key, platform_subdomain")
      .eq("id", clubId)
      .maybeSingle();
    if (clubErr || !club) throw Object.assign(new Error(`No club found for id=${clubId}`), { code: 502 });
    if (!club.platform_subdomain) throw Object.assign(new Error(`Club ${clubId} has no platform_subdomain configured`), { code: 502 });
    const apiKey = club.platform_api_key ?? process.env.PODPLAY_API_KEY;
    if (!apiKey) throw Object.assign(new Error(`No API key available for club ${clubId}`), { code: 502 });
    if (!club.platform_api_key) {
      req.log.warn({ clubId }, "Using env-var fallback for PodPlay API key — backfill clubs.platform_api_key");
    }
    const podplayBase = `https://${club.platform_subdomain}.podplay.app`;
    const events = await fetchUpcomingEvents(podplayBase, apiKey);
    cache = { events, fetchedAt: Date.now(), clubId };
    res.json(events);
  } catch (err: any) {
    const status = err.code === 504 ? 504 : 502;
    const payload =
      err.code === 504
        ? { error: "PodPlay API timed out" }
        : { error: "Failed to fetch events from PodPlay", details: err.details ?? err.message };
    res.status(status).json(payload);
  }
});

export default router;
