/**
 * eventFillSync — fetch per-event capacity and final signups from PodPlay
 * and persist to the event_fill table.
 *
 * fill_rate = signups._total / totalTeams
 *   - numerator:   signups._total (all registrants, full-population signal)
 *   - denominator: totalTeams (seat count — do NOT multiply by teamSize)
 *
 * RUNBOOK NOTE: attendances rows are a biased subset of tracked members only.
 * signups._total runs 2–6× our row count per event.  Fill rate must always
 * source both numerator and denominator from the PodPlay API.
 *
 * Modes:
 *   "backfill"     — all past event_ids in attendances since RATING_START
 *   "incremental"  — event_ids from the last N days not yet in event_fill
 *
 * Resumable: event_ids already present in event_fill are skipped.
 */

import { supabase } from "./supabaseClient";
import {
  loadArchetypes,
  classifyEvent,
  isDailyPeak,
  isPeakSeason,
} from "./classifyEvent";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

const RATING_START_ISO = "2026-02-01T05:00:00.000Z";
const DEFAULT_SLEEP_MS = 75;
const DEFAULT_INCREMENTAL_DAYS = 14;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EventFillSyncStats {
  fetched: number;
  skipped_already_recorded: number;
  skipped_future: number;
  skipped_no_capacity: number;
  skipped_canceled: number;
  skipped_no_archetype: number;
  errors: number;
}

