/**
 * Retention scorecard: is each effort running, working, and annoying anyone?
 * Read-only. Powers GET /api/retention/scorecard and the Monday email.
 *
 * "Came back" is measured one way for every flow: the player has an attendance
 * row (a session they played) within N days after the anchor date.
 *   - Learn to Play: anchor = step-1 text sent; counts only non-Learn-to-Play
 *     sessions. Baseline = Learn to Play first-timers in the 6 months before
 *     texting began (2026-10-08), anchored on their Learn to Play date.
 *   - Win-back: anchor = text sent (texted group) or the day they were held out
 *     (holdout group, no text). The texted-vs-holdout gap is the effect.
 * Rates only count players whose N-day window has fully passed in the
 * attendance data ("mature"); the counts behind every rate are returned.
 */
import { supabase } from "./supabaseClient";
import { addCalendarDays, toEtDate } from "./retentionDates";
import { isLearnToPlayName } from "./retentionFlows";
import { WINBACK_PLAYBOOK_KEY } from "./winbackRules";

export const LTP_TEXTING_STARTED = "2026-10-08";
export const MIN_GROUP_FOR_VERDICT = 30;

export interface ScorecardVisit { date: string; program: string | null }
export interface ScorecardCandidate {
  id: string; player_id: string; playbook_key: string; step: number | null; status: string;
  created_at: string; context: Record<string, any> | null; message_id: string | null;
}
export interface ScorecardMessage {
  id: string; sent_at: string | null; delivery_status: string | null; error_code: string | null;
  simulated: boolean | null; retention_delivery_kind: string | null; approved_by: string | null;
}
export interface ScorecardInputs {
  today: string;
  periodDays: number;
  visits: Map<string, ScorecardVisit[]>;
  candidates: ScorecardCandidate[];
  messages: Map<string, ScorecardMessage>;
  inboundByPlayer: Map<string, string[]>;
  optouts: { player_id: string; opted_out_at: string; playbook_key: string | null }[];
  testPlayerIds: Set<string>;
  health: { kill_switch: boolean | null; sms_live: boolean; last_nightly: { status: string | null; finished_at: string | null } | null };
}

export interface Rate { mature: number; returned: number; rate: number | null }
export interface ReturnRates { d14: Rate; d30: Rate }

const rate = (mature: number, returned: number): Rate =>
  ({ mature, returned, rate: mature ? Math.round((1000 * returned) / mature) / 10 : null });

function returnRates(
  anchors: { player_id: string; date: string }[],
  visits: Map<string, ScorecardVisit[]>,
  dataThrough: string,
  include: (visit: ScorecardVisit) => boolean = () => true,
): ReturnRates {
  const calc = (days: number) => {
    const mature = anchors.filter((a) => addCalendarDays(a.date, days) <= dataThrough);
    const returned = mature.filter((a) => (visits.get(a.player_id) ?? []).some((v) =>
      v.date > a.date && v.date <= addCalendarDays(a.date, days) && include(v)));
    return rate(mature.length, returned.length);
  };
  return { d14: calc(14), d30: calc(30) };
}

/** Two-proportion z-test, two-sided p-value. Null when either group is empty. */
export function twoProportionP(x1: number, n1: number, x2: number, n2: number): number | null {
  if (!n1 || !n2) return null;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  const z = Math.abs(x1 / n1 - x2 / n2) / se;
  // Abramowitz-Stegun normal CDF approximation.
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.round(2 * tail * 1000) / 1000;
}

function verdict(treated: Rate, control: Rate): string {
  if (treated.mature < MIN_GROUP_FOR_VERDICT || control.mature < MIN_GROUP_FOR_VERDICT) {
    return `Too early to tell: need ${MIN_GROUP_FOR_VERDICT}+ players with a full window in each group (have ${treated.mature} and ${control.mature}).`;
  }
  const p = twoProportionP(treated.returned, treated.mature, control.returned, control.mature);
  const diff = (treated.rate ?? 0) - (control.rate ?? 0);
  const direction = diff > 0 ? "higher" : diff < 0 ? "lower" : "the same";
  if (p !== null && p < 0.05) return `Likely real: ${Math.abs(diff).toFixed(1)} points ${direction} (p=${p}).`;
  return `Could be chance so far: ${Math.abs(diff).toFixed(1)} points ${direction} (p=${p ?? "n/a"}).`;
}

