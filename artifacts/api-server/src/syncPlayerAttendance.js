import { createClient } from "@supabase/supabase-js";

// NOTE: This module no longer calls PodPlay or writes to the attendances table.
// Attendance records are managed exclusively by syncEventAttendance.js, which
// uses the event-centric GET /events/{id}/signups approach — the only reliable
// way to map PodPlay signups to club players via Firebase ID.
//
// These exports remain so POST /api/sync/player and POST /api/sync/all continue
// to work: they now refresh last_visit_date from existing attendance rows
// (already written by the event sync) rather than re-fetching from PodPlay.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Derive last_visit_date for one player from their existing attendance rows
 * and write it back to players. No PodPlay API calls, no attendance writes.
 *
 * @param {string} playerId
 * @returns {Promise<{ lastVisitDate: string|null }>}
 */
async function refreshLastVisitDate(playerId) {
  const { data: latestRow, error: maxErr } = await supabase
    .from("attendances")
    .select("attended_at")
    .eq("player_id", playerId)
    .order("attended_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxErr) {
    throw new Error(`Failed to query max attended_at for player ${playerId}: ${maxErr.message}`);
  }

  const lastVisitDate = latestRow?.attended_at ?? null;

  if (lastVisitDate) {
    const { error: updateErr } = await supabase
      .from("players")
      .update({ last_visit_date: lastVisitDate })
      .eq("id", playerId);

    if (updateErr) {
      throw new Error(`Failed to update last_visit_date for player ${playerId}: ${updateErr.message}`);
    }
  }

  return { lastVisitDate };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Refresh last_visit_date for a single player from their existing attendance rows.
 * Returns { inserted: 0, skipped: 0, lastVisitDate } — matches the shape the
 * calling route (POST /api/sync/player, POST /api/sync/all) expects.
 *
 * @param {string} playerId
 * @param {string} _externalId — kept for API compatibility; no longer used here
 */
export async function syncSinglePlayer(playerId, _externalId) {
  const { lastVisitDate } = await refreshLastVisitDate(playerId);
  return { inserted: 0, skipped: 0, lastVisitDate };
}

/**
 * Batch: refresh last_visit_date for all linked players.
 * Attendance is already populated by syncEventAttendance.js.
 */
export async function syncPlayerAttendance() {
  const { data: players, error: playersErr } = await supabase
    .from("players")
    .select("id")
    .not("external_id", "is", null);

  if (playersErr) {
    throw new Error(`Failed to fetch players: ${playersErr.message}`);
  }

  if (!players || players.length === 0) {
    return { playersProcessed: 0, totalInserted: 0, totalUpdated: 0, errors: [] };
  }

  let totalUpdated = 0;
  const errors = [];

  for (const player of players) {
    try {
      const { lastVisitDate } = await refreshLastVisitDate(player.id);
      if (lastVisitDate) totalUpdated++;
    } catch (err) {
      errors.push({ playerId: player.id, error: err.message });
    }
  }

  return { playersProcessed: players.length, totalInserted: 0, totalUpdated, errors };
}