interface PodPlayEventDetail {
  id: string;
  name?: string;
  customType?: string;
  tags?: string[];
  startTime?: string;
  isCanceled?: boolean;
  status?: string;
  totalTeams?: number;
  teamSize?: number;
  signups?: { _total?: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchClubConfig(
  clubId: string,
): Promise<{ apiKey: string; apiBase: string }> {
  const { data, error } = await supabase
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .eq("id", clubId)
    .maybeSingle();
  if (error) throw new Error(`eventFillSync fetchClubConfig: ${error.message}`);
  if (!data?.platform_subdomain)
    throw new Error(`Club ${clubId} has no platform_subdomain`);
  return {
    apiKey: data.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "",
    apiBase: `https://${data.platform_subdomain}.podplay.app/apis/v2`,
  };
}

async function fetchEvent(
  apiBase: string,
  apiKey: string,
  eventId: string,
): Promise<PodPlayEventDetail | null> {
  const res = await fetch(`${apiBase}/events/${eventId}`, {
    headers: { "x-api-key": apiKey },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /events/${eventId} → ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<PodPlayEventDetail>;
}

// ── Distinct past event_ids from attendances ───────────────────────────────────

async function loadCandidateEventIds(
  mode: "backfill" | "incremental",
  incrementalDays: number,
): Promise<Set<string>> {
  const now = new Date().toISOString();
  const cutoffStart =
    mode === "backfill"
      ? RATING_START_ISO
      : new Date(Date.now() - incrementalDays * 86_400_000).toISOString();

  const ids = new Set<string>();
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("event_id")
      .not("event_id", "is", null)
      .gte("attended_at", cutoffStart)
      .lt("attended_at", now)           // only events that have already occurred
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`loadCandidateEventIds: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) if (r.event_id) ids.add(r.event_id as string);
    if (data.length < 1000) break;
    page++;
  }
  return ids;
}

async function loadAlreadyRecordedIds(clubId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from("event_fill")
      .select("event_id")
      .eq("club_id", clubId)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`loadAlreadyRecordedIds: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) ids.add(r.event_id as string);
    if (data.length < 1000) break;
    page++;
  }
  return ids;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function syncEventFill(
  clubId: string,
  log: (msg: string) => void,
  opts: {
    mode: "backfill" | "incremental";
    incrementalDays?: number;
    sleepMs?: number;
  },
): Promise<EventFillSyncStats> {
  const { mode, incrementalDays = DEFAULT_INCREMENTAL_DAYS, sleepMs = DEFAULT_SLEEP_MS } = opts;
  const stats: EventFillSyncStats = {
    fetched: 0,
    skipped_already_recorded: 0,
    skipped_future: 0,
    skipped_no_capacity: 0,
    skipped_canceled: 0,
    skipped_no_archetype: 0,
    errors: 0,
  };

  const now = new Date();
  log(`[eventFillSync] mode=${mode}  incrementalDays=${incrementalDays}`);

  // Load archetypes for classifier
  const archetypes = await loadArchetypes(clubId);
  log(`[eventFillSync] ${archetypes.length} archetypes loaded`);

  // Load PodPlay config
  const { apiKey, apiBase } = await fetchClubConfig(clubId);

  // Build candidate and already-recorded sets
  const candidates = await loadCandidateEventIds(mode, incrementalDays);
  const recorded   = await loadAlreadyRecordedIds(clubId);
  log(`[eventFillSync] candidates=${candidates.size}  already_recorded=${recorded.size}`);

  const toFetch = [...candidates].filter((id) => !recorded.has(id));
  log(`[eventFillSync] events to fetch: ${toFetch.length}`);

  if (toFetch.length === 0) {
    log("[eventFillSync] Nothing to fetch — event_fill is up to date");
    return stats;
  }

  const fetchedAt = now.toISOString();
  let processed = 0;

  for (const eventId of toFetch) {
    processed++;
    if (processed % 50 === 0) {
      log(`[eventFillSync] progress: ${processed}/${toFetch.length} (fetched=${stats.fetched} errors=${stats.errors})`);
    }

    try {
      const ev = await fetchEvent(apiBase, apiKey, eventId);
      if (!ev) {
        stats.errors++;
        logger.warn({ eventId }, "[eventFillSync] event not found (404) — skipping");
        await sleep(sleepMs);
        continue;
      }

      // Skip future events (shouldn't happen often, but guard it)
      if (!ev.startTime || new Date(ev.startTime) >= now) {
        stats.skipped_future++;
        await sleep(sleepMs);
        continue;
      }

      // Skip canceled
      if (ev.isCanceled) {
        stats.skipped_canceled++;
        // Still record it (is_canceled=true) so we don't re-fetch
        await supabase.from("event_fill").upsert({
          event_id:      eventId,
          club_id:       clubId,
          archetype_id:  null,
          total_teams:   ev.totalTeams ?? 0,
          final_signups: ev.signups?._total ?? 0,
          fill_rate:     null,
          start_time:    ev.startTime,
          is_daily_peak:  isDailyPeak(ev.startTime),
          is_peak_season: isPeakSeason(ev.startTime),
          is_canceled:   true,
          fetched_at:    fetchedAt,
        }, { onConflict: "event_id" });
        await sleep(sleepMs);
        continue;
      }

      // Capacity guard
      const totalTeams = ev.totalTeams ?? 0;
      if (totalTeams <= 0) {
        stats.skipped_no_capacity++;
        logger.warn({ eventId, name: ev.name }, "[eventFillSync] totalTeams=0 — skipping fill");
        await sleep(sleepMs);
        continue;
      }

      const finalSignups = ev.signups?._total ?? 0;
      const fillRate = finalSignups / totalTeams;

      // Classify to get archetype_id
      const classResult = classifyEvent(
        {
          name: ev.name ?? "",
          podplayType: ev.customType ?? "",
          tags: ev.tags ?? [],
          startTime: ev.startTime,
        },
        archetypes,
      );

      const archetypeId = classResult.isExcluded ? null : classResult.archetypeId;
      if (!archetypeId) stats.skipped_no_archetype++;

      const dp = isDailyPeak(ev.startTime);
      const ps = isPeakSeason(ev.startTime);

      const { error: upsertErr } = await supabase.from("event_fill").upsert(
        {
          event_id:      eventId,
          club_id:       clubId,
          archetype_id:  archetypeId ?? null,
          total_teams:   totalTeams,
          final_signups: finalSignups,
          fill_rate:     Math.round(fillRate * 10000) / 10000,
          start_time:    ev.startTime,
          is_daily_peak:  dp,
          is_peak_season: ps,
          is_canceled:   false,
          fetched_at:    fetchedAt,
        },
        { onConflict: "event_id" },
      );

      if (upsertErr) {
        stats.errors++;
        logger.error({ eventId, upsertErr }, "[eventFillSync] upsert failed");
      } else {
        stats.fetched++;
      }
    } catch (err: any) {
      stats.errors++;
      logger.error({ eventId, err: err.message }, "[eventFillSync] fetch error");
    }

    await sleep(sleepMs);
  }

  log(
    `[eventFillSync] done — fetched=${stats.fetched} ` +
      `skipped_already=${stats.skipped_already_recorded} ` +
      `skipped_future=${stats.skipped_future} ` +
      `skipped_no_cap=${stats.skipped_no_capacity} ` +
      `skipped_canceled=${stats.skipped_canceled} ` +
      `skipped_no_arch=${stats.skipped_no_archetype} ` +
      `errors=${stats.errors}`,
  );

  return stats;
}