function sendStats(cands: ScorecardCandidate[], messages: Map<string, ScorecardMessage>, sinceIso: string) {
  const inPeriod = cands.filter((c) => c.created_at >= sinceIso);
  const realSent = (c: ScorecardCandidate) => {
    const m = c.message_id ? messages.get(c.message_id) : undefined;
    return m && m.sent_at && !m.simulated && !["test", "simulated"].includes(m.retention_delivery_kind ?? "") ? m : null;
  };
  const sentPeriod = cands.map((c) => ({ c, m: realSent(c) })).filter((x) => x.m && x.m.sent_at! >= sinceIso);
  return {
    drafted: inPeriod.filter((c) => c.status !== "skipped" || c.message_id).length,
    sent: sentPeriod.length,
    delivered: sentPeriod.filter((x) => x.m!.delivery_status === "delivered").length,
    failed: sentPeriod.filter((x) => ["failed", "undelivered"].includes(x.m!.delivery_status ?? "")).length,
    failed_error_codes: [...new Set(sentPeriod.map((x) => x.m!.error_code).filter(Boolean))] as string[],
    auto_approved: sentPeriod.filter((x) => x.m!.approved_by === "auto-approver").length,
    waiting_for_approval: cands.filter((c) => c.status === "drafted").length,
  };
}

export function computeScorecard(input: ScorecardInputs) {
  const { today, visits, candidates, messages } = input;
  const since = new Date(Date.parse(`${addCalendarDays(today, -input.periodDays)}T00:00:00Z`)).toISOString();
  let dataThrough = "";
  for (const list of visits.values()) for (const v of list) if (v.date <= today && v.date > dataThrough) dataThrough = v.date;
  const real = candidates.filter((c) => !input.testPlayerIds.has(c.player_id));
  const sentDate = (c: ScorecardCandidate) => {
    const m = c.message_id ? messages.get(c.message_id) : undefined;
    if (!m?.sent_at || m.simulated || ["test", "simulated"].includes(m.retention_delivery_kind ?? "")) return null;
    return toEtDate(m.sent_at);
  };
  const repliesAfter = (playerId: string, sentIso: string) =>
    (input.inboundByPlayer.get(playerId) ?? []).some((t) => t > sentIso && Date.parse(t) - Date.parse(sentIso) <= 7 * 86_400_000);
  const optoutsFor = (key: string, sinceIso: string | null) => input.optouts
    .filter((o) => o.playbook_key === key && !input.testPlayerIds.has(o.player_id) && (!sinceIso || o.opted_out_at >= sinceIso)).length;

  // ---- Learn to Play ----
  const ltp = real.filter((c) => c.playbook_key === "ltp_followup");
  const ltpStep1Sent = ltp.filter((c) => (c.step ?? 1) === 1).map((c) => ({ c, date: sentDate(c) }))
    .filter((x): x is { c: ScorecardCandidate; date: string } => !!x.date);
  const nonLtp = (v: ScorecardVisit) => !isLearnToPlayName(v.program ?? "");
  const ltpTexted = returnRates(ltpStep1Sent.map((x) => ({ player_id: x.c.player_id, date: x.date })), visits, dataThrough, nonLtp);
  const baselineAnchors: { player_id: string; date: string }[] = [];
  const baselineStart = addCalendarDays(LTP_TEXTING_STARTED, -183);
  for (const [playerId, list] of visits) {
    if (input.testPlayerIds.has(playerId)) continue;
    const first = [...list].sort((a, b) => a.date.localeCompare(b.date))[0];
    if (first && first.date >= baselineStart && first.date < LTP_TEXTING_STARTED
      && list.some((v) => v.date === first.date && isLearnToPlayName(v.program ?? ""))) {
      baselineAnchors.push({ player_id: playerId, date: first.date });
    }
  }
  const ltpBaseline = returnRates(baselineAnchors, visits, dataThrough, nonLtp);
  const ltpSentAll = ltp.map((c) => ({ c, m: c.message_id ? messages.get(c.message_id) : undefined }))
    .filter((x) => x.m?.sent_at && sentDate(x.c));

  // ---- Win-back ----
  const wb = real.filter((c) => c.playbook_key === WINBACK_PLAYBOOK_KEY);
  const wbTextedAnchors = wb.map((c) => ({ player_id: c.player_id, date: sentDate(c) }))
    .filter((a): a is { player_id: string; date: string } => !!a.date);
  const wbHoldoutAnchors = wb.filter((c) => c.status === "skipped" && c.context?.reason === "holdout")
    .map((c) => ({ player_id: c.player_id, date: toEtDate(c.created_at) }));
  const wbTexted = returnRates(wbTextedAnchors, visits, dataThrough);
  const wbHoldout = returnRates(wbHoldoutAnchors, visits, dataThrough);
  const wbSent = wb.map((c) => ({ c, m: c.message_id ? messages.get(c.message_id) : undefined })).filter((x) => x.m?.sent_at && sentDate(x.c));

  return {
    generated_at: new Date().toISOString(),
    period_days: input.periodDays,
    data_through: dataThrough || null,
    health: {
      ...input.health,
      attendance_data_days_old: dataThrough ? Math.round((Date.parse(today) - Date.parse(dataThrough)) / 86_400_000) : null,
    },
    learn_to_play: {
      period: sendStats(ltp, messages, since),
      all_time_texted_players: ltpStep1Sent.length,
      replies_within_7_days: ltpSentAll.filter((x) => repliesAfter(x.c.player_id, x.m!.sent_at!)).length,
      opt_outs: { period: optoutsFor("ltp_followup", since), all_time: optoutsFor("ltp_followup", null) },
      played_again: { texted: ltpTexted, before_texting_baseline: ltpBaseline,
        verdict_30d: verdict(ltpTexted.d30, ltpBaseline.d30) },
    },
    winback: {
      period: sendStats(wb, messages, since),
      held_out_no_text: { period: wb.filter((c) => c.context?.reason === "holdout" && c.created_at >= since).length, all_time: wbHoldoutAnchors.length },
      skipped_by_operator: wb.filter((c) => c.status === "skipped" && c.context?.reason !== "holdout").length,
      replies_within_7_days: wbSent.filter((x) => repliesAfter(x.c.player_id, x.m!.sent_at!)).length,
      opt_outs: { period: optoutsFor(WINBACK_PLAYBOOK_KEY, since), all_time: optoutsFor(WINBACK_PLAYBOOK_KEY, null) },
      came_back: { texted: wbTexted, holdout_no_text: wbHoldout,
        verdict_14d: verdict(wbTexted.d14, wbHoldout.d14), verdict_30d: verdict(wbTexted.d30, wbHoldout.d30) },
    },
  };
}

