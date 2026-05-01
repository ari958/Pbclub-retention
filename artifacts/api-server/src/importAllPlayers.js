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
const UPSERT_BATCH = 100;

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

class CancelledError extends Error {
  constructor() {
    super("Import cancelled by operator");
    this.name = "CancelledError";
  }
}

// ─── PodPlay fetch: all users (already paginated correctly) ───────────────────

async function fetchAllPodPlayUsers(isCancelled) {
  const allUsers = [];
  let page = 1;

  while (true) {
    if (await isCancelled()) throw new CancelledError();

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

    allUsers.push(...items);

    const total = pagination.total ?? null;
    if (items.length < IPP || (total !== null && allUsers.length >= total)) break;
    page++;
  }

  return allUsers;
}

// ─── Supabase fetch: all existing players (paginated past 1,000 row cap) ─────

async function fetchAllSupabasePlayers(log) {
  const all = [];
  let offset = 0;
  const PAGE = 1000;

  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, external_id, phone, email")
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`Failed to load Supabase players (offset ${offset}): ${error.message}`);
    all.push(...data);
    log(`[import] Loaded Supabase players: ${all.length} so far…`);
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

// ─── Main import ──────────────────────────────────────────────────────────────

/**
 * @param {(msg: string) => void} log
 * @param {() => boolean | Promise<boolean>} isCancelled
 * @param {boolean} skipAttendanceSync
 */
