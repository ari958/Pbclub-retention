import { supabase } from "./supabaseClient";
import type { BatchResult } from "./milestoneCheck";
import { startJob, finishJob, appendJobLog, isCancelled } from "./jobStore";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

type ChurnRisk = "high" | "medium" | "low";

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / MS_PER_DAY;
}

function scoreToRisk(score: number): ChurnRisk {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
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

    // Require at least 3 outbound messages before penalising non-response
    if (outCount >= 3) {
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
    // Require at least 3 outbound messages before penalising non-response
    if (debugOutCount >= 3) {
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

// ─── Churn score batch ────────────────────────────────────────────────────────

export const JOB_CHURN = "compute_churn_scores";

/**
 * Recomputes churn scores for every player with a non-null last_visit_date.
 * Owns its own job lifecycle (compute_churn_scores in the jobs table) so
 * the dashboard's polling endpoint /sync/churn-scores/status keeps working.
 *
 * Called by:
 *   - POST /sync/churn-scores (manual / dashboard, 202 + detached IIFE)
 *   - Scheduler step 5 (nightly, awaited directly)
 *
 * Cancellation: polls isCancelled(JOB_CHURN) once per player.
 *
 * Errors: never throws. Returns ok=false with errors[] populated on failure
 * (matches the existing route behavior of finishJob with status='error').
 */
export async function runChurnScoreBatch(): Promise<BatchResult> {
  await startJob(JOB_CHURN);
  await appendJobLog(JOB_CHURN, "Churn score batch started");

  let scored = 0;
  const errorMessages: string[] = [];

  try {
    // ── 1. Bulk-fetch all eligible players ─────────────────────────────────────
    const players: { id: string; last_visit_date: string; membership_status: string | null }[] = [];
    {
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("players")
          .select("id, last_visit_date, membership_status")
          .not("last_visit_date", "is", null)
          .range(offset, offset + 999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        players.push(...(data as typeof players));
        if (data.length < 1000) break;
        offset += 1000;
      }
    }

    const playerIds = players.map((p) => p.id);
    await appendJobLog(JOB_CHURN, `Found ${playerIds.length} eligible players — bulk-fetching inputs`);

    if (await isCancelled(JOB_CHURN)) {
      await appendJobLog(JOB_CHURN, "Cancelled by operator");
      throw Object.assign(new Error("Churn scoring cancelled"), { name: "CancelledError" });
    }

    // ── 2. Bulk-fetch attendances (500-player chunks, paginated) ───────────────
    const attendanceMap = new Map<string, { attended_at: string }[]>();
    for (let i = 0; i < playerIds.length; i += 100) {
      const chunk = playerIds.slice(i, i + 100);
      let attOffset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("attendances")
          .select("player_id, attended_at")
          .in("player_id", chunk)
          .range(attOffset, attOffset + 9999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const row of data as { player_id: string; attended_at: string }[]) {
          const list = attendanceMap.get(row.player_id) ?? [];
          list.push({ attended_at: row.attended_at });
          attendanceMap.set(row.player_id, list);
        }
        if (data.length < 10000) break;
        attOffset += 10000;
      }
    }
    for (const list of attendanceMap.values()) {
      list.sort((a, b) => a.attended_at.localeCompare(b.attended_at));
    }

    // ── 3. Bulk-fetch all buddy_pairs ──────────────────────────────────────────
    const buddyCountMap = new Map<string, number>();
    {
      let bpOffset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("buddy_pairs")
          .select("player_a, player_b")
          .range(bpOffset, bpOffset + 9999);
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        for (const pair of data as { player_a: string; player_b: string }[]) {
          buddyCountMap.set(pair.player_a, (buddyCountMap.get(pair.player_a) ?? 0) + 1);
          buddyCountMap.set(pair.player_b, (buddyCountMap.get(pair.player_b) ?? 0) + 1);
        }
        if (data.length < 10000) break;
        bpOffset += 10000;
      }
    }

    // ── 4. Bulk-fetch conversations → messages ─────────────────────────────────
    const messageStatsMap = new Map<string, { outCount: number; inCount: number }>();
    {
      const convPlayerMap = new Map<string, string>();
      for (let i = 0; i < playerIds.length; i += 100) {
        const chunk = playerIds.slice(i, i + 100);
        const { data, error } = await supabase
          .from("conversations")
          .select("id, player_id")
          .in("player_id", chunk);
        if (error) throw new Error(error.message);
        for (const c of (data ?? []) as { id: string; player_id: string }[]) {
          convPlayerMap.set(c.id, c.player_id);
        }
      }
      const convIds = [...convPlayerMap.keys()];
      for (let i = 0; i < convIds.length; i += 100) {
        const chunk = convIds.slice(i, i + 100);
        const { data, error } = await supabase
          .from("messages")
          .select("conversation_id, direction")
          .in("conversation_id", chunk);
        if (error) throw new Error(error.message);
        for (const msg of (data ?? []) as { conversation_id: string; direction: string }[]) {
          const pid = convPlayerMap.get(msg.conversation_id);
          if (!pid) continue;
          const stats = messageStatsMap.get(pid) ?? { outCount: 0, inCount: 0 };
          if (msg.direction === "outbound") stats.outCount++;
          else if (msg.direction === "inbound") stats.inCount++;
          messageStatsMap.set(pid, stats);
        }
      }
    }

    await appendJobLog(JOB_CHURN, `Bulk fetch complete — computing scores in memory`);

    if (await isCancelled(JOB_CHURN)) {
      await appendJobLog(JOB_CHURN, "Cancelled by operator");
      throw Object.assign(new Error("Churn scoring cancelled"), { name: "CancelledError" });
    }

    // ── 5. Compute all scores in memory ────────────────────────────────────────
    const updates: { id: string; churn_score: number; churn_risk: ChurnRisk }[] = [];

    for (const player of players) {
      const allAttendances = attendanceMap.get(player.id) ?? [];

      const days = daysSince(player.last_visit_date);
      let s1 = 0;
      if (days >= 61)      s1 = 30;
      else if (days >= 31) s1 = 20;
      else if (days >= 15) s1 = 10;

      let s2 = 12;
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

      const bc = buddyCountMap.get(player.id) ?? 0;
      let s3 = 20;
      if (bc >= 3)      s3 = 0;
      else if (bc >= 1) s3 = 10;

      let s4 = 0;
      const msgStats = messageStatsMap.get(player.id);
      if (msgStats && msgStats.outCount >= 3) {
        const rr = msgStats.inCount / msgStats.outCount;
        if (rr === 0)       s4 = 15;
        else if (rr < 0.5)  s4 = 8;
        else                s4 = 0;
      }

      const s5 = player.membership_status === "member" ? 0 : 10;
      const totalScore = s1 + s2 + s3 + s4 + s5;
      updates.push({ id: player.id, churn_score: totalScore, churn_risk: scoreToRisk(totalScore) });
    }

    // ── 6. Write scores in parallel batches of 25 ─────────────────────────────
    const PARALLEL = 25;
    for (let i = 0; i < updates.length; i += PARALLEL) {
      if (await isCancelled(JOB_CHURN)) {
        await appendJobLog(JOB_CHURN, "Cancelled by operator");
        throw Object.assign(new Error("Churn scoring cancelled"), { name: "CancelledError" });
      }
      const batch = updates.slice(i, i + PARALLEL);
      const results = await Promise.all(
        batch.map((u) =>
          supabase
            .from("players")
            .update({ churn_score: u.churn_score, churn_risk: u.churn_risk })
            .eq("id", u.id)
        )
      );
      const writeErr = results.find((r) => r.error);
      if (writeErr?.error) throw new Error(writeErr.error.message);
      scored += batch.length;
      if (scored % 500 === 0 || scored === updates.length) {
        await appendJobLog(JOB_CHURN, `Updated ${scored}/${updates.length} players…`);
      }
    }

    await finishJob(JOB_CHURN, "done", { players_scored: scored });
    await appendJobLog(JOB_CHURN, `Done — churn scores computed for ${scored} players`);

    return { ok: true, stats: { players_scored: scored } };
  } catch (err: any) {
    const cancelled = err.name === "CancelledError";
    await finishJob(JOB_CHURN, cancelled ? "cancelled" : "error", undefined, err.message);
    await appendJobLog(JOB_CHURN, `Churn score batch ${cancelled ? "cancelled" : "failed"}: ${err.message}`);
    errorMessages.push(err.message);
    return { ok: false, stats: { players_scored: scored }, errors: errorMessages };
  }
}
