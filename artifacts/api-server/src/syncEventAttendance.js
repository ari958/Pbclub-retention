import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";
const SYNC_START_DATE = "2025-01-01T00:00:00.000Z";
const IPP = 100;
const UPSERT_BATCH = 100;

class CancelledError extends Error {
  constructor() {
    super("Event sync cancelled by operator");
    this.name = "CancelledError";
  }
}

// ─── PodPlay fetchers ─────────────────────────────────────────────────────────

async function fetchEventPage(page, endTime) {
  const url =
    `${PODPLAY_BASE}/events` +
    `?startTime=${encodeURIComponent(SYNC_START_DATE)}` +
    `&endTime=${encodeURIComponent(endTime)}` +
    `&page=${page}&ipp=${IPP}`;

  const res = await fetch(url, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY },
  });
  if (!res.ok) throw new Error(`PodPlay GET /events page=${page} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchEventSignups(eventId) {
  const url = `${PODPLAY_BASE}/events/${eventId}/signups`;
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY },
  });
  if (res.status === 404) return []; // Event may not support signups
  if (!res.ok) throw new Error(`PodPlay GET /events/${eventId}/signups returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.items ?? [];
}

// ─── Main sync ────────────────────────────────────────────────────────────────

/**
 * Event-centric attendance sync.
 *
 * 1. Loads all players with an external_id into a Map for O(1) lookup.
 * 2. Paginates through all past events from SYNC_START_DATE to now.
 * 3. For each event fetches /signups — each signup has owner.id (PodPlay user ID).
 * 4. Matches owner.id → player via the Map.
 * 5. Upserts attendance records in batches, ignoring duplicates via the
 *    unique constraint on (player_id, program_name, attended_at).
 *
 * @param {(msg: string) => void} log
 * @param {() => boolean} isCancelled
 */
export async function syncEventAttendance(log = console.log, isCancelled = () => false) {
  const stats = {
    eventsScanned: 0,
    eventsPast: 0,
    eventsSkipped: 0,
    signupsFetched: 0,
    signupsMatched: 0,
    signupsUnmatched: 0,
    attendancesUpserted: 0,
    errors: 0,
  };

  // ── Step 1: Build player lookup map (external_id → player row) ────────────
  log("[sync/events] Loading players from Supabase…");

  const { data: players, error: playersErr } = await supabase
    .from("players")
    .select("id, external_id, name")
    .not("external_id", "is", null);

  if (playersErr) throw new Error(`Failed to load players: ${playersErr.message}`);

  const playerMap = new Map(players.map((p) => [p.external_id, p]));
  log(`[sync/events] Loaded ${playerMap.size} linked players into lookup map`);

  // ── Step 2: Paginate through all past events ───────────────────────────────
  const endTime = new Date().toISOString();
  const now = new Date();
  let page = 1;
  const pendingUpserts = []; // accumulate records across events before flushing

  async function flushUpserts() {
    if (pendingUpserts.length === 0) return;
    for (let i = 0; i < pendingUpserts.length; i += UPSERT_BATCH) {
      const batch = pendingUpserts.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("attendances")
        .upsert(batch, {
          onConflict: "player_id,program_name,attended_at",
          ignoreDuplicates: true,
        });
      if (error) {
        log(`[sync/events] UPSERT ERROR (batch ${i / UPSERT_BATCH + 1}): ${error.message}`);
        stats.errors++;
      } else {
        stats.attendancesUpserted += batch.length;
      }
    }
    pendingUpserts.length = 0;
  }

  while (true) {
    if (isCancelled()) throw new CancelledError();

    let pageData;
    try {
      pageData = await fetchEventPage(page, endTime);
    } catch (err) {
      log(`[sync/events] ERROR fetching events page ${page}: ${err.message}`);
      stats.errors++;
      break;
    }

    const items = pageData.items ?? [];
    stats.eventsScanned += items.length;

    // Only process past, non-cancelled events
    const pastEvents = items.filter(
      (e) => !e.isCanceled && new Date(e.startTime) <= now
    );
    stats.eventsPast += pastEvents.length;
    stats.eventsSkipped += items.length - pastEvents.length;

    log(
      `[sync/events] Page ${page}: ${items.length} events total, ` +
      `${pastEvents.length} past & active, ${items.length - pastEvents.length} skipped`
    );

    // ── Step 3: For each past event, fetch signups ───────────────────────────
    for (const event of pastEvents) {
      if (isCancelled()) throw new CancelledError();

      let signups;
      try {
        signups = await fetchEventSignups(event.id);
      } catch (err) {
        log(`[sync/events] ERROR fetching signups for event ${event.id} (${event.name}): ${err.message}`);
        stats.errors++;
        continue;
      }

      stats.signupsFetched += signups.length;

      // ── Step 4: Match signups to players ──────────────────────────────────
      let matched = 0;
      let unmatched = 0;

      for (const signup of signups) {
        const externalId = signup.owner?.id;
        if (!externalId) { unmatched++; continue; }

        const player = playerMap.get(externalId);
        if (!player) { unmatched++; continue; }

        matched++;
        pendingUpserts.push({
          player_id: player.id,
          event_id: event.id,
          program_name: event.name,
          attended_at: event.startTime,
          program_type: event.customType ?? event.type ?? null,
        });
      }

      stats.signupsMatched += matched;
      stats.signupsUnmatched += unmatched;

      if (signups.length > 0) {
        log(
          `[sync/events] Event "${event.name}" (${event.startTime.slice(0, 10)}): ` +
          `${signups.length} signups — ${matched} matched, ${unmatched} unmatched`
        );
      }

      // Flush to DB when batch is large enough
      if (pendingUpserts.length >= UPSERT_BATCH) {
        await flushUpserts();
      }
    }

    if (items.length < IPP) break; // last page
    page++;
  }

  // Final flush of any remaining records
  await flushUpserts();

  // ── Step 5: Update last_visit_date for all affected players ───────────────
  log("[sync/events] Updating last_visit_date for all linked players…");
  let visitUpdates = 0;

  for (const player of players) {
    if (isCancelled()) break;

    const { data: latest } = await supabase
      .from("attendances")
      .select("attended_at")
      .eq("player_id", player.id)
      .order("attended_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest?.attended_at) {
      await supabase
        .from("players")
        .update({ last_visit_date: latest.attended_at })
        .eq("id", player.id);
      visitUpdates++;
    }
  }

  log(`[sync/events] Updated last_visit_date for ${visitUpdates} players`);

  log(
    `[sync/events] ── Complete ──\n` +
    `  Events scanned: ${stats.eventsScanned} | Past/active: ${stats.eventsPast} | Skipped: ${stats.eventsSkipped}\n` +
    `  Signups fetched: ${stats.signupsFetched} | Matched: ${stats.signupsMatched} | Unmatched: ${stats.signupsUnmatched}\n` +
    `  Attendance records upserted: ${stats.attendancesUpserted} | Errors: ${stats.errors}`
  );

  return stats;
}
