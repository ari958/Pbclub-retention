import { supabase } from "./supabaseClient";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

type ChurnRisk = "high" | "medium" | "low";

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / MS_PER_DAY;
}

function scoreToRisk(score: number): ChurnRisk {
  if (score >= 65) return "high";
  if (score >= 35) return "medium";
  return "low";
}

export async function computeChurnScore(playerId: string): Promise<void> {
  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("last_visit_date, membership_status")
    .eq("id", playerId)
    .single();

  if (playerErr || !player) return;

  // Never Visited players — skip entirely, write nothing
  if (!player.last_visit_date) return;

  // ── Signal 1: Recency (max 30 pts) ──────────────────────────────────────────
  const days = daysSince(player.last_visit_date);
  let s1 = 0;
  if (days >= 61)      s1 = 30;
  else if (days >= 31) s1 = 20;
  else if (days >= 15) s1 = 10;

  // ── Signal 2: Frequency drop (max 25 pts) ────────────────────────────────────
  let allAttendances: { attended_at: string }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("attended_at")
      .eq("player_id", playerId)
      .order("attended_at", { ascending: true })
      .range(offset, offset + 999);
    if (error || !data || data.length === 0) break;
    allAttendances.push(...(data as { attended_at: string }[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  let s2 = 12; // neutral prior
  if (allAttendances.length > 0) {
    const firstAt = new Date(allAttendances[0].attended_at).getTime();
    const cutoff60 = firstAt + 60 * MS_PER_DAY;
    const cutoff30 = Date.now() - 30 * MS_PER_DAY;

    const baselineSessions = allAttendances.filter(
      (a) => new Date(a.attended_at).getTime() <= cutoff60
    ).length;
    const recentSessions = allAttendances.filter(
      (a) => new Date(a.attended_at).getTime() >= cutoff30
    ).length;

    const baselineWeekly = baselineSessions / 8.57;
    const recentWeekly = recentSessions / 4.33;

    if (baselineWeekly === 0) {
      s2 = 12;
    } else {
      const drop = (baselineWeekly - recentWeekly) / baselineWeekly;
      s2 = Math.round(25 * Math.max(0, Math.min(1, drop)));
    }
  }

  // ── Signal 3: Social isolation (max 20 pts) ───────────────────────────────────
  const { count: buddyCount } = await supabase
    .from("buddy_pairs")
    .select("player_a", { count: "exact", head: true })
    .or(`player_a.eq.${playerId},player_b.eq.${playerId}`);

  const bc = buddyCount ?? 0;
  let s3 = 20;
  if (bc >= 3)      s3 = 0;
  else if (bc >= 1) s3 = 10;

  // ── Signal 4: Outreach non-response (max 15 pts) ──────────────────────────────
  let s4 = 0;
  const { data: convData } = await supabase
    .from("conversations")
    .select("id")
    .eq("player_id", playerId);

  const convIds = (convData ?? []).map((c: any) => c.id as string);
  if (convIds.length > 0) {
    const [outboundRes, inboundRes] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .in("conversation_id", convIds)
        .eq("direction", "outbound"),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .in("conversation_id", convIds)
        .eq("direction", "inbound"),
    ]);

    const outCount = outboundRes.count ?? 0;
    const inCount = inboundRes.count ?? 0;

    if (outCount > 0) {
      const rr = inCount / outCount;
      if (rr === 0)       s4 = 15;
      else if (rr < 0.5)  s4 = 8;
      else                s4 = 0;
    }
  }

  // ── Signal 5: Membership (max 10 pts) ────────────────────────────────────────
  const s5 = player.membership_status === "member" ? 0 : 10;

  const totalScore = s1 + s2 + s3 + s4 + s5;
  const risk = scoreToRisk(totalScore);

  await supabase
    .from("players")
    .update({ churn_score: totalScore, churn_risk: risk })
    .eq("id", playerId);
}

export interface ChurnDebug {
  churn_score: number;
  churn_risk: ChurnRisk;
  breakdown: {
    s1_recency: number;
    s2_frequency_drop: number;
    s3_social_isolation: number;
    s4_outreach_nonresponse: number;
    s5_membership: number;
    last_visit_days_ago: number | null;
    baseline_sessions: number;
    recent_sessions: number;
    baseline_weekly: number;
    recent_weekly: number;
    buddy_count: number;
    outbound_messages: number;
    inbound_messages: number;
    membership_status: string | null;
  };
}

export async function computeChurnScoreAndReturn(
  playerId: string
): Promise<ChurnDebug | null> {
  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("last_visit_date, membership_status")
    .eq("id", playerId)
    .single();

  if (playerErr || !player || !player.last_visit_date) return null;

  const days = daysSince(player.last_visit_date);
  let s1 = 0;
  if (days >= 61)      s1 = 30;
  else if (days >= 31) s1 = 20;
  else if (days >= 15) s1 = 10;

  let allAttendances: { attended_at: string }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("attended_at")
      .eq("player_id", playerId)
      .order("attended_at", { ascending: true })
      .range(offset, offset + 999);
    if (error || !data || data.length === 0) break;
    allAttendances.push(...(data as { attended_at: string }[]));
    if (data.length < 1000) break;
    offset += 1000;
  }

  let s2 = 12;
  let debugBaselineSessions = 0;
  let debugRecentSessions = 0;
  let debugBaselineWeekly = 0;
  let debugRecentWeekly = 0;

  if (allAttendances.length > 0) {
    const firstAt = new Date(allAttendances[0].attended_at).getTime();
    const cutoff60 = firstAt + 60 * MS_PER_DAY;
    const cutoff30 = Date.now() - 30 * MS_PER_DAY;
    debugBaselineSessions = allAttendances.filter(
      (a) => new Date(a.attended_at).getTime() <= cutoff60
    ).length;
    debugRecentSessions = allAttendances.filter(
      (a) => new Date(a.attended_at).getTime() >= cutoff30
    ).length;
    debugBaselineWeekly = debugBaselineSessions / 8.57;
    debugRecentWeekly = debugRecentSessions / 4.33;
    if (debugBaselineWeekly === 0) {
      s2 = 12;
    } else {
      const drop = (debugBaselineWeekly - debugRecentWeekly) / debugBaselineWeekly;
      s2 = Math.round(25 * Math.max(0, Math.min(1, drop)));
    }
  }

  const { count: buddyCount } = await supabase
    .from("buddy_pairs")
    .select("player_a", { count: "exact", head: true })
    .or(`player_a.eq.${playerId},player_b.eq.${playerId}`);
  const bc = buddyCount ?? 0;
  let s3 = 20;
  if (bc >= 3)      s3 = 0;
  else if (bc >= 1) s3 = 10;

  let s4 = 0;
  let debugOutCount = 0;
  let debugInCount = 0;
  const { data: convData } = await supabase
    .from("conversations")
    .select("id")
    .eq("player_id", playerId);
  const convIds = (convData ?? []).map((c: any) => c.id as string);
  if (convIds.length > 0) {
    const [outboundRes, inboundRes] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .in("conversation_id", convIds)
        .eq("direction", "outbound"),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .in("conversation_id", convIds)
        .eq("direction", "inbound"),
    ]);
    debugOutCount = outboundRes.count ?? 0;
    debugInCount = inboundRes.count ?? 0;
    if (debugOutCount > 0) {
      const rr = debugInCount / debugOutCount;
      if (rr === 0)       s4 = 15;
      else if (rr < 0.5)  s4 = 8;
      else                s4 = 0;
    }
  }

  const s5 = player.membership_status === "member" ? 0 : 10;
  const totalScore = s1 + s2 + s3 + s4 + s5;
  const risk = scoreToRisk(totalScore);

  await supabase
    .from("players")
    .update({ churn_score: totalScore, churn_risk: risk })
    .eq("id", playerId);

  return {
    churn_score: totalScore,
    churn_risk: risk,
    breakdown: {
      s1_recency: s1,
      s2_frequency_drop: s2,
      s3_social_isolation: s3,
      s4_outreach_nonresponse: s4,
      s5_membership: s5,
      last_visit_days_ago: Math.round(days),
      baseline_sessions: debugBaselineSessions,
      recent_sessions: debugRecentSessions,
      baseline_weekly: Math.round(debugBaselineWeekly * 100) / 100,
      recent_weekly: Math.round(debugRecentWeekly * 100) / 100,
      buddy_count: bc,
      outbound_messages: debugOutCount,
      inbound_messages: debugInCount,
      membership_status: player.membership_status,
    },
  };
}
