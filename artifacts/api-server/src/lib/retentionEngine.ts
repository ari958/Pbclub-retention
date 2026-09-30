import { supabase } from "./supabaseClient";
import { isTextEligible } from "./retentionPolicy";
import { buildRetentionContext, isLearnToPlayName } from "./retentionContext";
import { writeRetentionText } from "./retentionText";
import { validateRetentionCoupon, type RetentionCouponValidation } from "./retentionCoupons";
import { isAttendanceDateNearRetentionWindow, isRetentionTriggerDate, toEtDate, calendarDayDistance } from "./retentionDates";
import { loadLiveClubCached, verifyRetentionTriggerEvent, type RetentionLiveClub, type VerifiedRetentionTrigger } from "./retentionContext";
import type { RetentionContext, RetentionPlaybook } from "./retentionTypes";

export interface RetentionGenerationResult {
  stats: { created: number; skipped: number };
  errors: string[];
}

const PAGE_SIZE = 1000;
const CONCURRENCY = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tableMissing(message: string) {
  return /retention_(playbooks|candidates|create_draft|update_candidate)|does not exist|schema cache|could not find the table|could not find the function/i.test(message);
}

async function pageAll<T>(queryFactory: (from: number, to: number) => any): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await queryFactory(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []) as T[]);
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function stableBucket(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 10_000;
}

