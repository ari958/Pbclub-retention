import { createClient } from "@supabase/supabase-js";
// @ts-ignore
import { syncSinglePlayer } from "./syncPlayerAttendance.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const IPP = 100;
const UPSERT_BATCH = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const normalizeName  = (s) => s == null ? null : s.replace(/\s+/g, ' ').trim();
const normalizeEmail = (s) => s == null ? null : s.trim().toLowerCase() || null;

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

// ─── PodPlay fetch: all users ─────────────────────────────────────────────────

async function fetchAllPodPlayUsers(podplayBase, apiKey, isCancelled) {
  const allUsers = [];
  let page = 1;

  while (true) {
    if (await isCancelled()) throw new CancelledError();

    const url = `${podplayBase}/apis/v2/users?page=${page}&ipp=${IPP}`;
    const res = await fetch(url, {
      headers: { "x-api-key": apiKey },
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

// ─── Supabase fetch: all existing players ─────────────────────────────────────

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

// ─── DUPR ratings sync ────────────────────────────────────────────────────────

export async function syncDuprRatings(clubId, log = console.log, isCancelled = () => false) {
  if (!clubId) throw new Error("syncDuprRatings requires clubId");

  // Fetch club details for API key and base URL
  const { data: club } = await supabase
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .eq("id", clubId)
    .maybeSingle();
  if (!club?.platform_subdomain) {
    throw new Error(`Club ${clubId} has no platform_subdomain`);
  }
  const podplayBase = `https://${club.platform_subdomain}.podplay.app`;
  const apiKey = club.platform_api_key ?? process.env.PODPLAY_API_KEY;

  const DELAY_MS = 250;
  const stats = { fetched: 0, updated: 0, skipped: 0, errors: 0 };
  let firstResponseLogged = false;

  const players = [];
  {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("players")
        .select("id, external_id")
        .eq("club_id", clubId)
        .not("external_id", "is", null)
        .range(offset, offset + PAGE - 1);
      if (error) {
        log(`[dupr] ERROR fetching players (offset ${offset}): ${error.message}`);
        break;
      }
      players.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
  }

  log(`[dupr] Starting DUPR sync for ${players.length} players (250 ms delay between calls)…`);

  const updates = [];
  const seenTypes = new Set();
  let firstDuprItemLogged = false;

  for (let i = 0; i < players.length; i++) {
    if (await isCancelled()) throw new CancelledError();

    const p = players[i];
    try {
      const res = await fetch(`${podplayBase}/apis/v2/users/${p.external_id}/ratings`, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 404) {
        stats.skipped++;
        if (i % 100 === 0) log(`[dupr] Progress: ${i}/${players.length} — skipped: ${stats.skipped} rated: ${updates.length}`);
        await new Promise(r => setTimeout(r, DELAY_MS));
        continue;
      }

      if (!res.ok) {
        log(`[dupr] WARN player ${p.id} HTTP ${res.status} — skipping`);
        stats.skipped++;
        await new Promise(r => setTimeout(r, DELAY_MS));
        continue;
      }

      const data = await res.json();
      stats.fetched++;

      for (const item of (data.items ?? [])) {
        if (item.type && !seenTypes.has(item.type)) {
          seenTypes.add(item.type);
          log(`[dupr] New item type seen: "${item.type}" — full item: ${JSON.stringify(item)}`);
        }
      }

      if (!firstResponseLogged) {
        log(`[dupr] First /ratings response: ${JSON.stringify(data)}`);
        firstResponseLogged = true;
      }

      const duprItem = (data.items ?? []).find(item => item.type === "DUPR");

      if (duprItem && !firstDuprItemLogged) {
        log(`[dupr] First DUPR item found (player ${p.id}): ${JSON.stringify(duprItem)}`);
        firstDuprItemLogged = true;
      }

      if (!duprItem) {
        stats.skipped++;
        await new Promise(r => setTimeout(r, DELAY_MS));
        continue;
      }

      const rating = duprItem.doubles ?? duprItem.singles ?? null;
      if (typeof rating !== "number") {
        log(`[dupr] DUPR item for player ${p.id} has no numeric rating — fields: ${Object.keys(duprItem).join(", ")}`);
        stats.skipped++;
        await new Promise(r => setTimeout(r, DELAY_MS));
        continue;
      }

      updates.push({
        id: p.id,
        dupr_rating: rating,
        dupr_updated_at: duprItem.lastUpdated ?? new Date().toISOString(),
      });

      if (i % 100 === 0) log(`[dupr] Progress: ${i}/${players.length} — skipped: ${stats.skipped} rated: ${updates.length}`);
    } catch (err) {
      if (err.name === "CancelledError") throw err;
      log(`[dupr] ERROR player ${p.id} (ext=${p.external_id}): ${err.message}`);
      stats.errors++;
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  log(`[dupr] Types seen across all players: ${[...seenTypes].join(", ")}`);
  log(`[dupr] Fetch pass complete — writing ${updates.length} ratings to DB…`);

  for (const u of updates) {
    if (await isCancelled()) throw new CancelledError();
    const { error } = await supabase
      .from("players")
      .update({ dupr_rating: u.dupr_rating, dupr_updated_at: u.dupr_updated_at })
      .eq("id", u.id);
    if (error) {
      log(`[dupr] DB UPDATE ERROR player ${u.id}: ${error.message}`);
      stats.errors++;
    } else {
      stats.updated++;
    }
  }

  log(`[dupr] ── DUPR sync complete — fetched: ${stats.fetched} | updated: ${stats.updated} | skipped: ${stats.skipped} | errors: ${stats.errors}`);
  return stats;
}

// ─── Main import ──────────────────────────────────────────────────────────────

/**
 * @param {string} clubId
 * @param {(msg: string) => void} log
 * @param {() => boolean | Promise<boolean>} isCancelled
 * @param {boolean} skipAttendanceSync
 */
export async function importAllPlayers(clubId, log = console.log, isCancelled = () => false, skipAttendanceSync = false) {
  if (!clubId) throw new Error("importAllPlayers requires clubId");

  const stats = {
    processed: 0,
    created: 0,
    updated: 0,
    linked: 0,
    errors: 0,
    duprUpdated: 0,
    duprErrors: 0,
    attendanceSynced: 0,
    attendanceErrors: 0,
  };

  // 1. Read club context for API key and base URL
  const { data: clubRow } = await supabase
    .from("clubs")
    .select("id, name, scheduled_sync_time, timezone, platform_api_key, platform_subdomain")
    .eq("id", clubId)
    .maybeSingle();

  if (!clubRow?.platform_subdomain) {
    throw new Error(`Club ${clubId} has no platform_subdomain set`);
  }

  const podplayBase = `https://${clubRow.platform_subdomain}.podplay.app`;
  const apiKey = clubRow.platform_api_key ?? process.env.PODPLAY_API_KEY;

  if (clubRow?.scheduled_sync_time) {
    log(`[import] Club: ${clubRow.name} | Scheduled sync: ${clubRow.scheduled_sync_time} ${clubRow.timezone ?? "UTC"}`);
  }

  // 2. Fetch all PodPlay users
  log(`[import] Fetching PodPlay users…`);
  let podplayUsers;
  try {
    podplayUsers = await fetchAllPodPlayUsers(podplayBase, apiKey, isCancelled);
  } catch (err) {
    if (err.name === "CancelledError") throw err;
    log(`[import] FATAL: Failed to fetch PodPlay users: ${err.message}`);
    throw err;
  }
  log(`[import] Fetched ${podplayUsers.length} PodPlay users across ${Math.ceil(podplayUsers.length / IPP)} page(s)`);

  // 3. Pre-load all existing Supabase players
  log(`[import] Loading all existing Supabase players…`);
  let existingPlayers;
  try {
    existingPlayers = await fetchAllSupabasePlayers(log);
  } catch (err) {
    log(`[import] FATAL: ${err.message}`);
    throw err;
  }
  log(`[import] Loaded ${existingPlayers.length} existing Supabase players`);

  const byExtId = new Map();
  const byPhone = new Map();
  const byEmail = new Map();

  for (const p of existingPlayers) {
    if (p.external_id) byExtId.set(p.external_id, p);
    if (p.phone)       byPhone.set(p.phone, p);
    if (p.email)       byEmail.set(p.email, p);
  }

  // 4. Classify every PodPlay user
  const toUpsert = [];
  const toLink   = [];
  const toInsert = [];

  for (const user of podplayUsers) {
    if (await isCancelled()) throw new CancelledError();

    stats.processed++;
    const extId      = String(user.id);
    const name       = [user.firstName, user.lastName].map(normalizeName).filter(Boolean).join(" ") || "Unknown";
    const phone      = formatPhone(user.phoneNumber);
    const email      = normalizeEmail(user.email);
    const membership = mapMembership(user.membershipType);

    const linked = byExtId.get(extId);
    if (linked) {
      toUpsert.push({
        id:                linked.id,
        name,
        email,
        membership_status: membership,
      });
      continue;
    }

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
      byExtId.set(extId, match);
      if (phone) byPhone.set(phone, match);
      if (email) byEmail.set(email, match);
    } else {
      toInsert.push({
        club_id:           clubId,
        external_id:       extId,
        name,
        phone,
        email,
        membership_status: membership,
      });
    }
  }

  log(`[import] Classification: ${toUpsert.length} to update, ${toLink.length} to link, ${toInsert.length} to create`);

  // 5a. Update already-linked players
  {
    const PARALLEL = 25;
    for (let i = 0; i < toUpsert.length; i += PARALLEL) {
      if (await isCancelled()) throw new CancelledError();
      const batch = toUpsert.slice(i, i + PARALLEL);
      const results = await Promise.all(
        batch.map((p) => {
          const payload = { name: p.name, membership_status: p.membership_status };
          if (p.email) payload.email = p.email;
          return supabase.from("players").update(payload).eq("id", p.id);
        })
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].error) {
          log(`[import] UPDATE ERROR for id=${batch[j].id}: ${results[j].error.message}`);
          stats.errors++;
        } else {
          stats.updated++;
        }
      }
    }
  }
  if (toUpsert.length > 0) log(`[import] Updated ${stats.updated} already-linked players`);

  // 5b. Link players matched by phone/email
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

  // 5d. DUPR ratings sync
  log(`[import] ── Starting DUPR ratings sync ──`);
  try {
    const duprStats = await syncDuprRatings(clubId, log, isCancelled);
    stats.duprUpdated = duprStats.updated;
    stats.duprErrors  = duprStats.errors;
  } catch (err) {
    if (err.name === "CancelledError") throw err;
    log(`[import] DUPR sync failed (non-fatal): ${err.message}`);
  }

  // 6. Sync attendance
  if (skipAttendanceSync) {
    log(`[import] Skipping attendance sync (handled by nightly event sync step)`);
    return stats;
  }

  if (await isCancelled()) throw new CancelledError();

  log(`[import] Starting attendance sync…`);

  const linkedPlayers = [];
  {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("players")
        .select("id, external_id")
        .eq("club_id", clubId)
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
