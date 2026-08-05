import { createClient } from "@supabase/supabase-js";
import { computePlayerTiming } from "./lib/playerTiming.js";

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

const SYNC_START_DATE = "2025-01-01T00:00:00.000Z";
const IPP = 100;
const UPSERT_BATCH = 100;
const SIGNUP_FETCH_DELAY_MS = 300;
const DEFAULT_TIMEZONE = "America/New_York";

// Canonical skill-level tags on PodPlay events — order matters (most specific first)
const SKILL_LEVEL_TAGS = [
  "Beginner",
  "Advanced Beginner",
  "Low Intermediate",
  "Intermediate",
  "Advanced Intermediate",
  "All Levels",
  "All Level",
];

function extractSkillLevel(tags) {
  if (!Array.isArray(tags)) return null;
  for (const level of SKILL_LEVEL_TAGS) {
    if (tags.includes(level)) return level;
  }
  return null;
}

const PROGRAM_NAME_CANONICAL_MAP = {
  "Advanced Intermediate Open Play (3.50-3.99)": "Advanced Intermediate Open Play (3.5-3.99)",
  "Advanced Intermediate Open Play 3.5+":        "Advanced Intermediate Open Play (3.5-3.99)",
};

const _programNameLoggedPairs = new Set();

function normalizeProgramName(name, log) {
  if (name === null || name === undefined) return name;

  const original = name;
  let normalized = name.trim().replace(/\s{2,}/g, " ");
  const canonical = PROGRAM_NAME_CANONICAL_MAP[normalized];
  if (canonical) normalized = canonical;

  if (normalized !== original) {
    const pair = `${original}→${normalized}`;
    if (!_programNameLoggedPairs.has(pair)) {
      _programNameLoggedPairs.add(pair);
      log(`[sync/events] normalizeProgramName: "${original}" → "${normalized}"`);
    }
  }

  return normalized;
}

const WINBACK_WINDOW_DAYS = 14;

function toLocalDateString(isoString, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoString));
}

class CancelledError extends Error {
  constructor() {
    super("Event sync cancelled by operator");
    this.name = "CancelledError";
  }
}

async function fetchEventPage(podplayBase, apiKey, page, endTime, startTime = SYNC_START_DATE) {
  const url =
    `${podplayBase}/apis/v2/events` +
    `?startTime=${encodeURIComponent(startTime)}` +
    `&endTime=${encodeURIComponent(endTime)}` +
    `&page=${page}&ipp=${IPP}`;

  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`PodPlay GET /events page=${page} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchEventSignups(podplayBase, apiKey, eventId) {
  const url = `${podplayBase}/apis/v2/events/${eventId}/signups`;
  const attempt = async () =>
    fetch(url, { headers: { "x-api-key": apiKey } });

  let res = await attempt();
  if (res.status === 429) { await sleep(3000); res = await attempt(); }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`PodPlay GET /events/${eventId}/signups returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.items ?? [];
}

// ─── Win-back attribution ─────────────────────────────────────────────────────

async function checkAndMarkWinback(playerId, attendedAt, log) {
  const attendedDate = new Date(attendedAt);
  const windowStart = new Date(attendedDate.getTime() - WINBACK_WINDOW_DAYS * 86400000);

  const { data: convs } = await getSupabase()
    .from("conversations")
    .select("id, triggered_by")
    .eq("player_id", playerId)
    .in("triggered_by", ["lapsing", "dormant", "bulk", "agent"]);

  if (!convs?.length) return false;

  const convIds = convs.map((c) => c.id);

  const { data: msgs } = await getSupabase()
    .from("messages")
    .select("id, sent_at")
    .in("conversation_id", convIds)
    .eq("direction", "outbound")
    .eq("status", "sent")
    .is("converted_at", null)
    .gte("sent_at", windowStart.toISOString())
    .lte("sent_at", attendedDate.toISOString())
    .order("sent_at", { ascending: false })
    .limit(1);

  if (!msgs?.length) return false;

  await getSupabase()
    .from("messages")
    .update({ converted_at: attendedAt })
    .eq("id", msgs[0].id);

  log(`[sync/events] Win-back conversion: player ${playerId} attended after message ${msgs[0].id}`);
  return true;
}

