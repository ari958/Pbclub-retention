import { supabase } from "./supabaseClient";
import { extractSkillLevel } from "./skillLevel";
import { logger as defaultLogger } from "./logger";
import { getPodPlayBaseUrl } from "./podplayUrls";
import type { BatchResult } from "./milestoneCheck";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Types ────────────────────────────────────────────────────────────────────
export interface BuddyEntry {
  player_id: string;
  name: string;
  shared_sessions: number;
  last_shared_at: string | null;
  opt_in_notifications: boolean;
}

export interface UpcomingWithBuddies {
  event_id: string;
  program_name: string;
  level: string | null;
  start_time: string;
  buddies_signed_up: { player_id: string; name: string; shared_sessions: number }[];
}

export interface Registration {
  event_id: string;
  event_name: string;
  start_time: string;
}

export interface PlayerSocialContext {
  buddies: BuddyEntry[];
  upcoming: UpcomingWithBuddies[];
  registrations: Registration[];
}

interface ContextOptions {
  clubId?: string;
  logger?: { warn: Function; info: Function; error: Function };
  daysAhead?: number;
  maxEvents?: number;
}

// ─── PodPlay helpers (private) ────────────────────────────────────────────────
async function fetchUpcomingEventsRaw(podplayBase: string, daysAhead: number): Promise<any[]> {
  const now = new Date().toISOString();
  const end = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const url = `${podplayBase}/apis/v2/events?startTime=${encodeURIComponent(now)}&endTime=${encodeURIComponent(end)}&ipp=100`;
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY ?? "" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`PodPlay /events returned ${res.status}`);
  const data = await res.json() as any;
  return (data.items ?? []).filter((e: any) => !e.isCanceled && e.status === "PUBLISHED");
}

