import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";

/**
 * Fetch events for a PodPlay user ID.
 * @param {string} externalId - PodPlay user ID (stored as external_id on players)
 * @returns {Promise<object[]>}
 */
async function fetchPodPlayEvents(externalId) {
  const res = await fetch(`${PODPLAY_BASE}/events?userId=${encodeURIComponent(externalId)}`, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`PodPlay /events?userId=${externalId} returned ${res.status}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

/**
 * Sync attendance records for a single player.
 * Inserts any past events not already in the attendances table.
 * Updates last_visit_date on the player row.
 *
 * @param {object} player - Must have: id (Supabase UUID), external_id (PodPlay user ID)
 * @returns {Promise<{ inserted: number, skipped: number, lastVisitDate: string|null }>}
 */
async function syncPlayer(player) {
  const events = await fetchPodPlayEvents(player.external_id);

  if (events.length === 0) {
    return { inserted: 0, skipped: 0, lastVisitDate: null };
  }

  // Fetch existing attendance event_ids for this player to avoid duplicates
  const { data: existing, error: fetchErr } = await supabase
    .from("attendances")
    .select("event_id")
    .eq("player_id", player.id);

  if (fetchErr) {
    throw new Error(`Failed to fetch existing attendance for player ${player.id}: ${fetchErr.message}`);
  }

  const existingIds = new Set((existing ?? []).map((r) => r.event_id));

  // Only insert past/completed events not already recorded
  const now = new Date();
  const newRecords = events
    .filter((e) => new Date(e.startTime) <= now && !existingIds.has(e.id))
    .map((e) => ({
      player_id: player.id,
      event_id: e.id,
      program_name: e.name,
      attended_at: e.startTime,
      event_type: e.customType ?? e.type ?? null,
    }));

  let inserted = 0;
  if (newRecords.length > 0) {
    const { error: insertErr } = await supabase
      .from("attendances")
      .insert(newRecords);

    if (insertErr) {
      throw new Error(`Failed to insert attendance for player ${player.id}: ${insertErr.message}`);
    }
    inserted = newRecords.length;
  }

  // Determine last_visit_date from all past events (not just newly inserted)
  const pastEvents = events.filter((e) => new Date(e.startTime) <= now);
  const lastVisitDate =
    pastEvents.length > 0
      ? pastEvents.reduce((latest, e) =>
          new Date(e.startTime) > new Date(latest.startTime) ? e : latest
        ).startTime
      : null;

  if (lastVisitDate) {
    const { error: updateErr } = await supabase
      .from("players")
      .update({ last_visit_date: lastVisitDate })
      .eq("id", player.id);

    if (updateErr) {
      throw new Error(`Failed to update last_visit_date for player ${player.id}: ${updateErr.message}`);
    }
  }

  return { inserted, skipped: existingIds.size, lastVisitDate };
}

/**
 * Sync a single player by their Supabase ID and PodPlay external_id.
 * Used for manual/on-demand triggers (e.g. the POST /api/sync/player route).
 *
 * @param {string} playerId - Supabase player UUID
 * @param {string} externalId - PodPlay user ID
 * @returns {Promise<{ inserted: number, skipped: number, lastVisitDate: string|null }>}
 */
export async function syncSinglePlayer(playerId, externalId) {
  return syncPlayer({ id: playerId, external_id: externalId });
}

/**
 * Nightly sync: fetches all players with an external_id from Supabase,
 * syncs their attendance from PodPlay, and updates last_visit_date.
 *
 * @returns {Promise<{ playersProcessed: number, totalInserted: number, errors: object[] }>}
 */
export async function syncPlayerAttendance() {
  const { data: players, error: playersErr } = await supabase
    .from("players")
    .select("id, external_id")
    .not("external_id", "is", null);

  if (playersErr) {
    throw new Error(`Failed to fetch players: ${playersErr.message}`);
  }

  if (!players || players.length === 0) {
    console.log("No players with an external_id found — nothing to sync.");
    return { playersProcessed: 0, totalInserted: 0, errors: [] };
  }

  let totalInserted = 0;
  const errors = [];

  for (const player of players) {
    try {
      const result = await syncPlayer(player);
      totalInserted += result.inserted;
      console.log(
        `Player ${player.id}: inserted=${result.inserted}, lastVisitDate=${result.lastVisitDate ?? "unchanged"}`
      );
    } catch (err) {
      console.error(`Error syncing player ${player.id}:`, err.message);
      errors.push({ playerId: player.id, error: err.message });
    }
  }

  console.log(
    `Sync complete. Players processed: ${players.length}, total inserted: ${totalInserted}, errors: ${errors.length}`
  );

  return { playersProcessed: players.length, totalInserted, errors };
}
