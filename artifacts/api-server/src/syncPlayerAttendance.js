import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";

// ─── Unique constraint bootstrap ─────────────────────────────────────────────
// Attempt to add the unique constraint once per server process. The Supabase
// REST client cannot run DDL directly, so this calls a stored procedure if one
// exists. If not, a clear hint is logged and upsert handles duplicates anyway.

let constraintAttempted = false;

async function ensureUniqueConstraint() {
  if (constraintAttempted) return;
  constraintAttempted = true;

  const ddl =
    "ALTER TABLE attendances ADD CONSTRAINT IF NOT EXISTS " +
    "attendances_unique_attendance UNIQUE (player_id, program_name, attended_at)";

  const { error } = await supabase.rpc("exec_sql", { sql: ddl });
  if (error) {
    // exec_sql function likely doesn't exist — that's expected on most projects.
    // Run the DDL once manually in the Supabase SQL editor to create the constraint:
    //   ALTER TABLE attendances ADD CONSTRAINT IF NOT EXISTS
    //     attendances_unique_attendance UNIQUE (player_id, program_name, attended_at);
    console.log(
      "[syncPlayerAttendance] Could not auto-apply unique constraint via RPC " +
      `(${error.message}). If not already present, run the constraint SQL manually.`
    );
  } else {
    console.log(
      "[syncPlayerAttendance] Unique constraint attendances_unique_attendance ensured."
    );
  }
}

// ─── PodPlay event fetcher ────────────────────────────────────────────────────

/**
 * Fetch ALL past events for a PodPlay user ID, paginating until exhausted.
 * @param {string} externalId - PodPlay user ID
 * @returns {Promise<object[]>}
 */
async function fetchPodPlayEvents(externalId) {
  const allItems = [];
  const IPP = 100;
  let page = 1;

  const endTime = new Date().toISOString();
  const startTime = "2020-01-01T00:00:00.000Z";

  while (true) {
    const url =
      `${PODPLAY_BASE}/events` +
      `?userId=${encodeURIComponent(externalId)}` +
      `&startTime=${encodeURIComponent(startTime)}` +
      `&endTime=${encodeURIComponent(endTime)}` +
      `&page=${page}&ipp=${IPP}`;

    const res = await fetch(url, {
      headers: { "x-api-key": process.env.PODPLAY_API_KEY },
    });

    if (!res.ok) {
      throw new Error(`PodPlay /events userId=${externalId} page=${page} returned ${res.status}`);
    }

    const data = await res.json();
    const items = data.items ?? [];
    const pagination = data._pagination ?? {};

    console.log(
      `[syncPlayerAttendance] PodPlay page=${page} | items_this_page=${items.length}` +
      ` | _pagination.page=${pagination.page} | _pagination.ipp=${pagination.ipp}` +
      ` | _pagination.count=${pagination.count} | _pagination.total=${pagination.total}` +
      ` | running_total=${allItems.length + items.length}`
    );

    allItems.push(...items);
    if (items.length < IPP) break;
    page++;
  }

  console.log(`[syncPlayerAttendance] Total past events fetched from PodPlay for userId=${externalId}: ${allItems.length}`);
  return allItems;
}

// ─── Single-player sync ───────────────────────────────────────────────────────

/**
 * Sync attendance records for one player.
 * Upserts all past events with onConflict on (player_id, program_name, attended_at)
 * so duplicate inserts are silently ignored at the database level, regardless of
 * how many times this runs or whether a restart occurred mid-sync.
 *
 * @param {{ id: string, external_id: string }} player
 * @returns {Promise<{ inserted: number, skipped: number, lastVisitDate: string|null }>}
 */
