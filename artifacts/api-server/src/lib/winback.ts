/**
 * Nightly lapsing-regular win-back drafts. Rules live in winbackRules.ts.
 *
 * Each run:
 *   1. Refreshes win-back drafts still waiting for approval from earlier days
 *      (new date, live session check), or skips them when the player booked,
 *      came back, or the draft is older than WINBACK_DRAFT_MAX_AGE_DAYS.
 *   2. Finds regulars who are overdue today and drafts one text each, through
 *      retention_winback_create_candidate (migration 032). 20% are recorded as
 *      a skipped "holdout" row with no text, for measuring lift.
 * Players are skipped without a row (and re-checked the next night) when they
 * already have an upcoming booking, were texted recently, or PodPlay could not
 * be checked. Drafts are never approved here; see retentionAutoApprove.ts.
 */
import { supabase } from "./supabaseClient";
import { logger } from "./logger";
import { sanitizeScheduledSendAt } from "./playerTiming";
import { calendarDayDistance, toEtDate } from "./retentionDates";
import { buildRetentionContext, RetentionContextError, type RetentionLiveClub } from "./retentionContext";
import { RetentionPodplayBatchClient } from "./retentionPodplayBatch";
import type { RetentionCouponValidation } from "./retentionCoupons";
import type { RetentionContext, RetentionPlaybook } from "./retentionTypes";
import {
  buildWinbackText,
  evaluateWinbackLapse,
  isWinbackSessionUsable,
  validateWinbackText,
  winbackContactBlock,
  winbackHoldoutBucket,
  WINBACK_DRAFT_MAX_AGE_DAYS,
  WINBACK_MAX_DATA_AGE_DAYS,
  WINBACK_MIN_GAP_DAYS,
  WINBACK_PLAYBOOK_KEY,
  type WinbackLapse,
  type WinbackVisit,
} from "./winbackRules";

export const WINBACK_BOOKING_URL = "https://pbclub.podplay.app";
const PAGE = 1000;

export interface WinbackPlayer {
  id: string;
  name: string | null;
  phone: string | null;
  opted_out: boolean | null;
  external_id: string | null;
}

export interface WinbackPlaybook {
  key: string;
  name: string;
  enabled: boolean;
  holdout_pct: number;
  booking_url: string | null;
}

export interface WinbackLiveFacts {
  already_booked: boolean;
  session: { event_id: string; name: string; start_time: string; signup_url: string; spots_remaining: number } | null;
  diagnostics: Record<string, unknown>;
}

export interface WinbackDraftRow {
  id: string;
  player_id: string;
  trigger_event_id: string;
  context: RetentionContext;
  updated_at: string;
  created_at: string;
  message_id: string | null;
}

export interface WinbackDeps {
  now: () => Date;
  loadPlaybook: () => Promise<WinbackPlaybook | null>;
  ready: () => Promise<boolean>;
  loadVisits: (clubId: string) => Promise<Map<string, WinbackVisit[]>>;
  loadPlayers: (clubId: string, ids: string[]) => Promise<Map<string, WinbackPlayer>>;
  /** Player ids with a win-back row in the last 90 days, or an approved one. */
  loadRecentWinback: (ids: string[]) => Promise<Set<string>>;
  /** Player ids with a Learn to Play candidate in the last 21 days. */
  loadRecentLtp: (ids: string[]) => Promise<Set<string>>;
  /** Sent outbound texts in the last 30 days, per player. */
  loadSentTexts: (ids: string[]) => Promise<Map<string, string[]>>;
  liveFacts: (clubId: string, player: WinbackPlayer, usualProgram: string | null) => Promise<WinbackLiveFacts>;
  createCandidate: (args: {
    clubId: string; playerId: string; triggerKey: string; context: RetentionContext;
    status: "drafted" | "skipped"; body: string | null;
  }) => Promise<string | null>;
  loadOpenDrafts: (clubId: string) => Promise<WinbackDraftRow[]>;
  loadMessageBody: (messageId: string) => Promise<string | null>;
  regenerate: (args: {
    clubId: string; row: WinbackDraftRow; expectedBody: string | null;
    newContext: RetentionContext; status: "drafted" | "skipped"; body: string | null;
  }) => Promise<void>;
}