// ---- Loader -----------------------------------------------------------------

async function readAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) return rows;
  }
}

async function byIds<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) out.push(...await load(ids.slice(i, i + 200)));
  return out;
}

export async function loadScorecard(clubId: string, periodDays = 7) {
  const today = toEtDate(new Date());
  const [attendance, candidates, testPlayers, optouts, club, nightly] = await Promise.all([
    readAll<{ player_id: string; attended_at: string; program_name: string | null }>((f, t) =>
      supabase.from("attendances").select("player_id,attended_at,program_name").eq("club_id", clubId)
        .not("player_id", "is", null).order("id").range(f, t)),
    readAll<ScorecardCandidate>((f, t) => supabase.from("retention_candidates")
      .select("id,player_id,playbook_key,step,status,created_at,context,message_id")
      .eq("club_id", clubId).in("playbook_key", ["ltp_followup", WINBACK_PLAYBOOK_KEY]).order("id").range(f, t)),
    readAll<{ id: string }>((f, t) => supabase.from("players").select("id").eq("club_id", clubId).eq("is_test", true).order("id").range(f, t)),
    readAll<{ player_id: string; opted_out_at: string; playbook_key: string | null }>((f, t) =>
      supabase.from("sms_optouts").select("player_id,opted_out_at,playbook_key").eq("club_id", clubId).order("id").range(f, t)),
    supabase.from("clubs").select("sms_kill_switch").eq("id", clubId).maybeSingle(),
    supabase.from("jobs").select("status,finished_at").eq("id", "nightly_sync").maybeSingle(),
  ]);
  if (club.error) throw new Error(club.error.message);
  const visits = new Map<string, ScorecardVisit[]>();
  for (const row of attendance) {
    const list = visits.get(row.player_id) ?? [];
    list.push({ date: toEtDate(row.attended_at), program: row.program_name });
    visits.set(row.player_id, list);
  }
  const messageIds = candidates.map((c) => c.message_id).filter((id): id is string => !!id);
  const messages = new Map((await byIds(messageIds, async (chunk) => {
    const { data, error } = await supabase.from("messages")
      .select("id,sent_at,delivery_status,error_code,simulated,retention_delivery_kind,approved_by").in("id", chunk);
    if (error) throw new Error(error.message);
    return (data ?? []) as ScorecardMessage[];
  })).map((m) => [m.id, m]));
  const playerIds = [...new Set(candidates.map((c) => c.player_id))];
  const inbound = await byIds(playerIds, async (chunk) => {
    const { data, error } = await supabase.from("messages").select("player_id,sent_at")
      .eq("direction", "inbound").not("sent_at", "is", null).in("player_id", chunk);
    if (error) throw new Error(error.message);
    return (data ?? []) as { player_id: string; sent_at: string }[];
  });
  const inboundByPlayer = new Map<string, string[]>();
  for (const row of inbound) inboundByPlayer.set(row.player_id, [...(inboundByPlayer.get(row.player_id) ?? []), row.sent_at]);
  return computeScorecard({
    today, periodDays, visits, candidates, messages, inboundByPlayer, optouts,
    testPlayerIds: new Set(testPlayers.map((p) => p.id)),
    health: {
      kill_switch: club.data ? club.data.sms_kill_switch === true : null,
      sms_live: process.env.SMS_LIVE === "true",
      last_nightly: nightly.error || !nightly.data ? null : { status: nightly.data.status, finished_at: nightly.data.finished_at },
    },
  });
}
