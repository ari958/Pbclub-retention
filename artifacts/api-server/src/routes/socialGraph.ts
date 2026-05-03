import { Router, type IRouter } from "express";
import { supabase } from "../lib/supabaseClient";
import { extractSkillLevel } from "../lib/skillLevel";
import { logger } from "../lib/logger";

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

// ─── fetchPlayerRegistrations ─────────────────────────────────────────────────
// Returns upcoming events (from the supplied list) that the player is already
// registered for, identified by their PodPlay external_id.

async function fetchPlayerRegistrations(
  externalId: string,
  events: any[]
): Promise<{ event_id: string; event_name: string; start_time: string }[]> {
  const registered: { event_id: string; event_name: string; start_time: string }[] = [];
  for (let i = 0; i < events.length; i += 3) {
    if (i > 0) await sleep(250);
    const batch = events.slice(i, i + 3);
    const results = await Promise.all(
      batch.map((event) =>
        fetchEventSignupsRaw(event.id)
          .then((ids) => ({ event, inEvent: ids.includes(externalId) }))
          .catch(() => ({ event, inEvent: false }))
      )
    );
    for (const { event, inEvent } of results) {
      if (inEvent) {
        registered.push({
          event_id: event.id,
          event_name: event.name,
          start_time: event.startTime,
        });
      }
    }
  }
  return registered;
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
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    type AttRow = { player_id: string; event_id: string; attended_at: string };
    const allRows: AttRow[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("attendances")
        .select("player_id, event_id, attended_at")
        .gte("attended_at", cutoff)
        .not("player_id", "is", null)
        .range(offset, offset + 999);
      if (error) { res.status(500).json({ error: error.message }); return; }
      if (!data || data.length === 0) break;
      allRows.push(...(data as AttRow[]));
      if (data.length < 1000) break;
      offset += 1000;
    }

    const eventMap = new Map<string, { playerIds: string[]; lastAt: string }>();
    for (const row of allRows) {
      const entry = eventMap.get(row.event_id);
      if (!entry) {
        eventMap.set(row.event_id, { playerIds: [row.player_id], lastAt: row.attended_at });
      } else {
        entry.playerIds.push(row.player_id);
        if (row.attended_at > entry.lastAt) entry.lastAt = row.attended_at;
      }
    }

    type PairData = { player_a: string; player_b: string; count: number; last_shared_at: string };
    const pairMap = new Map<string, PairData>();
    for (const { playerIds, lastAt } of eventMap.values()) {
      const unique = [...new Set(playerIds)];
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const a = unique[i] < unique[j] ? unique[i] : unique[j];
          const b = unique[i] < unique[j] ? unique[j] : unique[i];
          const key = `${a}:${b}`;
          const existing = pairMap.get(key);
          if (!existing) {
            pairMap.set(key, { player_a: a, player_b: b, count: 1, last_shared_at: lastAt });
          } else {
            existing.count++;
            if (lastAt > existing.last_shared_at) existing.last_shared_at = lastAt;
          }
        }
      }
    }

    let pairsUpdated = 0;
    let pairsBelowThreshold = 0;
    const upserts: object[] = [];
    const now = new Date().toISOString();
    for (const pair of pairMap.values()) {
      if (pair.count < 3) { pairsBelowThreshold++; continue; }
      upserts.push({
        player_a: pair.player_a,
        player_b: pair.player_b,
        shared_sessions: pair.count,
        last_shared_at: pair.last_shared_at,
        updated_at: now,
      });
    }

    const upsertErrors: string[] = [];
    for (let i = 0; i < upserts.length; i += 100) {
      const batch = upserts.slice(i, i + 100);
      const { error } = await supabase
        .from("buddy_pairs")
        .upsert(batch, { onConflict: "player_a,player_b" });
      if (error) {
        logger.error({ err: error.message }, "[social-graph] buddy_pairs upsert error");
        upsertErrors.push(error.message);
      } else {
        pairsUpdated += batch.length;
      }
    }

    const response: Record<string, unknown> = {
      pairs_updated: pairsUpdated,
      pairs_above_threshold: upserts.length,
      pairs_below_threshold: pairsBelowThreshold,
    };
    if (upsertErrors.length > 0) response.upsert_errors = upsertErrors;
    res.json(response);
  } catch (err: any) {
    logger.error({ err: err.message }, "[social-graph] compute-buddy-pairs error");
    res.status(500).json({ error: err.message });
  }
});

// ─── Route B: GET /api/social-graph/player/:id/buddies ───────────────────────