async function syncPlayer(player) {
  await ensureUniqueConstraint();

  const events = await fetchPodPlayEvents(player.external_id);

  if (events.length === 0) {
    return { inserted: 0, skipped: 0, lastVisitDate: null };
  }

  // Fetch existing event_ids for this player (optimisation: avoid re-upserting
  // thousands of rows that are already current).
  const { data: existing, error: fetchErr } = await supabase
    .from("attendances")
    .select("event_id")
    .eq("player_id", player.id);

  if (fetchErr) {
    throw new Error(`Failed to fetch existing attendance for player ${player.id}: ${fetchErr.message}`);
  }

  const existingIds = new Set((existing ?? []).map((r) => r.event_id));

  const now = new Date();

  // Exclude non-programming event subtypes — court reservations, internal ops,
  // co-working sessions, and private bookings all appear when fetching by userId
  // but are not club attendance records.
  const EXCLUDED_SUBTYPES = new Set([
    "COURT_RESERVATION",
    "CO_WORKING",
    "INTERNAL",
    "PRIVATE",
    "PRIVATE_EVENT",
    "OPERATIONS",
    "CONTRACT_TIME",
  ]);

  // Only count signups the player actually committed to. Null/missing status
  // = legacy record from before PodPlay added the field — allow through.
  const ALLOWED_STATUSES = new Set(["CONFIRMED", "CHECKED_IN", "COMPLETED"]);

  const pastEvents = events.filter((e) => {
    if (new Date(e.startTime) > now) return false;
    if (e.isCanceled) return false;
    if (e.subtype && EXCLUDED_SUBTYPES.has(e.subtype.toUpperCase())) return false;
    const status = e.invitationStatus ?? e.status ?? null;
    if (status && !ALLOWED_STATUSES.has(status.toUpperCase())) return false;
    return true;
  });

  const newEvents = pastEvents.filter((e) => !existingIds.has(e.id));

  console.log(
    `[syncPlayerAttendance] player=${player.id} | total_from_podplay=${events.length}` +
    ` | past_events=${pastEvents.length} | already_in_db=${existingIds.size}` +
    ` | new_to_upsert=${newEvents.length}`
  );

  const newRecords = newEvents.map((e) => ({
    player_id: player.id,
    event_id: e.id,
    program_name: e.name,
    attended_at: e.startTime,
    program_type: e.customType ?? e.type ?? null,
  }));

  let inserted = 0;
  if (newRecords.length > 0) {
    // Use upsert with onConflict so any duplicate (player_id, program_name, attended_at)
    // is silently ignored — the DB constraint is the final guarantee against duplication.
    const { error: upsertErr } = await supabase
      .from("attendances")
      .upsert(newRecords, {
        onConflict: "player_id,program_name,attended_at",
        ignoreDuplicates: true,
      });

    if (upsertErr) {
      throw new Error(`Failed to upsert attendance for player ${player.id}: ${upsertErr.message}`);
    }
    inserted = newRecords.length;
  }

  // Determine last_visit_date from the most recent attendance row
  const { data: latestRow, error: maxErr } = await supabase
    .from("attendances")
    .select("attended_at")
    .eq("player_id", player.id)
    .order("attended_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxErr) {
    throw new Error(`Failed to query max attended_at for player ${player.id}: ${maxErr.message}`);
  }

  const lastVisitDate = latestRow?.attended_at ?? null;

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

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Sync a single player by Supabase ID and PodPlay external_id.
 * Used for manual/on-demand triggers (e.g. POST /api/sync/player).
 */
export async function syncSinglePlayer(playerId, externalId) {
  return syncPlayer({ id: playerId, external_id: externalId });
}

/**
 * Nightly batch sync: fetches all linked players, syncs attendance for each.
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
    console.log("[syncPlayerAttendance] No players with an external_id found — nothing to sync.");
    return { playersProcessed: 0, totalInserted: 0, errors: [] };
  }

  let totalInserted = 0;
  const errors = [];

  for (const player of players) {
    try {
      const result = await syncPlayer(player);
      totalInserted += result.inserted;
      console.log(
        `[syncPlayerAttendance] Player ${player.id}: inserted=${result.inserted}, lastVisitDate=${result.lastVisitDate ?? "unchanged"}`
      );
    } catch (err) {
      console.error(`[syncPlayerAttendance] Error syncing player ${player.id}:`, err.message);
      errors.push({ playerId: player.id, error: err.message });
    }
  }

  console.log(
    `[syncPlayerAttendance] Sync complete. Players processed: ${players.length},` +
    ` total inserted: ${totalInserted}, errors: ${errors.length}`
  );

  return { playersProcessed: players.length, totalInserted, errors };
}