async function fetchEventSignupsRaw(podplayBase: string, eventId: string): Promise<string[]> {
  const url = `${podplayBase}/apis/v2/events/${eventId}/signups`;
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

// ─── Resolve PodPlay base URL ─────────────────────────────────────────────────

async function resolvePodPlayBase(clubId: string | undefined): Promise<string> {
  if (clubId) {
    return getPodPlayBaseUrl(clubId);
  }
  // Transitional backward compat: used by agent.ts until Step 8 passes clubId.
  // Queries the first club's platform_subdomain rather than hardcoding a tenant.
  const { data } = await supabase
    .from("clubs")
    .select("platform_subdomain")
    .limit(1)
    .maybeSingle();
  if (!data?.platform_subdomain) {
    throw new Error("No club platform_subdomain available for PodPlay requests");
  }
  return `https://${data.platform_subdomain}.podplay.app`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────
/**
 * Single consolidated fetch for the agent's social context. Returns buddies,
 * upcoming-with-buddies, and registrations from one PodPlay events sweep,
 * eliminating the duplicate work that the three /api/social-graph routes
 * would otherwise do when called in parallel.
 *
 * Failure mode: returns empty arrays for any portion that fails. Never throws —
 * the agent route should treat social context as enrichment, not requirement.
 */
export async function getPlayerSocialContext(
  playerId: string,
  options: ContextOptions = {},
): Promise<PlayerSocialContext> {
  const log = options.logger ?? defaultLogger;
  const daysAhead = options.daysAhead ?? 7;
  const maxEvents = options.maxEvents ?? 10;

  // ── 1. Fetch buddy pairs + player external_id in parallel ───────────────
  const [pairsResult, playerResult] = await Promise.all([
    supabase
      .from("buddy_pairs")
      .select("player_a, player_b, shared_sessions, last_shared_at, opt_in_notifications")
      .or(`player_a.eq.${playerId},player_b.eq.${playerId}`)
      .order("shared_sessions", { ascending: false })
      .limit(50),
    supabase
      .from("players")
      .select("external_id")
      .eq("id", playerId)
      .maybeSingle(),
  ]);

  if (pairsResult.error) {
    (log as any).warn?.({ err: pairsResult.error.message }, "[socialGraph] buddy_pairs query failed");
  }
  const pairs = pairsResult.data ?? [];

  const buddyIds = pairs.map((p: any) => (p.player_a === playerId ? p.player_b : p.player_a));
  const sharedSessionsByBuddy = new Map<string, number>();
  for (const p of pairs as any[]) {
    const otherId = p.player_a === playerId ? p.player_b : p.player_a;
    sharedSessionsByBuddy.set(otherId, p.shared_sessions);
  }

  // ── 2. Fetch buddy player rows ──────────────────────────────────────────
  let buddyPlayers: { id: string; name: string; external_id: string | null }[] = [];
  if (buddyIds.length > 0) {
    const { data, error } = await supabase
      .from("players")
      .select("id, name, external_id")
      .in("id", buddyIds);
    if (error) {
      (log as any).warn?.({ err: error.message }, "[socialGraph] buddy player lookup failed");
    } else {
      buddyPlayers = (data ?? []) as any[];
    }
  }

  const buddyById = new Map(buddyPlayers.map((p) => [p.id, p]));
  const buddies: BuddyEntry[] = pairs
    .slice(0, 10)
    .map((p: any) => {
      const otherId = p.player_a === playerId ? p.player_b : p.player_a;
      const player = buddyById.get(otherId);
      return {
        player_id: otherId,
        name: player?.name ?? "Unknown",
        shared_sessions: p.shared_sessions,
        last_shared_at: p.last_shared_at ?? null,
        opt_in_notifications: p.opt_in_notifications ?? false,
      };
    });

  const buddyByExternalId = new Map<string, { id: string; name: string; shared_sessions: number }>();
  for (const p of buddyPlayers) {
    if (p.external_id) {
      buddyByExternalId.set(p.external_id, {
        id: p.id,
        name: p.name,
        shared_sessions: sharedSessionsByBuddy.get(p.id) ?? 0,
      });
    }
  }

  // ── 3. Resolve base URL + fetch upcoming events ─────────────────────────
  const playerExternalId = playerResult.data?.external_id ?? null;

  let podplayBase: string;
  try {
    podplayBase = await resolvePodPlayBase(options.clubId);
  } catch (err: any) {
    (log as any).warn?.({ err: err.message }, "[socialGraph] could not resolve PodPlay base URL");
    return { buddies, upcoming: [], registrations: [] };
  }

  let allEvents: any[] = [];
  try {
    allEvents = await fetchUpcomingEventsRaw(podplayBase, daysAhead);
  } catch (err: any) {
    (log as any).warn?.({ err: err.message }, "[socialGraph] upcoming events fetch failed");
    return { buddies, upcoming: [], registrations: [] };
  }
  const events = allEvents.slice(0, maxEvents);

  // ── 4. Fetch signups (parallel batches of 3 with throttle) ──────────────
  type EventSignups = { event: any; externalIds: string[] };
  const signupsByEvent: EventSignups[] = [];
  for (let i = 0; i < events.length; i += 3) {
    if (i > 0) await sleep(250);
    const batch = events.slice(i, i + 3);
    const results = await Promise.all(
      batch.map((event) =>
        fetchEventSignupsRaw(podplayBase, event.id)
          .then((externalIds) => ({ event, externalIds }))
          .catch(() => ({ event, externalIds: [] as string[] }))
      )
    );
    signupsByEvent.push(...results);
  }

  // ── 5. Derive both views from the single signups dataset ────────────────
  const upcoming: UpcomingWithBuddies[] = [];
  const registrations: Registration[] = [];

  for (const { event, externalIds } of signupsByEvent) {
    if (playerExternalId && externalIds.includes(playerExternalId)) {
      registrations.push({
        event_id: event.id,
        event_name: event.name,
        start_time: event.startTime,
      });
    }

    const buddiesHere = externalIds
      .map((eid) => buddyByExternalId.get(eid))
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

  return { buddies, upcoming, registrations };
}

// ─── Buddy pair computation ────────────────────────────────────────────────────

export interface ComputeBuddyPairsResult extends BatchResult {
  details: {
    pairs_updated: number;
    pairs_above_threshold: number;
    pairs_below_threshold: number;
    upsert_errors?: string[];
  };
}

export interface ComputeBuddyPairsOptions {
  lookbackDays?: number;
  logger?: { warn: Function; info: Function; error: Function };
}

/**
 * Recomputes the buddy_pairs table from the last `lookbackDays` of
 * attendance rows. A pair is recorded when two players have shared at
 * least 3 sessions (events). Idempotent — replaces existing rows via
 * upsert on (player_a, player_b).
 */
export async function computeBuddyPairs(
  options: ComputeBuddyPairsOptions = {},
): Promise<ComputeBuddyPairsResult> {
  const log = options.logger ?? defaultLogger;
  const lookbackDays = options.lookbackDays ?? 90;
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

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
    if (error) throw new Error(error.message);
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

  let pairsUpdated = 0;
  const upsertErrors: string[] = [];
  for (let i = 0; i < upserts.length; i += 100) {
    const batch = upserts.slice(i, i + 100);
    const { error } = await supabase
      .from("buddy_pairs")
      .upsert(batch, { onConflict: "player_a,player_b" });
    if (error) {
      (log as any).error?.({ err: error.message }, "[buddyPairs] upsert error");
      upsertErrors.push(error.message);
    } else {
      pairsUpdated += batch.length;
    }
  }

  const details: ComputeBuddyPairsResult["details"] = {
    pairs_updated: pairsUpdated,
    pairs_above_threshold: upserts.length,
    pairs_below_threshold: pairsBelowThreshold,
  };
  if (upsertErrors.length > 0) details.upsert_errors = upsertErrors;

  return {
    ok: upsertErrors.length === 0,
    stats: {
      pairs_updated: pairsUpdated,
      pairs_above_threshold: upserts.length,
      pairs_below_threshold: pairsBelowThreshold,
    },
    errors: upsertErrors.length > 0 ? upsertErrors : undefined,
    details,
  };
}