export interface WinbackRunResult {
  status: "ran" | "disabled" | "not_installed" | "stale_data";
  data_through: string | null;
  evaluated: number;
  lapsing: number;
  drafted: number;
  holdout: number;
  refreshed: number;
  skipped_by_reason: Record<string, number>;
  errors: string[];
}

function firstName(name: string | null): string {
  return name?.trim().split(/\s+/)[0] ?? "";
}

function intendedSendAt(now: Date): Date {
  return sanitizeScheduledSendAt(new Date(now.getTime() + 60_000)) ?? new Date(now.getTime() + 60_000);
}

/** The text and context for one player today. */
export function composeWinbackDraft(args: {
  player: WinbackPlayer;
  lapse: WinbackLapse;
  facts: WinbackLiveFacts;
  now: Date;
  bookingUrl: string;
}): { body: string; context: RetentionContext } {
  const sendAt = intendedSendAt(args.now);
  const sendDate = toEtDate(sendAt);
  const session = args.facts.session && isWinbackSessionUsable(args.facts.session.start_time, sendAt)
    ? args.facts.session : null;
  const first = firstName(args.player.name);
  const base = (withSession: boolean): RetentionContext => ({
    variant: withSession ? "with_program" : "no_program",
    trigger: { event_id: args.lapse.trigger_key, name: args.lapse.usual_program ?? "Regular play", date: args.lapse.last_visit },
    player_first_name: first,
    next_program: withSession && session ? {
      event_id: session.event_id, name: session.name.trim(), start_time: session.start_time,
      date: toEtDate(session.start_time), time: "", signup_url: session.signup_url,
      spots_remaining: session.spots_remaining,
    } : null,
    booking_url: args.bookingUrl,
    classmates_signed_up: 0,
    already_booked: false,
    booked_event: null,
    promo: null,
    coupon_warning: null,
    evaluated_at: args.now.toISOString(),
    send_date_et: sendDate,
    draft_generated_at: args.now.toISOString(),
    diagnostics: args.facts.diagnostics,
    winback: { ...args.lapse },
  });
  const seed = `${args.player.id}:${args.lapse.trigger_key}`;
  if (session) {
    const built = buildWinbackText({ firstName: first, session, sendDate, bookingUrl: args.bookingUrl, seed });
    const context = base(true);
    // Event names can carry prices ("$20 Morning Open Play"); fall back to the generic text.
    if (!validateWinbackText(built.body, context).length) {
      return { body: built.body, context: { ...context, winback: { ...args.lapse, template: built.template, template_index: built.template_index, when: built.when } } };
    }
  }
  const built = buildWinbackText({ firstName: first, session: null, sendDate, bookingUrl: args.bookingUrl, seed });
  const context = base(false);
  return { body: built.body, context: { ...context, winback: { ...args.lapse, template: built.template, template_index: built.template_index, when: null } } };
}

function skippedContext(base: Partial<RetentionContext>, reason: string, now: Date): RetentionContext {
  return {
    trigger: base.trigger ?? { event_id: "", name: "", date: "" },
    player_first_name: base.player_first_name ?? "",
    next_program: null,
    classmates_signed_up: 0,
    already_booked: false,
    booked_event: null,
    promo: null,
    coupon_warning: null,
    ...base,
    evaluated_at: now.toISOString(),
    reason,
  } as RetentionContext;
}