async function withConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(250 * (2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * Creates unscheduled, unapproved drafts only. This function never sends SMS.
 * The unique player/playbook constraint makes repeated nightly runs idempotent.
 */
export async function generateRetentionDrafts(clubId: string): Promise<RetentionGenerationResult> {
  const result: RetentionGenerationResult = { stats: { created: 0, skipped: 0 }, errors: [] };
  const [playbookResult, attendance] = await Promise.all([
    supabase.from("retention_playbooks").select("*").eq("enabled", true),
    pageAll<any>((from, to) => supabase.from("attendances")
      .select("id,player_id,event_id,program_name,attended_at,players!inner(club_id)")
      .eq("players.club_id", clubId).order("attended_at", { ascending: true }).order("id", { ascending: true }).range(from, to)),
  ]);
  if (playbookResult.error) throw new Error(playbookResult.error.message);
  const playbooks = (playbookResult.data ?? []) as RetentionPlaybook[];
  const playbook = playbooks.find((item) => item.key === "ltp_followup");
  if (!playbook) return result;
  const couponCache = new Map<string, Promise<RetentionCouponValidation>>();
  if (playbook.promo_code) {
    couponCache.set(`${clubId}:${playbook.promo_code}`, validateRetentionCoupon(clubId, playbook.promo_code));
  }

  const byPlayer = new Map<string, any[]>();
  for (const row of attendance) {
    if (!row.player_id) continue;
    const list = byPlayer.get(row.player_id) ?? [];
    list.push(row);
    byPlayer.set(row.player_id, list);
  }
  const today = toEtDate(new Date());
  const possibleCandidates: { playerId: string; trigger: any; attendanceDate: string }[] = [];
  for (const [playerId, rows] of byPlayer) {
    rows.sort((a, b) =>
      toEtDate(String(a.attended_at)).localeCompare(toEtDate(String(b.attended_at)))
      || String(a.id).localeCompare(String(b.id)));
    const earliestDate = toEtDate(String(rows[0].attended_at));
    if (!isAttendanceDateNearRetentionWindow(earliestDate, today)) continue;
    const onEarliest = rows.filter((row) => toEtDate(String(row.attended_at)) === earliestDate);
    const ltp = onEarliest.filter((row) => isLearnToPlayName(row.program_name ?? ""));
    if (!ltp.length || onEarliest.some((row) => !isLearnToPlayName(row.program_name ?? ""))) continue;
    const trigger = [...ltp].sort((a, b) =>
      String(a.event_id).localeCompare(String(b.event_id)) || String(a.id).localeCompare(String(b.id)))[0];
    if (!trigger.event_id) { result.stats.skipped++; continue; }
    possibleCandidates.push({ playerId, trigger, attendanceDate: earliestDate });
  }
  if (!possibleCandidates.length) return result;

  const clubCache = new Map<string, Promise<RetentionLiveClub>>();
  const triggerCache = new Map<string, Promise<VerifiedRetentionTrigger>>();
  const candidates: { playerId: string; trigger: any; verifiedDate: string; verifiedName: string }[] = [];
  await withConcurrency(possibleCandidates, CONCURRENCY, async (candidate) => {
    try {
      const verified = await verifyRetentionTriggerEvent(clubId, candidate.trigger.event_id, clubCache, triggerCache);
      if (!isLearnToPlayName(verified.name)) { result.stats.skipped++; return; }
      if (calendarDayDistance(verified.date, candidate.attendanceDate) > 1) {
        throw new Error(`PodPlay event date ${verified.date} does not corroborate attendance date ${candidate.attendanceDate}`);
      }
      if (!isRetentionTriggerDate(verified.date, today)) { result.stats.skipped++; return; }
      candidates.push({ playerId: candidate.playerId, trigger: candidate.trigger, verifiedDate: verified.date, verifiedName: verified.name });
    } catch (error: any) {
      result.errors.push(`${candidate.playerId}: could not verify Learn to Play trigger event ${candidate.trigger.event_id}: ${error.message}`);
    }
  });
  if (!candidates.length) return result;

  const playerIds = candidates.map((c) => c.playerId);
  const players = await pageAll<any>((from, to) => supabase.from("players")
    .select("id,name,external_id,phone,opted_out,sms_opt_in,consent_source,sms_consented_at,club_id")
    .eq("club_id", clubId).in("id", playerIds).range(from, to));
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const eventIds = [...new Set(candidates.map((c) => c.trigger.event_id).filter(Boolean))];
  const classRows = eventIds.length ? await pageAll<any>((from, to) => supabase.from("attendances")
    .select("event_id,player_id,players!inner(club_id)").eq("players.club_id", clubId)
    .in("event_id", eventIds).range(from, to)) : [];
  const classPlayers = new Map<string, Set<string>>();
  for (const row of classRows) {
    const list = classPlayers.get(row.event_id) ?? new Set<string>();
    list.add(row.player_id);
    classPlayers.set(row.event_id, list);
  }
  const classPlayerIds = [...new Set(classRows.map((row: any) => row.player_id))];
  const classRoster = classPlayerIds.length ? await pageAll<any>((from, to) => supabase.from("players")
    .select("id,external_id").eq("club_id", clubId).in("id", classPlayerIds).range(from, to)) : [];
  const externalIds = new Map([...players, ...classRoster].map((player) => [player.id, player.external_id]));
  const socialEventsCache = new Map<string, Promise<any[]>>();
  const socialSignupsCache = new Map<string, Promise<string[]>>();
  await withConcurrency(candidates, CONCURRENCY, async ({ playerId, trigger, verifiedDate, verifiedName }) => {
    const player = playerMap.get(playerId);
    if (!player || !isTextEligible(player)) { result.stats.skipped++; return; }
    if (stableBucket(`${playerId}:${playbook.key}`) < Number(playbook.holdout_pct ?? 0) * 100) {
      result.stats.skipped++;
      return;
    }
    try {
      const classmatesExternalIds = [...(classPlayers.get(trigger.event_id) ?? [])]
        .filter((id) => id !== playerId).map((id) => externalIds.get(id)).filter(Boolean) as string[];
      await retryWithBackoff(async () => {
        const context: RetentionContext = await buildRetentionContext({
          clubId, player, playbook,
          trigger: { event_id: trigger.event_id, name: verifiedName, date: verifiedDate },
          classmatesExternalIds,
          socialEventsCache,
          socialSignupsCache,
          clubCache,
          couponCache,
        });
        const body = await writeRetentionText(context, playbook);
        const { data: candidateId, error } = await supabase.rpc("retention_create_draft", {
          p_club_id: clubId,
          p_player_id: playerId,
          p_playbook_key: playbook.key,
          p_trigger_event_id: trigger.event_id,
          p_context: context,
          p_body: body,
        });
        if (error) throw new Error(error.message);
        if (candidateId) result.stats.created++;
        else result.stats.skipped++;
      });
    } catch (error: any) {
      result.errors.push(`${player.name ?? playerId}: ${error.message}`);
    }
  });
  return result;
}

export function isRetentionSchemaMissing(error: unknown): boolean {
  return tableMissing(error instanceof Error ? error.message : String(error));
}