// Signups with these statuses are written as attendance rows for tracked members.
// ⚠  INVALID is intentionally absent here — it SHOULD be included to capture
//    series-pass clinic participants (Path to Intermediate etc.) whose signups
//    land in INVALID status after the session runs. Omitting it is why those
//    events show 2-3 local attendance rows instead of the full 4 PodPlay
//    signups (Phase 2.2 finding). This is a known gap; fixing it requires a
//    separate decision on whether to re-sync historical clinic attendance.
//    See signupStatus.ts and the INACTIVE_SIGNUP_STATUSES note there.
const VALID_SIGNUP_STATUSES = new Set(["CONFIRMED", "CHECKED_IN"]);

// ─── Main sync ────────────────────────────────────────────────────────────────

export async function syncEventAttendance(clubId, log = console.log, isCancelled = () => false, sinceDays = 0) {
  if (!clubId) throw new Error("syncEventAttendance requires clubId");

  const stats = {
    eventsScanned: 0,
    eventsPast: 0,
    eventsSkipped: 0,
    signupsFetched: 0,
    signupsMatched: 0,
    signupsUnmatched: 0,
    attendancesUpserted: 0,
    winbacksDetected: 0,
    errors: 0,
  };

  // Step 0: Resolve club details
  const { data: clubRow } = await getSupabase()
    .from("clubs")
    .select("platform_api_key, platform_subdomain, timezone")
    .eq("id", clubId)
    .maybeSingle();

  if (!clubRow) throw new Error(`No club with id=${clubId}`);
  if (!clubRow.platform_subdomain) throw new Error(`Club ${clubId} has no platform_subdomain`);

  const podplayBase = `https://${clubRow.platform_subdomain}.podplay.app`;
  const apiKey = clubRow.platform_api_key ?? process.env.PODPLAY_API_KEY;
  const clubTimezone = clubRow.timezone ?? DEFAULT_TIMEZONE;
  log(`[sync/events] Using timezone: ${clubTimezone}`);

  // Step 1: Build player lookup map
  log("[sync/events] Loading players from Supabase…");
  const allPlayers = [];
  {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await getSupabase()
        .from("players")
        .select("id, external_id, name, last_visit_date")
        .eq("club_id", clubId)
        .not("external_id", "is", null)
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`Failed to load players (offset ${offset}): ${error.message}`);
      allPlayers.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
    }
  }

  const playerMap = new Map(allPlayers.map((p) => [p.external_id, p]));
  log(`[sync/events] Loaded ${playerMap.size} linked players into lookup map`);

  const newAttendancesByPlayer = new Map();

  // Step 2: Paginate through all past events
  const endTime = new Date().toISOString();
  const now = new Date();
  const syncStartTime = sinceDays > 0
    ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
    : SYNC_START_DATE;
  if (sinceDays > 0) {
    log(`[sync/events] Incremental mode: events since ${syncStartTime} (last ${sinceDays} days)`);
  }
  let page = 1;
  const pendingUpserts = [];

  async function flushUpserts() {
    if (pendingUpserts.length === 0) return;
    for (let i = 0; i < pendingUpserts.length; i += UPSERT_BATCH) {
      const batch = pendingUpserts.slice(i, i + UPSERT_BATCH);
      // ignoreDuplicates: true — attendance rows are write-once.
      // If PodPlay later updates a signup's booked_at (e.g. reschedule), we
      // intentionally keep the original value recorded at first-sync time.
      // Changing this to false would silently overwrite booking timestamps and
      // corrupt player-timing analytics. See RUNBOOK open item 15.
      const { error } = await getSupabase()
        .from("attendances")
        .upsert(batch, {
          onConflict: "player_id,event_id",
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
    if (await isCancelled()) throw new CancelledError();

    let pageData;
    try {
      pageData = await fetchEventPage(podplayBase, apiKey, page, endTime, syncStartTime);
    } catch (err) {
      log(`[sync/events] ERROR fetching events page ${page}: ${err.message}`);
      stats.errors++;
      break;
    }

    const items = pageData.items ?? [];
    stats.eventsScanned += items.length;

    const pastEvents = items.filter(
      (e) => !e.isCanceled && new Date(e.startTime) <= now
    );
    stats.eventsPast += pastEvents.length;
    stats.eventsSkipped += items.length - pastEvents.length;

    log(
      `[sync/events] Page ${page}: ${items.length} events total, ` +
      `${pastEvents.length} past & active, ${items.length - pastEvents.length} skipped`
    );

    for (const event of pastEvents) {
      if (await isCancelled()) throw new CancelledError();

      await sleep(SIGNUP_FETCH_DELAY_MS);

      let signups;
      try {
        signups = await fetchEventSignups(podplayBase, apiKey, event.id);
      } catch (err) {
        log(`[sync/events] ERROR fetching signups for event ${event.id} (${event.name}): ${err.message}`);
        stats.errors++;
        continue;
      }

      stats.signupsFetched += signups.length;

      let matched = 0;
      let unmatched = 0;

      for (const signup of signups) {
        const externalId = signup.owner?.id;
        if (!externalId) { unmatched++; continue; }

        const player = playerMap.get(externalId);
        if (!player) { unmatched++; continue; }

        const signupStatus = (signup.status ?? "").toUpperCase();
        if (signupStatus && !VALID_SIGNUP_STATUSES.has(signupStatus)) {
          unmatched++;
          continue;
        }

        matched++;
        const attendedAt = event.startTime;

        const rawSessionType = event.sessionType ?? null;
        const SESSION_TYPE_WHITELIST = new Set(["clinic", "open_play", "drilling", "trial", "intro"]);
        const session_type =
          rawSessionType && SESSION_TYPE_WHITELIST.has(rawSessionType.toLowerCase())
            ? rawSessionType.toLowerCase()
            : null;

        const bookedAt = signup.summary?.invitation?.createdDate ?? null;

        pendingUpserts.push({
          player_id: player.id,
          event_id: event.id,
          program_name: normalizeProgramName(event.name, log),
          attended_at: attendedAt,
          program_type: event.customType ?? event.type ?? null,
          level: extractSkillLevel(event.tags),
          session_type,
          booked_at: bookedAt,
        });

        const existing = newAttendancesByPlayer.get(player.id);
        if (!existing || attendedAt > existing) {
          newAttendancesByPlayer.set(player.id, attendedAt);
        }
      }

      stats.signupsMatched += matched;
      stats.signupsUnmatched += unmatched;

      if (signups.length > 0) {
        log(
          `[sync/events] Event "${event.name}" (${event.startTime.slice(0, 10)}): ` +
          `${signups.length} signups — ${matched} matched, ${unmatched} unmatched`
        );
      }

      if (pendingUpserts.length >= UPSERT_BATCH) {
        await flushUpserts();
      }
    }

    if (items.length < IPP) break;
    page++;
  }

  await flushUpserts();

  // Step 3: Update last_visit_date + check win-backs
  log("[sync/events] Updating last_visit_date and checking win-backs…");
  let visitUpdates = 0;

  for (const player of allPlayers) {
    if (await isCancelled()) break;

    const { data: latest } = await getSupabase()
      .from("attendances")
      .select("attended_at")
      .eq("player_id", player.id)
      .order("attended_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest?.attended_at) {
      const localDate = toLocalDateString(latest.attended_at, clubTimezone);
      await getSupabase()
        .from("players")
        .update({ last_visit_date: localDate })
        .eq("id", player.id);
      visitUpdates++;

      try {
        await computePlayerTiming(player.id, true);
      } catch (err) {
        log(`[sync/events] WARN: computePlayerTiming failed for ${player.id}: ${err?.message ?? err}`);
      }

      const newAttendance = newAttendancesByPlayer.get(player.id);
      if (newAttendance) {
        const wasWinback = await checkAndMarkWinback(player.id, newAttendance, log);
        if (wasWinback) {
          stats.winbacksDetected++;

          const { data: convs } = await getSupabase()
            .from("conversations")
            .select("id")
            .eq("player_id", player.id);

          if (convs?.length) {
            await getSupabase()
              .from("messages")
              .update({
                status: "skipped",
                error_message: "Player re-engaged — attended event after outreach",
              })
              .in("conversation_id", convs.map((c) => c.id))
              .eq("status", "pending");
          }
        }
      }
    }
  }

  log(`[sync/events] Updated last_visit_date for ${visitUpdates} players`);
  log(`[sync/events] Win-backs detected: ${stats.winbacksDetected}`);

  log(
    `[sync/events] ── Complete ──\n` +
    `  Events scanned: ${stats.eventsScanned} | Past/active: ${stats.eventsPast} | Skipped: ${stats.eventsSkipped}\n` +
    `  Signups fetched: ${stats.signupsFetched} | Matched: ${stats.signupsMatched} | Unmatched: ${stats.signupsUnmatched}\n` +
    `  Attendance records upserted: ${stats.attendancesUpserted} | Win-backs: ${stats.winbacksDetected} | Errors: ${stats.errors}`
  );

  return stats;
}
