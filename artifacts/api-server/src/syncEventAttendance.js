import { createClient } from "@supabase/supabase-js";

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }
  return _supabase;
}

const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";
const SYNC_START_DATE = "2025-01-01T00:00:00.000Z";
const IPP = 100;
const UPSERT_BATCH = 100;
const SIGNUP_FETCH_DELAY_MS = 300;
const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const DEFAULT_TIMEZONE = "America/New_York";

// Win-back window: if a player attends within this many days of receiving a message,
// count it as a conversion
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

async function fetchEventPage(page, endTime, startTime = SYNC_START_DATE) {
  const url =
    `${PODPLAY_BASE}/events` +
    `?startTime=${encodeURIComponent(startTime)}` +
    `&endTime=${encodeURIComponent(endTime)}` +
    `&page=${page}&ipp=${IPP}`;

  const res = await fetch(url, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY },
  });
  if (!res.ok) throw new Error(`PodPlay GET /events page=${page} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchEventSignups(eventId) {
  const url = `${PODPLAY_BASE}/events/${eventId}/signups`;
  const attempt = async () =>
    fetch(url, { headers: { "x-api-key": process.env.PODPLAY_API_KEY } });

  let res = await attempt();
  if (res.status === 429) { await sleep(3000); res = await attempt(); }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`PodPlay GET /events/${eventId}/signups returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.items ?? [];
}

// ─── Win-back attribution ─────────────────────────────────────────────────────

/**
 * For a player who just attended an event, check if they received an outbound
 * message while lapsing/dormant within the win-back window. If so, mark the
 * message as converted and update the player's engagement state.
 */
async function checkAndMarkWinback(playerId, attendedAt, log) {
  const attendedDate = new Date(attendedAt);
  const windowStart = new Date(attendedDate.getTime() - WINBACK_WINDOW_DAYS * 86400000);

  // Find conversations for this player triggered during lapsing/dormant
  const { data: convs } = await getSupabase()
    .from("conversations")
    .select("id, triggered_by")
    .eq("player_id", playerId)
    .in("triggered_by", ["lapsing", "dormant", "bulk", "agent"]);

  if (!convs?.length) return false;

  const convIds = convs.map((c) => c.id);

  // Find an outbound message sent in the win-back window with no conversion yet
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

  // Mark the message as converted
  await getSupabase()
    .from("messages")
    .update({ converted_at: attendedAt })
    .eq("id", msgs[0].id);

  log(`[sync/events] Win-back conversion: player ${playerId} attended after message ${msgs[0].id}`);
  return true;
}

// ─── Main sync ────────────────────────────────────────────────────────────────

export async function syncEventAttendance(log = console.log, isCancelled = () => false, sinceDays = 0) {
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

  // Step 0: Resolve club timezone
  const { data: clubRow } = await getSupabase()
    .from("clubs")
    .select("timezone")
    .eq("id", CLUB_ID)
    .maybeSingle();
  const clubTimezone = clubRow?.timezone ?? DEFAULT_TIMEZONE;
  log(`[sync/events] Using timezone: ${clubTimezone}`);

  // Step 1: Build player lookup map
  log("[sync/events] Loading players from Supabase…");
  const { data: players, error: playersErr } = await getSupabase()
    .from("players")
    .select("id, external_id, name, last_visit_date")
    .not("external_id", "is", null);

  if (playersErr) throw new Error(`Failed to load players: ${playersErr.message}`);

  const playerMap = new Map(players.map((p) => [p.external_id, p]));
  log(`[sync/events] Loaded ${playerMap.size} linked players into lookup map`);

  // Track which players got new attendances this sync for win-back checks
  const newAttendancesByPlayer = new Map(); // player_id -> most recent attended_at

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
      const { error } = await getSupabase()
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
    if (await isCancelled()) throw new CancelledError();

    let pageData;
    try {
      pageData = await fetchEventPage(page, endTime, syncStartTime);
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
        signups = await fetchEventSignups(event.id);
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

        matched++;
        const attendedAt = toLocalDateString(event.startTime, clubTimezone);

        pendingUpserts.push({
          player_id: player.id,
          event_id: event.id,
          program_name: event.name,
          attended_at: attendedAt,
          program_type: event.customType ?? event.type ?? null,
        });

        // Track newest attendance per player for win-back check
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

  // Step 3: Update last_visit_date + check win-backs + cancel pending messages
  log("[sync/events] Updating last_visit_date and checking win-backs…");
  let visitUpdates = 0;

  for (const player of players) {
    if (await isCancelled()) break;

    const { data: latest } = await getSupabase()
      .from("attendances")
      .select("attended_at")
      .eq("player_id", player.id)
      .order("attended_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest?.attended_at) {
      await getSupabase()
        .from("players")
        .update({ last_visit_date: latest.attended_at })
        .eq("id", player.id);
      visitUpdates++;

      // Win-back check: only for players who got a new attendance this sync
      const newAttendance = newAttendancesByPlayer.get(player.id);
      if (newAttendance) {
        const wasWinback = await checkAndMarkWinback(player.id, newAttendance, log);
        if (wasWinback) {
          stats.winbacksDetected++;

          // Cancel any pending queued messages — player is already re-engaged
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
