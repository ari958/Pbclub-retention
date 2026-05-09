import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabaseClient";
import { extractSkillLevel } from "../lib/skillLevel";
import { logger } from "../lib/logger";
import { getPlayerSocialContext, computeBuddyPairs } from "../lib/socialGraph";

const router: IRouter = Router();
const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── PodPlay helpers ──────────────────────────────────────────────────────────

async function fetchUpcomingEvents(daysAhead = 7): Promise<any[]> {
  const now = new Date().toISOString();
  const end = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const url = `${PODPLAY_BASE}/events?startTime=${encodeURIComponent(now)}&endTime=${encodeURIComponent(end)}&ipp=100`;
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY ?? "" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`PodPlay /events returned ${res.status}`);
  const data = await res.json() as any;
  return (data.items ?? []).filter((e: any) => {
    if (e.isCanceled) return false;
    if (e.status !== "PUBLISHED") return false;
    return true;
  });
}

async function fetchEventSignupsRaw(eventId: string): Promise<string[]> {
  const url = `${PODPLAY_BASE}/events/${eventId}/signups`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": process.env.PODPLAY_API_KEY ?? "" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return [];
  }
  if (res.status === 404) return [];
  if (res.status === 429) {
    await sleep(3_000);
    try {
      const retry = await fetch(url, { headers: { "x-api-key": process.env.PODPLAY_API_KEY ?? "" } });
      if (!retry.ok) return [];
      const d = await retry.json() as any;
      return (d.items ?? []).map((s: any) => s.owner?.id).filter(Boolean) as string[];
    } catch {
      return [];
    }
  }
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data.items ?? []).map((s: any) => s.owner?.id).filter(Boolean) as string[];
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

type PlayerRow = { id: string; external_id: string; name: string };

