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

  // Check schema BEFORE making any upstream calls. An old installation must
  // fail explicitly rather than silently performing another full, slow pass.
  const { error: schemaError } = await supabase.from("players")
    .select("dupr_checked_at").eq("club_id", clubId).limit(1);
  if (schemaError) throw new Error(`DUPR incremental schema unavailable (apply migration 010): ${schemaError.message}`);
  const { error: rpcError } = await supabase.rpc("apply_dupr_rating_checks", {
    p_club_id: clubId, p_checks: [],
  });
  if (rpcError) throw new Error(`DUPR batch writer unavailable (apply migration 010): ${rpcError.message}`);

  const { data: club, error: clubError } = await supabase
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .eq("id", clubId)
    .maybeSingle();
  if (clubError) throw new Error(`Could not load club for DUPR sync: ${clubError.message}`);
  if (!club?.platform_subdomain) {
    throw new Error(`Club ${clubId} has no platform_subdomain`);
  }
  const podplayBase = `https://${club.platform_subdomain}.podplay.app`;
  const apiKey = club.platform_api_key ?? process.env.PODPLAY_API_KEY;

  const CHECK_INTERVAL_DAYS = 14;
  const CONCURRENCY = 4;
  const REQUEST_SPACING_MS = 350; // At most ~3 starts/second across workers.
  const BATCH_SIZE = 50;
  const cutoff = new Date(Date.now() - CHECK_INTERVAL_DAYS * 86400_000).toISOString();
  const stats = { eligible: 0, fresh: 0, fetched: 0, updated: 0, skipped: 0, errors: 0 };
  const players = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, external_id, dupr_checked_at")
      .eq("club_id", clubId)
      .not("external_id", "is", null)
      .order("id")
      .range(offset, offset + 999);
    if (error) throw new Error(`Could not load DUPR candidates: ${error.message}`);
    players.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  const eligible = players.filter(p => !p.dupr_checked_at || p.dupr_checked_at < cutoff);
  stats.eligible = eligible.length;
  stats.fresh = players.length - eligible.length;
  log(`[dupr] ${eligible.length}/${players.length} players due (14-day check interval); ${stats.fresh} fresh. Up to ${CONCURRENCY} concurrent, ${REQUEST_SPACING_MS}ms between starts.`);

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let nextStartAt = 0;
  let blockedUntil = 0;
  async function waitForSlot() {
    // JS runs this scheduling section synchronously before the first await.
    const startAt = Math.max(Date.now(), nextStartAt, blockedUntil);
    nextStartAt = startAt + REQUEST_SPACING_MS;
    if (startAt > Date.now()) await pause(startAt - Date.now());
    // A different worker may have received a 429 while we were waiting.
    if (blockedUntil > Date.now()) await pause(blockedUntil - Date.now());
  }
  async function fetchRating(p) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await isCancelled()) throw new CancelledError();
      await waitForSlot();
      try {
        const res = await fetch(`${podplayBase}/apis/v2/users/${p.external_id}/ratings`, {
          headers: { "x-api-key": apiKey },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429 || res.status >= 500) {
          let retryMs = Math.min(15_000, 1000 * 2 ** attempt);
          const retryAfter = res.headers.get("retry-after");
          if (retryAfter) {
            const seconds = Number(retryAfter);
            const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
            if (Number.isFinite(parsed)) retryMs = Math.max(retryMs, Math.min(60_000, parsed));
          }
          blockedUntil = Math.max(blockedUntil, Date.now() + retryMs);
          if (attempt < 2) continue;
          throw new Error(`HTTP ${res.status} after retries`);
        }
        if (res.status === 404) {
          stats.skipped++;
          return { id: p.id, checked_at: new Date().toISOString() };
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        stats.fetched++;
        const duprItem = (body.items ?? []).find(item => item.type === "DUPR");
        const rawRating = duprItem?.doubles ?? duprItem?.singles;
        const rating = typeof rawRating === "number" && Number.isFinite(rawRating) ? rawRating : null;
        if (rating === null) stats.skipped++;
        const sourceDate = duprItem?.lastUpdated;
        return {
          id: p.id, checked_at: new Date().toISOString(), rating,
          rating_updated_at: rating === null ? null :
            (sourceDate && !Number.isNaN(Date.parse(sourceDate)) ? sourceDate : new Date().toISOString()),
        };
      } catch (err) {
        if (attempt === 2) throw err;
        blockedUntil = Math.max(blockedUntil, Date.now() + Math.min(15_000, 1000 * 2 ** attempt));
      }
    }
  }

  for (let start = 0; start < eligible.length; start += BATCH_SIZE) {
    if (await isCancelled()) throw new CancelledError();
    const batch = eligible.slice(start, start + BATCH_SIZE);
    const checks = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      while (cursor < batch.length) {
        const p = batch[cursor++];
        try {
          const check = await fetchRating(p);
          checks.push(check);
        } catch (err) {
          if (err.name === "CancelledError") throw err;
          stats.errors++;
          log(`[dupr] ERROR checking player ${p.id}: ${err.message}`);
        }
      }
    }));
    if (await isCancelled()) throw new CancelledError();
    if (checks.length) {
      const { data: count, error } = await supabase.rpc("apply_dupr_rating_checks", {
        p_club_id: clubId, p_checks: checks,
      });
      if (error) throw new Error(`DUPR batch write failed at ${start}/${eligible.length}: ${error.message}`);
      if (count !== checks.length) throw new Error(`DUPR batch wrote ${count}/${checks.length} rows`);
      stats.updated += checks.filter(c => c.rating !== null).length;
    }
    log(`[dupr] Progress: ${Math.min(start + BATCH_SIZE, eligible.length)}/${eligible.length} checked — rated: ${stats.updated}, unrated: ${stats.skipped}, errors: ${stats.errors}`);
  }

  log(`[dupr] Complete — due: ${stats.eligible} | fresh: ${stats.fresh} | fetched: ${stats.fetched} | rated: ${stats.updated} | unrated: ${stats.skipped} | errors: ${stats.errors}`);
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
    if (err.message.includes("apply migration 010")) throw err;
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