export async function runWinback(clubId: string, deps: WinbackDeps = defaultWinbackDeps): Promise<WinbackRunResult> {
  const now = deps.now();
  const today = toEtDate(now);
  const result: WinbackRunResult = {
    status: "ran", data_through: null, evaluated: 0, lapsing: 0, drafted: 0, holdout: 0, refreshed: 0,
    skipped_by_reason: {}, errors: [],
  };
  const skip = (reason: string) => { result.skipped_by_reason[reason] = (result.skipped_by_reason[reason] ?? 0) + 1; };

  if (!(await deps.ready())) return { ...result, status: "not_installed" };
  const playbook = await deps.loadPlaybook();
  if (!playbook?.enabled) return { ...result, status: "disabled" };
  const bookingUrl = playbook.booking_url ?? WINBACK_BOOKING_URL;

  const visits = await deps.loadVisits(clubId);
  let dataThrough: string | null = null;
  for (const list of visits.values()) for (const visit of list) {
    if (visit.date <= today && (!dataThrough || visit.date > dataThrough)) dataThrough = visit.date;
  }
  result.data_through = dataThrough;
  if (!dataThrough || calendarDayDistance(today, dataThrough) > WINBACK_MAX_DATA_AGE_DAYS) {
    return { ...result, status: "stale_data" };
  }

  // 1. Refresh or retire drafts still waiting from earlier days.
  for (const row of await deps.loadOpenDrafts(clubId)) {
    try {
      const sendDate = toEtDate(intendedSendAt(now));
      if (row.context?.send_date_et === sendDate) continue;
      const players = await deps.loadPlayers(clubId, [row.player_id]);
      const player = players.get(row.player_id);
      const expectedBody = row.message_id ? await deps.loadMessageBody(row.message_id) : null;
      const retire = async (reason: string) => {
        await deps.regenerate({ clubId, row, expectedBody, newContext: skippedContext(row.context, reason, now), status: "skipped", body: null });
        skip(`draft_${reason}`);
      };
      const lapse = evaluateWinbackLapse(visits.get(row.player_id) ?? [], today);
      if (!player || player.opted_out || !player.phone?.trim()) { await retire("not_textable"); continue; }
      if (calendarDayDistance(today, toEtDate(row.created_at)) > WINBACK_DRAFT_MAX_AGE_DAYS) { await retire("expired"); continue; }
      const lastVisit = (row.context as any)?.winback?.last_visit as string | undefined;
      const returned = (visits.get(row.player_id) ?? []).some((visit) => !!lastVisit && visit.date > lastVisit);
      if (returned) { await retire("returned"); continue; }
      const facts = await deps.liveFacts(clubId, player, lapse?.usual_program ?? (row.context as any)?.winback?.usual_program ?? null);
      if (facts.already_booked) { await retire("booked"); continue; }
      const lapseForText: WinbackLapse = lapse ?? (row.context as any).winback;
      const draft = composeWinbackDraft({ player, lapse: { ...lapseForText, trigger_key: row.trigger_event_id }, facts, now, bookingUrl });
      await deps.regenerate({ clubId, row, expectedBody, newContext: draft.context, status: "drafted", body: draft.body });
      result.refreshed++;
    } catch (error) {
      result.errors.push(`Refresh ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2. New lapses today.
  const lapses = new Map<string, WinbackLapse>();
  for (const [playerId, list] of visits) {
    result.evaluated++;
    const lapse = evaluateWinbackLapse(list, today);
    if (lapse) lapses.set(playerId, lapse);
  }
  result.lapsing = lapses.size;
  if (!lapses.size) return result;
  const ids = [...lapses.keys()];
  const [players, recentWinback, recentLtp, sentTexts] = await Promise.all([
    deps.loadPlayers(clubId, ids), deps.loadRecentWinback(ids), deps.loadRecentLtp(ids), deps.loadSentTexts(ids),
  ]);
  const holdoutCut = Number(playbook.holdout_pct ?? 0) * 100;

  for (const [playerId, lapse] of lapses) {
    try {
      const player = players.get(playerId);
      if (!player) { skip("player_missing"); continue; }
      if (player.opted_out) { skip("opted_out"); continue; }
      if (!player.phone?.trim()) { skip("no_phone"); continue; }
      if (!firstName(player.name)) { skip("no_name"); continue; }
      if (recentWinback.has(playerId)) { skip("winback_in_last_90_days"); continue; }
      if (recentLtp.has(playerId)) { skip("in_learn_to_play_followup"); continue; }
      const contactBlock = winbackContactBlock({ sent_at: sentTexts.get(playerId) ?? [] }, now);
      if (contactBlock) { skip(contactBlock); continue; }
      let facts: WinbackLiveFacts;
      try {
        facts = await deps.liveFacts(clubId, player, lapse.usual_program);
      } catch (error) {
        skip("podplay_check_failed");
        result.errors.push(`PodPlay check for ${playerId}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (facts.already_booked) { skip("already_booked"); continue; }
      const draft = composeWinbackDraft({ player, lapse, facts, now, bookingUrl });
      if (winbackHoldoutBucket(playerId, lapse.trigger_key) < holdoutCut) {
        const id = await deps.createCandidate({
          clubId, playerId, triggerKey: lapse.trigger_key,
          context: skippedContext(draft.context, "holdout", now), status: "skipped", body: null,
        });
        if (id) result.holdout++; else skip("winback_in_last_90_days");
        continue;
      }
      const errors = validateWinbackText(draft.body, draft.context);
      if (errors.length) { skip("text_failed_checks"); result.errors.push(`${playerId}: ${errors.join("; ")}`); continue; }
      const id = await deps.createCandidate({
        clubId, playerId, triggerKey: lapse.trigger_key, context: draft.context, status: "drafted", body: draft.body,
      });
      if (id) result.drafted++; else skip("winback_in_last_90_days");
    } catch (error) {
      result.errors.push(`${playerId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

async function pageAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

async function inChunks<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) rows.push(...await load(ids.slice(offset, offset + 200)));
  return rows;
}

function winbackPlaybookForContext(usualProgram: string | null): RetentionPlaybook {
  return {
    key: WINBACK_PLAYBOOK_KEY, name: "Lapsing regular win-back", enabled: true,
    promo_code: null, offer_text: null, next_program_names: usualProgram ? [usualProgram] : [],
    message_guidance: null, holdout_pct: 0,
  };
}

function makeLiveFacts() {
  const caches = {
    events: new Map<string, Promise<any[]>>(),
    signups: new Map<string, Promise<string[]>>(),
    club: new Map<string, Promise<RetentionLiveClub>>(),
    coupon: new Map<string, Promise<RetentionCouponValidation>>(),
    client: new RetentionPodplayBatchClient(),
  };
  return async (clubId: string, player: WinbackPlayer, usualProgram: string | null): Promise<WinbackLiveFacts> => {
    if (!player.external_id) throw new Error("Player has no PodPlay id; upcoming bookings cannot be checked");
    try {
      const context = await buildRetentionContext({
        clubId,
        player: { id: player.id, name: player.name ?? "", external_id: player.external_id },
        playbook: winbackPlaybookForContext(usualProgram),
        trigger: { event_id: "", name: usualProgram ?? "", date: "" },
        classmatesExternalIds: [],
        socialEventsCache: caches.events,
        socialSignupsCache: caches.signups,
        clubCache: caches.club,
        couponCache: caches.coupon,
        batchClient: caches.client,
      });
      return {
        already_booked: context.already_booked,
        session: context.next_program ? {
          event_id: context.next_program.event_id, name: context.next_program.name, start_time: context.next_program.start_time,
          signup_url: context.next_program.signup_url, spots_remaining: context.next_program.spots_remaining,
        } : null,
        diagnostics: (context.diagnostics ?? {}) as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof RetentionContextError) throw new Error(error.message);
      throw error;
    }
  };
}

let liveFactsForRun = makeLiveFacts();

export const defaultWinbackDeps: WinbackDeps = {
  now: () => new Date(),
  async ready() {
    const { data, error } = await supabase.rpc("retention_winback_ready");
    return !error && data === true;
  },
  async loadPlaybook() {
    const { data, error } = await supabase.from("retention_playbooks")
      .select("key,name,enabled,holdout_pct,booking_url").eq("key", WINBACK_PLAYBOOK_KEY).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as WinbackPlaybook | null) ?? null;
  },
  async loadVisits(clubId) {
    liveFactsForRun = makeLiveFacts(); // fresh PodPlay caches per run
    const rows = await pageAll<{ player_id: string; attended_at: string; program_name: string | null }>((from, to) =>
      supabase.from("attendances").select("player_id,attended_at,program_name")
        .eq("club_id", clubId).not("player_id", "is", null)
        .order("attended_at", { ascending: true }).order("id", { ascending: true }).range(from, to));
    const visits = new Map<string, WinbackVisit[]>();
    for (const row of rows) {
      const list = visits.get(row.player_id) ?? [];
      list.push({ date: toEtDate(row.attended_at), program: row.program_name });
      visits.set(row.player_id, list);
    }
    return visits;
  },
  async loadPlayers(clubId, ids) {
    const rows = await inChunks(ids, async (chunk) => {
      const { data, error } = await supabase.from("players")
        .select("id,name,phone,opted_out,external_id").eq("club_id", clubId).in("id", chunk);
      if (error) throw new Error(error.message);
      return (data ?? []) as WinbackPlayer[];
    });
    return new Map(rows.map((row) => [row.id, row]));
  },
  async loadRecentWinback(ids) {
    const since = new Date(Date.now() - WINBACK_MIN_GAP_DAYS * 86_400_000).toISOString();
    const rows = await inChunks(ids, async (chunk) => {
      const { data, error } = await supabase.from("retention_candidates")
        .select("player_id,created_at,status").eq("playbook_key", WINBACK_PLAYBOOK_KEY)
        .is("prelaunch_superseded_by", null).in("player_id", chunk);
      if (error) throw new Error(error.message);
      return (data ?? []) as { player_id: string; created_at: string; status: string }[];
    });
    return new Set(rows.filter((row) => row.created_at > since || row.status === "approved").map((row) => row.player_id));
  },
  async loadRecentLtp(ids) {
    const since = new Date(Date.now() - 21 * 86_400_000).toISOString();
    const rows = await inChunks(ids, async (chunk) => {
      const { data, error } = await supabase.from("retention_candidates")
        .select("player_id").eq("playbook_key", "ltp_followup").gte("created_at", since).in("player_id", chunk);
      if (error) throw new Error(error.message);
      return (data ?? []) as { player_id: string }[];
    });
    return new Set(rows.map((row) => row.player_id));
  },
  async loadSentTexts(ids) {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rows = await inChunks(ids, async (chunk) => {
      const { data, error } = await supabase.from("messages")
        .select("player_id,sent_at").eq("direction", "outbound").not("sent_at", "is", null)
        .gte("sent_at", since).in("player_id", chunk);
      if (error) throw new Error(error.message);
      return (data ?? []) as { player_id: string; sent_at: string }[];
    });
    const byPlayer = new Map<string, string[]>();
    for (const row of rows) byPlayer.set(row.player_id, [...(byPlayer.get(row.player_id) ?? []), row.sent_at]);
    return byPlayer;
  },
  liveFacts: (clubId, player, usualProgram) => liveFactsForRun(clubId, player, usualProgram),
  async createCandidate(args) {
    const { data, error } = await supabase.rpc("retention_winback_create_candidate", {
      p_club_id: args.clubId,
      p_player_id: args.playerId,
      p_trigger_key: args.triggerKey,
      p_context: args.context,
      p_status: args.status,
      p_body: args.body,
      p_min_gap_days: WINBACK_MIN_GAP_DAYS,
    });
    if (error) throw new Error(error.message);
    return (data as string | null) ?? null;
  },
  async loadOpenDrafts(clubId) {
    const { data, error } = await supabase.from("retention_candidates")
      .select("id,player_id,trigger_event_id,context,updated_at,created_at,message_id")
      .eq("club_id", clubId).eq("playbook_key", WINBACK_PLAYBOOK_KEY).eq("status", "drafted")
      .is("prelaunch_superseded_by", null).limit(500);
    if (error) throw new Error(error.message);
    return (data ?? []) as WinbackDraftRow[];
  },
  async loadMessageBody(messageId) {
    const { data, error } = await supabase.from("messages").select("body").eq("id", messageId).maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.body as string | null) ?? null;
  },
  async regenerate({ clubId, row, expectedBody, newContext, status, body }) {
    const { error } = await supabase.rpc("retention_regenerate_draft", {
      p_id: row.id,
      p_club_id: clubId,
      p_expected_body: expectedBody,
      p_expected_context: row.context,
      p_expected_updated_at: row.updated_at,
      p_new_body: body,
      p_new_context: newContext,
      p_new_status: status,
      p_error: status === "skipped" ? `winback: ${(newContext as any).reason ?? "skipped"}` : null,
    });
    if (error) throw new Error(error.message);
  },
};

export function logWinbackResult(result: WinbackRunResult) {
  logger.info({ winback: result }, "[winback] run finished");
}