async function loadPlayerMap(): Promise<Map<string, PlayerRow>> {
  const map = new Map<string, PlayerRow>();
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, external_id, name")
      .not("external_id", "is", null)
      .range(offset, offset + 999);
    if (error) throw new Error(`Failed to load players: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const p of data as PlayerRow[]) map.set(p.external_id, p);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return map;
}

// ─── Route A: POST /api/social-graph/compute-buddy-pairs ─────────────────────

router.post("/social-graph/compute-buddy-pairs", async (req, res) => {
  try {
    const result = await computeBuddyPairs({ logger: req.log });
    res.json(result.details);
  } catch (err: any) {
    req.log.error({ err: err.message }, "[social-graph] compute-buddy-pairs error");
    res.status(500).json({ error: err.message });
  }
});

// ─── Route B: GET /api/social-graph/player/:id/buddies ───────────────────────

router.get("/social-graph/player/:id/buddies", async (req, res) => {
  try {
    const social = await getPlayerSocialContext(req.params.id, { logger: req.log });
    res.json({ buddies: social.buddies });
  } catch (err: any) {
    req.log.error({ err: err.message }, "[social-graph] buddies error");
    res.status(500).json({ error: err.message });
  }
});

// ─── Route C: GET /api/social-graph/upcoming-with-buddies/:id ────────────────

router.get("/social-graph/upcoming-with-buddies/:id", async (req, res) => {
  try {
    const social = await getPlayerSocialContext(req.params.id, { logger: req.log });
    res.json({ upcoming: social.upcoming });
  } catch (err: any) {
    req.log.error({ err: err.message }, "[social-graph] upcoming-with-buddies error");
    res.status(500).json({ error: err.message });
  }
});

// ─── Route D: GET /api/social-graph/staff-intro-cards ────────────────────────

router.get("/social-graph/staff-intro-cards", async (req, res) => {
  try {
    const playerMap = await loadPlayerMap();
    const playerById = new Map<string, PlayerRow>();
    for (const p of playerMap.values()) playerById.set(p.id, p);

    const events = await fetchUpcomingEvents(7);

    type EventBundle = { event: any; attendeePlayerIds: string[] };
    const bundles: EventBundle[] = [];

    for (const event of events) {
      await sleep(250);
      const externalIds = await fetchEventSignupsRaw(event.id);
      const attendeePlayerIds = externalIds
        .map((eid) => playerMap.get(eid)?.id)
        .filter(Boolean) as string[];
      bundles.push({ event, attendeePlayerIds });
    }

    const allAttendeeIds = [...new Set(bundles.flatMap((b) => b.attendeePlayerIds))];
    const visitCountMap = new Map<string, number>();
    if (allAttendeeIds.length > 0) {
      for (let i = 0; i < allAttendeeIds.length; i += 100) {  // 100 max — Supabase GET URL limit ~18KB
        const chunk = allAttendeeIds.slice(i, i + 100);
        const { data: attRows } = await supabase
          .from("attendances")
          .select("player_id")
          .in("player_id", chunk);
        for (const row of (attRows ?? []) as { player_id: string }[]) {
          visitCountMap.set(row.player_id, (visitCountMap.get(row.player_id) ?? 0) + 1);
        }
      }
    }

    const cards: object[] = [];
    for (const { event, attendeePlayerIds } of bundles) {
      const newPlayers: object[] = [];

      for (const playerId of attendeePlayerIds) {
        const visitCount = visitCountMap.get(playerId) ?? 0;
        if (visitCount > 3) continue;

        const { data: pairs } = await supabase
          .from("buddy_pairs")
          .select("player_a, player_b, shared_sessions")
          .or(`player_a.eq.${playerId},player_b.eq.${playerId}`);

        const buddyConnections: object[] = [];
        for (const pair of (pairs ?? []) as any[]) {
          const buddyId = pair.player_a === playerId ? pair.player_b : pair.player_a;
          if (attendeePlayerIds.includes(buddyId)) {
            const buddy = playerById.get(buddyId);
            if (buddy) {
              buddyConnections.push({
                player_id: buddyId,
                name: buddy.name,
                shared_sessions: pair.shared_sessions,
              });
            }
          }
        }

        const player = playerById.get(playerId);
        if (player) {
          newPlayers.push({
            player_id: playerId,
            name: player.name,
            visit_count: visitCount,
            buddy_connections: buddyConnections,
          });
        }
      }

      if (newPlayers.length > 0) {
        cards.push({
          event_id: event.id,
          program_name: event.name,
          level: extractSkillLevel(event.tags),
          start_time: event.startTime,
          new_players: newPlayers,
        });
      }
    }

    (cards as any[]).sort(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    );

    res.json({ cards });
  } catch (err: any) {
    req.log.error({ err: err.message }, "[social-graph] staff-intro-cards error");
    res.status(500).json({ error: err.message });
  }
});

// ─── Route F: GET /api/social-graph/player/:id/registrations ─────────────────

router.get("/social-graph/player/:id/registrations", async (req, res) => {
  try {
    const social = await getPlayerSocialContext(req.params.id, { logger: req.log });
    res.json({ registrations: social.registrations });
  } catch (err: any) {
    req.log.error({ err: err.message }, "[social-graph] player-registrations error");
    res.status(500).json({ error: err.message });
  }
});

// ─── Route G: POST /api/social-graph/test/player-registrations/:id ───────────

router.post("/social-graph/test/player-registrations/:id", async (req, res) => {
  const port = process.env.PORT ?? "8080";
  const { id } = req.params;
  try {
    const result = await fetch(
      `http://localhost:${port}/api/social-graph/player/${id}/registrations`,
      { signal: AbortSignal.timeout(30_000) }
    );
    const data = await result.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route E: POST /api/social-graph/test/compute-now ────────────────────────

router.post("/social-graph/test/compute-now", async (req, res) => {
  try {
    const result = await computeBuddyPairs({ logger: req.log });
    res.json(result.details);
  } catch (err: any) {
    req.log.error({ err: err.message }, "[social-graph] test compute-now error");
    res.status(500).json({ error: err.message });
  }
});

export default router;
