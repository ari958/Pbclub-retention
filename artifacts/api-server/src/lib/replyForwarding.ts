/**
 * Forward player replies to the operator's phone (Ari, 2026-11-25).
 *
 * Runs inside the elected watchdog (once a minute, background worker only) and
 * texts ALERT_OPERATOR_TO through the existing operator-alert path, which claims
 * each alert once (operator_observe_alert) so a reply is never forwarded twice.
 * Covers matched player replies (kind 'reply'); unknown senders already alert
 * via alertUnmatchedInbound, and STOPs via alertPendingOptOutEvents.
 * Replies older than REPLY_FORWARD_MAX_AGE_HOURS are not forwarded, so the
 * first deploy does not flood the phone with history.
 * Off when REPLY_FORWARDING=false.
 */
import { supabase } from "./supabaseClient";
import { WINBACK_PLAYBOOK_KEY } from "./winbackRules";
import { getDefaultClubSlug } from "./clubResolver";

export const REPLY_FORWARD_MAX_AGE_HOURS = 6;
const MAX_REPLY_CHARS = 300;

export function replyFlowLabel(playbookKey: string | null | undefined): string | null {
  if (playbookKey === "ltp_followup") return "Learn to Play";
  if (playbookKey === WINBACK_PLAYBOOK_KEY) return "win-back";
  return null;
}

export function composeReplyAlert(args: {
  playerName: string | null;
  flow: string | null;
  body: string;
  dashboardUrl: string | null;
}): string {
  const parts = (args.playerName ?? "").trim().split(/\s+/).filter(Boolean);
  const who = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] ?? "a player";
  const text = args.body.replace(/\s+/g, " ").trim();
  const quoted = [...text].length > MAX_REPLY_CHARS ? `${[...text].slice(0, MAX_REPLY_CHARS).join("")}...` : text;
  return `Reply from ${who}${args.flow ? ` (${args.flow})` : ""}: "${quoted}"`
    + (args.dashboardUrl ? ` Answer it in the dashboard: ${args.dashboardUrl}` : " Answer it in the dashboard Messages page.");
}

export interface ReplyForwardDeps {
  enabled: () => boolean;
  now: () => Date;
  loadPending: (since: string) => Promise<{ id: string; player_id: string; body: string; received_at: string }[]>;
  loadPlayerName: (playerId: string) => Promise<string | null>;
  /** Most recent retention flow that texted this player, if any. */
  loadLastFlow: (playerId: string) => Promise<string | null>;
  dashboardUrl: () => string | null;
  /** True when the alert was claimed and submitted (or already claimed earlier). */
  alert: (key: string, text: string) => Promise<boolean>;
  markAttempted: (id: string) => Promise<void>;
}

export async function forwardPlayerReplies(deps: ReplyForwardDeps = defaultReplyForwardDeps): Promise<number> {
  if (!deps.enabled()) return 0;
  const since = new Date(deps.now().getTime() - REPLY_FORWARD_MAX_AGE_HOURS * 3_600_000).toISOString();
  let forwarded = 0;
  for (const receipt of await deps.loadPending(since)) {
    const [name, flowKey] = await Promise.all([deps.loadPlayerName(receipt.player_id), deps.loadLastFlow(receipt.player_id)]);
    const text = composeReplyAlert({ playerName: name, flow: replyFlowLabel(flowKey), body: receipt.body, dashboardUrl: deps.dashboardUrl() });
    if (await deps.alert(`player_reply:${receipt.id}`, text)) {
      await deps.markAttempted(receipt.id);
      forwarded++;
    }
  }
  return forwarded;
}

export const defaultReplyForwardDeps: ReplyForwardDeps = {
  enabled: () => process.env.REPLY_FORWARDING?.trim().toLowerCase() !== "false",
  now: () => new Date(),
  async loadPending(since) {
    const { data, error } = await supabase.from("sms_inbound_receipts")
      .select("id,player_id,body,received_at")
      .not("player_id", "is", null).eq("kind", "reply")
      .is("operator_alert_attempted_at", null).gte("received_at", since)
      .order("received_at", { ascending: true }).limit(20);
    if (error) throw new Error(`Cannot read player replies: ${error.message}`);
    return (data ?? []) as { id: string; player_id: string; body: string; received_at: string }[];
  },
  async loadPlayerName(playerId) {
    const { data, error } = await supabase.from("players").select("name").eq("id", playerId).maybeSingle();
    if (error) throw new Error(`Cannot read player for reply alert: ${error.message}`);
    return (data?.name as string | null) ?? null;
  },
  async loadLastFlow(playerId) {
    const { data, error } = await supabase.from("retention_candidates").select("playbook_key")
      .eq("player_id", playerId).eq("status", "sent").order("updated_at", { ascending: false }).limit(1);
    if (error) throw new Error(`Cannot read flow for reply alert: ${error.message}`);
    return (data?.[0]?.playbook_key as string | undefined) ?? null;
  },
  dashboardUrl: () => {
    const base = process.env.PUBLIC_API_URL?.replace(/\/$/, "");
    const slug = getDefaultClubSlug();
    return base ? `${base}/dashboard/c/${encodeURIComponent(slug)}/messages` : null;
  },
  alert: async (key, text) => (await import("./operatorMonitoring")).observeOperatorCondition(key, true, text, "inbound-inbox"),
  async markAttempted(id) {
    const { error } = await supabase.from("sms_inbound_receipts")
      .update({ operator_alert_attempted_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error(`Cannot record reply alert: ${error.message}`);
  },
};