export async function importAllPlayers(log = console.log, isCancelled = () => false, skipAttendanceSync = false) {
  const stats = {
    processed: 0,
    created: 0,
    updated: 0,
    linked: 0,       // matched by phone/email, external_id now set
    errors: 0,
    attendanceSynced: 0,
    attendanceErrors: 0,
  };

  // 1. Read club context for logging
  const { data: clubRow } = await supabase
    .from("clubs")
    .select("id, name, scheduled_sync_time, timezone")
    .eq("id", CLUB_ID)
    .maybeSingle();

  if (clubRow?.scheduled_sync_time) {
    log(`[import] Club: ${clubRow.name} | Scheduled sync: ${clubRow.scheduled_sync_time} ${clubRow.timezone ?? "UTC"}`);
  }

  // 2. Fetch all PodPlay users
  log(`[import] Fetching PodPlay users…`);
  let podplayUsers;
  try {
    podplayUsers = await fetchAllPodPlayUsers(isCancelled);
  } catch (err) {
    if (err.name === "CancelledError") throw err;
    log(`[import] FATAL: Failed to fetch PodPlay users: ${err.message}`);
    throw err;
  }
  log(`[import] Fetched ${podplayUsers.length} PodPlay users across ${Math.ceil(podplayUsers.length / IPP)} page(s)`);

  // 3. Pre-load all existing Supabase players into memory — one paginated fetch,
  //    no per-player queries. Bypasses the 1,000 row cap.
  log(`[import] Loading all existing Supabase players…`);
  let existingPlayers;
  try {
    existingPlayers = await fetchAllSupabasePlayers(log);
  } catch (err) {
    log(`[import] FATAL: ${err.message}`);
    throw err;
  }
  log(`[import] Loaded ${existingPlayers.length} existing Supabase players`);

  // Build lookup maps for O(1) matching
  const byExtId = new Map();   // external_id  → player row
  const byPhone = new Map();   // phone        → player row
  const byEmail = new Map();   // email        → player row

  for (const p of existingPlayers) {
    if (p.external_id) byExtId.set(p.external_id, p);
    if (p.phone)       byPhone.set(p.phone, p);
    if (p.email)       byEmail.set(p.email, p);
  }

  // 4. Classify every PodPlay user — no per-player DB queries needed
  const toUpsert = [];    // already linked by external_id → UPDATE via upsert
  const toLink   = [];    // matched by phone/email        → UPDATE individual (set external_id)
  const toInsert = [];    // brand new                     → INSERT

  for (const user of podplayUsers) {
    if (await isCancelled()) throw new CancelledError();

    stats.processed++;
    const extId      = String(user.id);
    const name       = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown";
    const phone      = formatPhone(user.phoneNumber);
    const email      = user.email ?? null;
    const membership = mapMembership(user.membershipType);

    const linked = byExtId.get(extId);
    if (linked) {
      // Already linked — queue an UPDATE (name, email, membership_status).
      // This was previously a SKIP — fixed. Store id so we UPDATE by pk, not upsert.
      toUpsert.push({
        id:                linked.id,
        name,
        email,
        membership_status: membership,
      });
      continue;
    }

    // Try to match by phone, then email, for players not yet linked
    const phoneMatch = phone ? byPhone.get(phone) : null;
    const emailMatch = email ? byEmail.get(email) : null;
    const match = phoneMatch || emailMatch;

    if (match) {
      toLink.push({
        id:                match.id,
        external_id:       extId,
        name,
        email,
        membership_status: membership,
      });
      // Keep Maps consistent so a second PodPlay user doesn't double-match
      byExtId.set(extId, match);
      if (phone) byPhone.set(phone, match);
      if (email) byEmail.set(email, match);
    } else {
      toInsert.push({
        club_id:           CLUB_ID,
        external_id:       extId,
        name,
        phone,
        email,
        membership_status: membership,
      });
    }
  }

  log(`[import] Classification: ${toUpsert.length} to update, ${toLink.length} to link, ${toInsert.length} to create`);

  // 5a. Update already-linked players — individual UPDATE by pk to satisfy RLS
  //     (upsert uses INSERT ON CONFLICT DO UPDATE which fails the anon key INSERT policy)
  for (const p of toUpsert) {
    if (await isCancelled()) throw new CancelledError();
    const payload = { name: p.name, membership_status: p.membership_status };
    if (p.email) payload.email = p.email;
    const { error } = await supabase
      .from("players")
      .update(payload)
      .eq("id", p.id);
    if (error) {
      log(`[import] UPDATE ERROR for id=${p.id}: ${error.message}`);
      stats.errors++;
    } else {
      stats.updated++;
    }
  }
  if (toUpsert.length > 0) log(`[import] Updated ${stats.updated} already-linked players`);

  // 5b. Link players matched by phone/email (individual updates — needs id)
  for (const p of toLink) {
    if (await isCancelled()) throw new CancelledError();
    const updatePayload = { external_id: p.external_id, membership_status: p.membership_status, name: p.name };
    if (p.email) updatePayload.email = p.email;

    const { error } = await supabase
      .from("players")
      .update(updatePayload)
      .eq("id", p.id);

    if (error) {
      log(`[import] LINK ERROR for id=${p.id}: ${error.message}`);
      stats.errors++;
    } else {
      log(`[import] LINK: ${p.name} (id=${p.id}) → external_id=${p.external_id}`);
      stats.linked++;
    }
  }

  // 5c. Batch insert brand-new players
  if (toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += UPSERT_BATCH) {
      if (await isCancelled()) throw new CancelledError();
      const batch = toInsert.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("players")
        .insert(batch);
      if (error) {
        log(`[import] INSERT ERROR (batch ${Math.floor(i / UPSERT_BATCH) + 1}): ${error.message}`);
        stats.errors += batch.length;
      } else {
        stats.created += batch.length;
      }
    }
    log(`[import] Created ${stats.created} new players`);
  }

  log(`[import] ── Player import complete ──`);
  log(`[import] Processed: ${stats.processed} | Updated: ${stats.updated} | Linked: ${stats.linked} | Created: ${stats.created} | Errors: ${stats.errors}`);

  // 6. Sync attendance for all linked players (skipped when called from nightly chain)
  if (skipAttendanceSync) {
    log(`[import] Skipping attendance sync (handled by nightly event sync step)`);
    return stats;
  }

  if (await isCancelled()) throw new CancelledError();

  log(`[import] Starting attendance sync…`);

  // Paginate linked players to bypass 1,000 row cap
  const linkedPlayers = [];
  {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("players")
        .select("id, external_id")
        .not("external_id", "is", null)
        .range(offset, offset + PAGE - 1);
      if (error) {
        log(`[import] ERROR fetching linked players (offset ${offset}): ${error.message}`);
        break;
      }
      linkedPlayers.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
  }

  log(`[import] Syncing attendance for ${linkedPlayers.length} players…`);

  for (let i = 0; i < linkedPlayers.length; i++) {
    if (await isCancelled()) throw new CancelledError();

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
      if (err.name === "CancelledError") throw err;
      stats.attendanceErrors++;
      log(`[import] Attendance ERROR [${i + 1}/${linkedPlayers.length}] ${p.id}: ${err.message}`);
    }
  }

  log(`[import] ── All done ──`);
  log(`[import] Attendance synced: ${stats.attendanceSynced} | Attendance errors: ${stats.attendanceErrors}`);

  return stats;
}
