import { supabase } from "./supabaseClient";

/** Direct player ownership takes priority; conversation ownership is the
 * fallback for legacy messages without player_id. The sets are disjoint. */
export async function getWinbackStats(clubId: string, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86400000).toISOString();
  const count = async (legacy: boolean, converted: boolean) => {
    const relation = legacy ? "conversations" : "players";
    let query = supabase.from("messages")
      .select(`id,${relation}!inner(club_id)`, { count: "exact", head: true })
      .eq(`${relation}.club_id`, clubId)
      .eq("direction", "outbound").eq("status", "sent").gte("created_at", since);
    if (legacy) query = query.is("player_id", null);
    if (converted) query = query.not("converted_at", "is", null);
    const result = await query;
    if (result.error) throw result.error;
    if (result.count == null) throw new Error("Winback count unavailable");
    return result.count;
  };
  const [directConverted, legacyConverted, directSent, legacySent] = await Promise.all([
    count(false, true), count(true, true), count(false, false), count(true, false),
  ]);
  const conversions = directConverted + legacyConverted;
  const messagesSent = directSent + legacySent;
  return {
    period_days: 30,
    messages_sent: messagesSent,
    conversions,
    conversion_rate_pct: messagesSent > 0 ? Math.round(conversions / messagesSent * 100) : null,
  };
}

export async function getPlayerSmsStatus(playerId: string, clubId: string) {
  const player = await supabase.from("players").select("id,opted_out,sms_opt_in")
    .eq("id", playerId).eq("club_id", clubId).maybeSingle();
  if (player.error) throw player.error;
  if (!player.data) return null;
  // Read privately on the server. Include test/backfill events for this player's
  // own profile; exclude neither, and never infer current flags from old STOPs.
  const event = await supabase.from("sms_optout_events")
    .select("occurred_at,source,twilio_optout_type")
    .eq("player_id", playerId).eq("club_id", clubId)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(1).maybeSingle();
  if (event.error) throw event.error;
  const optedOut = player.data.opted_out === true || player.data.sms_opt_in === false;
  const knownActive = player.data.opted_out === false || player.data.sms_opt_in === true;
  return {
    status: optedOut ? "opted_out" as const : knownActive ? "active" as const : "unknown" as const,
    opted_out: player.data.opted_out ?? null,
    sms_opt_in: player.data.sms_opt_in ?? null,
    latest_optout_event: event.data ?? null,
  };
}