router.get("/social-graph/player/:id/buddies", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: pairs, error } = await supabase
      .from("buddy_pairs")
      .select("player_a, player_b, shared_sessions, last_shared_at, opt_in_notifications")
      .or(`player_a.eq.${id},player_b.eq.${id}`)
      .order("shared_sessions", { ascending: false })
      .limit(10);

    if (error) {
      req.log.warn({ err: error.message }, "buddy_pairs query failed (table may not exist)");
      res.json({ buddies: [] });
      return;
    }

    const otherIds = (pairs ?? []).map((p: any) => (p.player_a === id ? p.player_b : p.player_a));
    const nameMap = new Map<string, string>();
    if (otherIds.length > 0) {
      const { data: players } = await supabase
        .from("players")
        .select("id, name")
        .in("id", otherIds);
      for (const p of (players ?? []) as { id: string; name: string }[]) {
        nameMap.set(p.id, p.name);
      }
    }

    const buddies = (pairs ?? []).map((p: any) => {
      const otherId = p.player_a === id ? p.player_b : p.player_a;
      return {
        player_id: otherId,
        name: nameMap.get(otherId) ?? "Unknown",
        shared_sessions: p.shared_sessions,
        last_shared_at: p.last_shared_at,
        opt_in_notifications: p.opt_in_notifications ?? false,
      };
    });

    res.json({ buddies });
  } catch (err: any) {
    req.log.error({ err: err.message }, "[social-graph] buddies error");
    res.status(500).json({ error: err.message });
  }
});

// ─── Route C: GET /api/social-graph/upcoming-with-buddies/:id ────────────────

router.get("/social-graph/upcoming-with-buddies/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { data: pairs, error: pairsErr } = await supabase
      .from("buddy_pairs")
      .select("player_a, player_b, shared_sessions")
      .or(`player_a.eq.${id},player_b.eq.${id}`);

    if (pairsErr) {
      req.log.warn({ err: pairsErr.message }, "buddy_pairs query failed (table may not exist)");
      res.json({ upcoming: [] });
      return;
    }
    if (!pairs || pairs.length === 0) { res.json({ upcoming: [] }); return; }

    const buddyIds = pairs.map((p: any) => (p.player_a === id ? p.player_b : p.player_a));
    const sessionMap = new Map<string, number>();
    for (const p of pairs as any[]) {
      const otherId = p.player_a === id ? p.player_b : p.player_a;
      sessionMap.set(otherId, p.shared_sessions);
    }

    const { data: buddyPlayers } = await supabase
      .from("players")
      .select("id, name, external_id")
      .in("id", buddyIds);

    const buddyByExternal = new Map<string, { id: string; name: string; shared_sessions: number }>();
    for (const p of (buddyPlayers ?? []) as { id: string; name: string; external_id: string }[]) {
      if (p.external_id) {
        buddyByExternal.set(p.external_id, {
          id: p.id,
          name: p.name,
          shared_sessions: sessionMap.get(p.id) ?? 0,
        });
      }
    }

    const allEvents = await fetchUpcomingEvents(7);
    const events = allEvents.slice(0, 10); // hard cap — keeps total time ~4s
    const upcoming: object[] = [];

    // Parallel batches of 3 with 250ms between batches (rate-limit PodPlay)
    for (let i = 0; i < events.length; i += 3) {
      if (i > 0) await sleep(250);
      const batch = events.slice(i, i + 3);
      const results = await Promise.all(
        batch.map((event) =>
          fetchEventSignupsRaw(event.id)
            .then((externalIds) => ({ event, externalIds }))
            .catch(() => ({ event, externalIds: [] as string[] }))
        )
      );
      for (const { event, externalIds } of results) {
        const buddiesHere = externalIds
          .map((eid) => buddyByExternal.get(eid))
          .filter(Boolean) as { id: string; name: string; shared_sessions: number }[];
        if (buddiesHere.length > 0) {
          upcoming.push({
            event_id: event.id,
            program_name: event.name,
            level: extractSkillLevel(event.tags),
            start_time: event.startTime,
            buddies_signed_up: buddiesHere.map((b) => ({
              player_id: b.id,
              name: b.name,
              shared_sessions: b.shared_sessions,
            })),
          });
        }
      }
    }

    res.json({ upcoming });
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
      for (let i = 0; i < allAttendeeIds.length; i += 500) {
        const chunk = allAttendeeIds.slice(i, i + 500);
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
  const { id } = req.params;
  try {
    const { data: player, error } = await supabase
      .from("players")
      .select("external_id")
      .eq("id", id)
      .single();
    if (error || !player?.external_id) {
      res.json({ registrations: [] });
      return;
    }
    const events = (await fetchUpcomingEvents(7)).slice(0, 10);
    const registrations = await fetchPlayerRegistrations(player.external_id, events);
    res.json({ registrations });
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
  const port = process.env.PORT ?? "8080";
  try {
    const result = await fetch(
      `http://localhost:${port}/api/social-graph/compute-buddy-pairs`,
      { method: "POST", signal: AbortSignal.timeout(5 * 60 * 1000) }
    );
    const data = await result.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
