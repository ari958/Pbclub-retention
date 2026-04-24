import { createClient } from "@supabase/supabase-js";
// @ts-ignore
import { syncSinglePlayer } from "./syncPlayerAttendance.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";
const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const IPP = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

function mapMembership(membershipType) {
  if (membershipType === "GLOBAL_MEMBER") return "member";
  if (membershipType === "NONE") return "non-member";
  return membershipType?.toLowerCase() ?? "non-member";
}

// ─── PodPlay fetch: all users ─────────────────────────────────────────────────

async function fetchAllPodPlayUsers() {
  const allUsers = [];
  let page = 1;

  console.log("[import] Fetching PodPlay users…");

  while (true) {
    const url = `${PODPLAY_BASE}/users?page=${page}&ipp=${IPP}`;
    const res = await fetch(url, {
      headers: { "x-api-key": process.env.PODPLAY_API_KEY },
    });

    if (!res.ok) {
      throw new Error(`PodPlay GET /users page=${page} returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const items = data.items ?? [];
    const pagination = data._pagination ?? {};

    console.log(
      `[import] /users page=${page} | count=${items.length} | total=${pagination.total ?? "?"} | running=${allUsers.length + items.length}`
    );

    allUsers.push(...items);

    const total = pagination.total ?? null;
    if (items.length < IPP || (total !== null && allUsers.length >= total)) break;
    page++;
  }

  console.log(`[import] Fetched ${allUsers.length} PodPlay users total`);
  return allUsers;
}

// ─── Main import ──────────────────────────────────────────────────────────────

export async function importAllPlayers(log = console.log) {
  const stats = {
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    attendanceSynced: 0,
    attendanceErrors: 0,
  };

  // 1. Fetch scheduled sync time for context
  const { data: clubRow } = await supabase
    .from("clubs")
    .select("id, name, scheduled_sync_time, timezone")
    .eq("id", CLUB_ID)
    .maybeSingle();

  if (clubRow?.scheduled_sync_time) {
    log(`[import] Club: ${clubRow.name} | Scheduled sync: ${clubRow.scheduled_sync_time} ${clubRow.timezone ?? "UTC"}`);
  }

  // 2. Fetch all PodPlay users
  let podplayUsers;
  try {
    podplayUsers = await fetchAllPodPlayUsers();
  } catch (err) {
    log(`[import] FATAL: Failed to fetch PodPlay users: ${err.message}`);
    throw err;
  }

  log(`[import] Processing ${podplayUsers.length} PodPlay users…`);

  // 3. Process each PodPlay user
  for (const user of podplayUsers) {
    stats.processed++;

    const externalId = String(user.id);
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown";
    const phone = formatPhone(user.phoneNumber);
    const email = user.email ?? null;
    const membership = mapMembership(user.membershipType);

    try {
      // Check for existing player by external_id first (fastest — already imported)
      const { data: byExtId } = await supabase
        .from("players")
        .select("id, external_id")
        .eq("external_id", externalId)
        .maybeSingle();

      if (byExtId) {
        log(`[import] [${stats.processed}/${podplayUsers.length}] SKIP (already has external_id): ${name} (${externalId})`);
        stats.skipped++;
        continue;
      }

      // Match by phone or email
      let existingPlayer = null;
      if (phone) {
        const { data } = await supabase
          .from("players")
          .select("id, external_id")
          .eq("phone", phone)
          .maybeSingle();
        existingPlayer = data;
      }
      if (!existingPlayer && email) {
        const { data } = await supabase
          .from("players")
          .select("id, external_id")
          .eq("email", email)
          .maybeSingle();
        existingPlayer = data;
      }

      if (existingPlayer) {
        // Update existing player — set external_id if not already set
        const updatePayload = { external_id: externalId, membership_status: membership };
        if (email) updatePayload.email = email;

        const { error } = await supabase
          .from("players")
          .update(updatePayload)
          .eq("id", existingPlayer.id);

        if (error) {
          log(`[import] [${stats.processed}/${podplayUsers.length}] ERROR updating ${name}: ${error.message}`);
          stats.errors++;
        } else {
          log(`[import] [${stats.processed}/${podplayUsers.length}] UPDATE: ${name} (phone/email match, set external_id=${externalId})`);
          stats.updated++;
        }
      } else {
        // Create new player
        const insertPayload = {
          club_id: CLUB_ID,
          name,
          phone,
          external_id: externalId,
          membership_status: membership,
        };
        if (email) insertPayload.email = email;

        const { error } = await supabase
          .from("players")
          .insert(insertPayload);

        if (error) {
          log(`[import] [${stats.processed}/${podplayUsers.length}] ERROR creating ${name}: ${error.message}`);
          stats.errors++;
        } else {
          log(`[import] [${stats.processed}/${podplayUsers.length}] CREATE: ${name} (external_id=${externalId})`);
          stats.created++;
        }
      }
    } catch (err) {
      log(`[import] [${stats.processed}/${podplayUsers.length}] EXCEPTION for ${name}: ${err.message}`);
      stats.errors++;
    }
  }

  log(`[import] ── Player import complete ──`);
  log(`[import] Processed: ${stats.processed} | Created: ${stats.created} | Updated: ${stats.updated} | Skipped: ${stats.skipped} | Errors: ${stats.errors}`);

  // 4. Sync attendance for all players with external_id
  log(`[import] Starting attendance sync for all linked players…`);

  const { data: linkedPlayers, error: fetchErr } = await supabase
    .from("players")
    .select("id, external_id")
    .not("external_id", "is", null);

  if (fetchErr) {
    log(`[import] ERROR fetching linked players for attendance sync: ${fetchErr.message}`);
  } else {
    log(`[import] Syncing attendance for ${linkedPlayers.length} players…`);

    for (let i = 0; i < linkedPlayers.length; i++) {
      const p = linkedPlayers[i];
      try {
        const result = await syncSinglePlayer(p.id, p.external_id);
        await supabase
          .from("players")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("id", p.id);
        stats.attendanceSynced++;
        log(`[import] Attendance [${i + 1}/${linkedPlayers.length}] ${p.id}: inserted=${result.inserted}, lastVisit=${result.lastVisitDate ?? "—"}`);
      } catch (err) {
        stats.attendanceErrors++;
        log(`[import] Attendance [${i + 1}/${linkedPlayers.length}] ERROR for ${p.id}: ${err.message}`);
      }
    }
  }

  log(`[import] ── All done ──`);
  log(`[import] Attendance synced: ${stats.attendanceSynced} | Attendance errors: ${stats.attendanceErrors}`);

  return stats;
}
