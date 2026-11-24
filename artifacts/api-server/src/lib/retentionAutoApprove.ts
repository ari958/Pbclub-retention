import { supabase } from "./supabaseClient";
import { approveCandidate } from "./retentionCandidateApproval";
import { smsLiveEnabled } from "./backgroundPolicy";
import { toEtDate } from "./retentionDates";
import type { RetentionCandidate } from "./retentionTypes";

/**
 * Nightly auto-approver for retention drafts.
 *
 * Ari's decision (2026-11-24): Learn to Play texts (step 1 and step 2) send
 * without waiting for an operator click. The auto-approver approves each fresh
 * draft through the same `approveCandidate` path the dashboard uses, so every
 * existing check still runs (freshness, sequence state, text rules, coupon,
 * TCPA window, send date) and dispatch still requires an approved candidate.
 * Anything that fails a check stays a draft for manual review.
 *
 * Off unless RETENTION_AUTO_APPROVE=true AND live SMS is enabled. The club's
 * sms_kill_switch must be off. At most RETENTION_AUTO_APPROVE_DAILY_CAP
 * (default 25) auto-approvals per ET calendar day; the rest wait for review.
 *
 * Send time: 3:00pm ET (RETENTION_AUTO_SEND_TIME, "HH:MM" ET, default 15:00)
 * on the draft's intended send date (context.send_date_et). If that time has
 * already passed when the auto-approver runs, the draft is held for review.
 */
export const AUTO_APPROVER = "auto-approver";
export const DEFAULT_AUTO_APPROVE_DAILY_CAP = 25;

export function autoApproveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RETENTION_AUTO_APPROVE?.trim().toLowerCase() === "true";
}

export function autoApproveDailyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RETENTION_AUTO_APPROVE_DAILY_CAP?.trim();
  if (!raw) return DEFAULT_AUTO_APPROVE_DAILY_CAP;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_AUTO_APPROVE_DAILY_CAP;
}

export const DEFAULT_AUTO_SEND_TIME = "15:00";

export function autoSendTime(env: NodeJS.ProcessEnv = process.env): { hour: number; minute: number } {
  const raw = env.RETENTION_AUTO_SEND_TIME?.trim() || DEFAULT_AUTO_SEND_TIME;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  // Keep inside the TCPA window (8:30am-7:30pm covers weekdays and weekends).
  const ok = hour * 60 + minute >= 8 * 60 + 30 && hour * 60 + minute <= 19 * 60 + 30;
  return ok ? { hour, minute } : { hour: 15, minute: 0 };
}

/** The instant that is `hour:minute` Eastern time on the ET calendar date `date` (YYYY-MM-DD). */
export function etWallClock(date: string, hour: number, minute: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, hour + offsetHours, minute));
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(candidate);
    const h = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    const mi = Number(parts.find((p) => p.type === "minute")?.value);
    if (toEtDate(candidate) === date && h === hour && mi === minute) return candidate;
  }
  throw new Error(`Could not resolve ${date} ${hour}:${minute} ET`);
}

export interface AutoApproveDeps {
  enabled: () => boolean;
  dailyCap: () => number;
  killSwitchOff: (clubId: string) => Promise<boolean>;
  countApprovedToday: (now: Date) => Promise<number>;
  loadDrafts: (clubId: string, flowKey: string) => Promise<RetentionCandidate[]>;
  loadBody: (messageId: string) => Promise<string | null>;
  approve: (clubId: string, candidate: RetentionCandidate, approvedBy: string, expectedBody: string, schedule: Date) => Promise<unknown>;
  sendTime: () => { hour: number; minute: number };
  now: () => Date;
}

export interface AutoApproveResult {
  status: "disabled" | "kill_switch_on" | "ran";
  approved: string[];
  held: { candidate_id: string; reason: string }[];
  cap: number;
  approved_today_before: number;
}

export async function autoApproveRetentionDrafts(
  clubId: string,
  flowKey: string,
  deps: AutoApproveDeps = defaultDeps,
): Promise<AutoApproveResult> {
  const cap = deps.dailyCap();
  const base = { approved: [] as string[], held: [] as { candidate_id: string; reason: string }[], cap, approved_today_before: 0 };
  if (!deps.enabled()) return { status: "disabled", ...base };
  if (!(await deps.killSwitchOff(clubId))) return { status: "kill_switch_on", ...base };

  const approvedToday = await deps.countApprovedToday(deps.now());
  base.approved_today_before = approvedToday;
  let remaining = Math.max(0, cap - approvedToday);
  const drafts = await deps.loadDrafts(clubId, flowKey);

  for (const candidate of drafts) {
    if (remaining <= 0) {
      base.held.push({ candidate_id: candidate.id, reason: `Daily auto-approve cap of ${cap} reached` });
      continue;
    }
    try {
      if (!candidate.message_id) throw new Error("Draft has no linked message");
      const body = await deps.loadBody(candidate.message_id);
      if (!body?.trim()) throw new Error("Draft message body is empty");
      const sendDate = candidate.context?.send_date_et;
      if (!sendDate) throw new Error("Draft has no intended send date");
      const { hour, minute } = deps.sendTime();
      const schedule = etWallClock(sendDate, hour, minute);
      if (schedule.getTime() <= deps.now().getTime() + 60_000) {
        throw new Error(`The ${hour}:${String(minute).padStart(2, "0")} ET send time on ${sendDate} has passed`);
      }
      await deps.approve(clubId, candidate, AUTO_APPROVER, body, schedule);
      base.approved.push(candidate.id);
      remaining -= 1;
    } catch (error) {
      base.held.push({ candidate_id: candidate.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { status: "ran", ...base };
}

const defaultDeps: AutoApproveDeps = {
  enabled: () => autoApproveConfigured() && smsLiveEnabled(),
  dailyCap: () => autoApproveDailyCap(),
  async killSwitchOff(clubId) {
    const { data, error } = await supabase.from("clubs").select("sms_kill_switch").eq("id", clubId).maybeSingle();
    if (error) throw new Error(`Could not read SMS kill switch: ${error.message}`);
    return !!data && data.sms_kill_switch === false;
  },
  async countApprovedToday(now) {
    const today = toEtDate(now);
    // ET midnight is never more than 30 hours back; filter the window to today's ET date.
    const since = new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("messages")
      .select("approved_at")
      .eq("approved_by", AUTO_APPROVER)
      .gte("approved_at", since)
      .limit(1000);
    if (error) throw new Error(`Could not count today's auto-approvals: ${error.message}`);
    return (data ?? []).filter((row: { approved_at: string | null }) => row.approved_at && toEtDate(row.approved_at) === today).length;
  },
  async loadDrafts(clubId, flowKey) {
    const { data, error } = await supabase
      .from("retention_candidates")
      .select("*")
      .eq("club_id", clubId)
      .eq("playbook_key", flowKey)
      .eq("status", "drafted")
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(`Could not load retention drafts: ${error.message}`);
    return (data ?? []) as RetentionCandidate[];
  },
  async loadBody(messageId) {
    const { data, error } = await supabase.from("messages").select("body").eq("id", messageId).maybeSingle();
    if (error) throw new Error(`Could not load draft body: ${error.message}`);
    return (data?.body as string | null) ?? null;
  },
  approve: (clubId, candidate, approvedBy, expectedBody, schedule) =>
    approveCandidate(clubId, candidate, approvedBy, expectedBody, schedule),
  sendTime: () => autoSendTime(),
  now: () => new Date(),
};
