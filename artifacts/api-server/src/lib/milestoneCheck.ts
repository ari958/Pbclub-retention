import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "./supabaseClient";
import { startJob, finishJob, appendJobLog } from "./jobStore";
import { logger } from "./logger";
import { isRetentionOnlyMode } from "./retentionPolicy";
import { AGENT_MODEL } from "./anthropicConfig";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const JOB_ID = "milestone_check";

type MilestoneType = "session_50" | "session_25" | "session_10" | "best_month" | "streak_3w";

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr);
  // ISO week: Monday-based
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const dayOfYear = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000);
  const weekNum = Math.ceil((dayOfYear + jan4.getDay() - 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

// ─── Single-player milestone check ────────────────────────────────────────────

export async function checkPlayerMilestones(
  playerId: string,
  dryRun = false
): Promise<{ checked: boolean; triggered: MilestoneType | null; reason?: string; message_body?: string; all_previews?: any[] }> {
  if (isRetentionOnlyMode()) {
    return { checked: false, triggered: null, reason: "Legacy milestone generation is parked by RETENTION_ONLY_MODE" };
  }
  // 1. Fetch player
  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("id, name, phone, club_id, sms_opt_in, coach_assigned_level, membership_status")
    .eq("id", playerId)
    .maybeSingle();

  if (playerErr || !player) {
    return { checked: false, triggered: null, reason: playerErr?.message ?? "not found" };
  }
  if (!player.phone || player.sms_opt_in === false) {
    return { checked: false, triggered: null, reason: "no phone or opted out" };
  }

  // 2. Fetch all attendances ordered by date
  const { data: attendances } = await supabase
    .from("attendances")
    .select("attended_at, event_id")
    .eq("player_id", playerId)
    .order("attended_at", { ascending: true });

  const rows = attendances ?? [];
  const total = rows.length;

  const firstName = player.name.split(" ")[0];

  // Fetch existing milestones
  const { data: existingMilestones } = await supabase
    .from("player_milestones")
    .select("milestone_type, milestone_value, triggered_at")
    .eq("player_id", playerId);

  const milestoneMap = new Map<string, { milestone_value: number | null; triggered_at: string }>();
  for (const m of existingMilestones ?? []) {
    milestoneMap.set(m.milestone_type, { milestone_value: m.milestone_value, triggered_at: m.triggered_at });
  }

  // For dry_run: collect all that would trigger
  const allPreviews: any[] = [];

  // ── SESSION COUNT MILESTONES ──────────────────────────────────────────────────
  for (const threshold of [50, 25, 10] as const) {
    if (total >= threshold) {
      const key = `session_${threshold}` as MilestoneType;
      if (!milestoneMap.has(key)) {
        const userPromptMap: Record<number, string> = {
          50: `Write a celebration message for ${firstName} who just played their 50th session at PB Club. They are a ${player.membership_status ?? "non-member"}. Current level: ${player.coach_assigned_level ?? "unassigned"}. Make it feel like a genuine milestone — because it is. Short and warm.`,
          25: `Write a celebration message for ${firstName} who just played their 25th session at PB Club. They're becoming a real regular. Short, warm, encouraging.`,
          10: `Write a celebration message for ${firstName} who just hit their 10th session at PB Club. They're officially a regular now. Welcome them to the club community. Short and warm.`,
        };
        const body = await callAnthropic(userPromptMap[threshold]);
        if (dryRun) {
          allPreviews.push({ milestone_type: key, message_body: body });
          break;
        }
        await persistMilestone(playerId, player, key, null, body, conv => conv);
        return { checked: true, triggered: key, message_body: body };
      }
      break; // Only check next threshold if this one is already recorded
    }
  }

  // ── BEST MONTH ────────────────────────────────────────────────────────────────
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const currentMonthCount = rows.filter((r) => monthKey(r.attended_at) === currentMonthKey).length;

  if (currentMonthCount >= 3) {
    const priorCounts = Object.entries(
      rows
        .filter((r) => monthKey(r.attended_at) < currentMonthKey)
        .reduce<Record<string, number>>((acc, r) => {
          const mk = monthKey(r.attended_at);
          acc[mk] = (acc[mk] ?? 0) + 1;
          return acc;
        }, {})
    ).map(([, v]) => v);
    const bestPrior = priorCounts.length > 0 ? Math.max(...priorCounts) : 0;

    if (currentMonthCount > bestPrior) {
      const currentMonthInt = parseInt(currentMonthKey.replace("-", ""), 10);
      const existingBest = milestoneMap.get("best_month");
      const alreadyTriggeredThisMonth = existingBest?.milestone_value === currentMonthInt;

      if (!alreadyTriggeredThisMonth) {
        const body = await callAnthropic(
          `Write a celebration message for ${firstName} who just had their most active month ever at PB Club with ${currentMonthCount} sessions. Celebrate their momentum. Short and warm.`
        );
        if (dryRun) {
          allPreviews.push({ milestone_type: "best_month", message_body: body, value: currentMonthInt });
        } else {
          await persistMilestone(playerId, player, "best_month", currentMonthInt, body, (conv) => conv);
          return { checked: true, triggered: "best_month", message_body: body };
        }
      }
    }
  }

  // ── 3-WEEK STREAK ─────────────────────────────────────────────────────────────
  const distinctWeeks = [...new Set(rows.map((r) => isoWeekKey(r.attended_at)))].sort();
  if (distinctWeeks.length >= 3) {
    const lastThree = distinctWeeks.slice(-3);
    // Check they are three consecutive weeks
    const isConsecutive = lastThree.every((wk, i) => {
      if (i === 0) return true;
      const prev = new Date(lastThree[i - 1].replace("W", "") + "1"); // approximate
      return true; // We'll use a simpler approach below
    });

    // Simpler: parse week numbers from the last 3 and check they are consecutive
    const weekNums = lastThree.map((wk) => {
      const [yearPart, weekPart] = wk.split("-W");
      return parseInt(yearPart, 10) * 100 + parseInt(weekPart, 10);
    });
    const isActuallyConsecutive =
      weekNums[1] === weekNums[0] + 1 && weekNums[2] === weekNums[1] + 1;

    if (isActuallyConsecutive) {
      const existing = milestoneMap.get("streak_3w");
      const twentyOneDaysAgo = new Date(Date.now() - 21 * 86400000).toISOString().split("T")[0];
      const recentlyTriggered = existing && existing.triggered_at >= twentyOneDaysAgo;

      if (!recentlyTriggered) {
        const body = await callAnthropic(
          `Write a celebration message for ${firstName} who has attended PB Club sessions for 3 weeks in a row. Celebrate their consistency. Short and warm.`
        );
        if (dryRun) {
          allPreviews.push({ milestone_type: "streak_3w", message_body: body });
        } else {
          await persistMilestone(playerId, player, "streak_3w", null, body, (conv) => conv);
          return { checked: true, triggered: "streak_3w", message_body: body };
        }
      }
    }
  }

  if (dryRun && allPreviews.length > 0) {
    return { checked: true, triggered: null, all_previews: allPreviews };
  }
  return { checked: true, triggered: null };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function callAnthropic(userPrompt: string): Promise<string> {
  const completion = await anthropic.messages.create({
    model: AGENT_MODEL,
    max_tokens: 300,
    system: "You are a warm, encouraging retention agent for PB Club. Write a milestone celebration SMS. Keep it genuine and brief — under 160 characters ideally. Sound like a coach who noticed something impressive, not a marketing bot. Output only the message text.",
    messages: [{ role: "user", content: userPrompt }],
  });
  return (completion.content[0] as { type: string; text: string }).text.trim();
}

async function persistMilestone(
  playerId: string,
  player: any,
  milestoneType: MilestoneType,
  milestoneValue: number | null,
  messageBody: string,
  _cb: (convId: string) => string
): Promise<void> {
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .insert({
      player_id: playerId,
      club_id: player.club_id,
      triggered_by: `milestone_${milestoneType}`,
    })
    .select("id")
    .single();

  if (convErr || !conv) throw new Error(convErr?.message ?? "conv insert failed");

  const { error: msgErr } = await supabase
    .from("messages")
    .insert({
      conversation_id: conv.id,
      player_id: playerId,
      body: messageBody,
      direction: "outbound",
      sent_by: "agent",
      status: "pending",
      sent_at: null,
    });
  if (msgErr) throw new Error(msgErr.message);

  // Upsert milestone row (update milestone_value + triggered_at for repeatable types)
  await supabase
    .from("player_milestones")
    .upsert(
      {
        player_id: playerId,
        milestone_type: milestoneType,
        milestone_value: milestoneValue,
        triggered_at: new Date().toISOString().split("T")[0],
        message_queued: true,
      },
      { onConflict: "player_id,milestone_type" }
    );
}

// ─── Batch runner ──────────────────────────────────────────────────────────────

export interface BatchResult {
  ok: boolean;
  stats: Record<string, number>;
  errors?: string[];
}

// Private helper: determines which milestone (if any) should fire for a player,
// using pre-fetched in-memory data. Returns the first eligible milestone with its
// Anthropic prompt, or null if none qualify. Preserves the same priority order and
// dedup logic as checkPlayerMilestones.
function computeMilestoneDecision(
  player: {
    id: string;
    name: string;
    membership_status: string | null;
    coach_assigned_level: string | null;
  },
  attendances: { attended_at: string }[],
  milestoneMap: Map<string, { milestone_value: number | null; triggered_at: string }>
): { milestoneType: MilestoneType; milestoneValue: number | null; userPrompt: string } | null {
  const total = attendances.length;
  const firstName = player.name.split(" ")[0];

  for (const threshold of [50, 25, 10] as const) {
    if (total >= threshold) {
      const key = `session_${threshold}` as MilestoneType;
      if (!milestoneMap.has(key)) {
        const promptMap: Record<number, string> = {
          50: `Write a celebration message for ${firstName} who just played their 50th session at PB Club. They are a ${player.membership_status ?? "non-member"}. Current level: ${player.coach_assigned_level ?? "unassigned"}. Make it feel like a genuine milestone — because it is. Short and warm.`,
          25: `Write a celebration message for ${firstName} who just played their 25th session at PB Club. They're becoming a real regular. Short, warm, encouraging.`,
          10: `Write a celebration message for ${firstName} who just hit their 10th session at PB Club. They're officially a regular now. Welcome them to the club community. Short and warm.`,
        };
        return { milestoneType: key, milestoneValue: null, userPrompt: promptMap[threshold] };
      }
      break;
    }
  }

  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const currentMonthCount = attendances.filter((r) => monthKey(r.attended_at) === currentMonthKey).length;
  if (currentMonthCount >= 3) {
    const priorCounts = Object.entries(
      attendances
        .filter((r) => monthKey(r.attended_at) < currentMonthKey)
        .reduce<Record<string, number>>((acc, r) => {
          const mk = monthKey(r.attended_at);
          acc[mk] = (acc[mk] ?? 0) + 1;
          return acc;
        }, {})
    ).map(([, v]) => v);
    const bestPrior = priorCounts.length > 0 ? Math.max(...priorCounts) : 0;
    if (currentMonthCount > bestPrior) {
      const currentMonthInt = parseInt(currentMonthKey.replace("-", ""), 10);
      const existingBest = milestoneMap.get("best_month");
      const alreadyTriggeredThisMonth = existingBest?.milestone_value === currentMonthInt;
      if (!alreadyTriggeredThisMonth) {
        return {
          milestoneType: "best_month",
          milestoneValue: currentMonthInt,
          userPrompt: `Write a celebration message for ${firstName} who just had their most active month ever at PB Club with ${currentMonthCount} sessions. Celebrate their momentum. Short and warm.`,
        };
      }
    }
  }

  const distinctWeeks = [...new Set(attendances.map((r) => isoWeekKey(r.attended_at)))].sort();
  if (distinctWeeks.length >= 3) {
    const lastThree = distinctWeeks.slice(-3);
    const weekNums = lastThree.map((wk) => {
      const [yearPart, weekPart] = wk.split("-W");
      return parseInt(yearPart, 10) * 100 + parseInt(weekPart, 10);
    });
    const isActuallyConsecutive =
      weekNums[1] === weekNums[0] + 1 && weekNums[2] === weekNums[1] + 1;
    if (isActuallyConsecutive) {
      const existing = milestoneMap.get("streak_3w");
      const twentyOneDaysAgo = new Date(Date.now() - 21 * 86400000).toISOString().split("T")[0];
      const recentlyTriggered = existing && existing.triggered_at >= twentyOneDaysAgo;
      if (!recentlyTriggered) {
        return {
          milestoneType: "streak_3w",
          milestoneValue: null,
          userPrompt: `Write a celebration message for ${firstName} who has attended PB Club sessions for 3 weeks in a row. Celebrate their consistency. Short and warm.`,
        };
      }
    }
  }

  return null;
}

export async function runMilestoneBatch(): Promise<BatchResult> {
  if (isRetentionOnlyMode()) {
    throw new Error("Legacy milestone generation is parked by RETENTION_ONLY_MODE");
  }
  await startJob(JOB_ID);
  await appendJobLog(JOB_ID, "Milestone batch started");

  let checked = 0, triggered = 0, errorCount = 0;

  try {
    // ── 1. Bulk-fetch all players with a last_visit_date ──────────────────────
    type PlayerRow = {
      id: string; name: string; phone: string | null; club_id: string;
      sms_opt_in: boolean | null; coach_assigned_level: string | null;
      membership_status: string | null;
    };
    const allPlayers: PlayerRow[] = [];
    {
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("players")
          .select("id, name, phone, club_id, sms_opt_in, coach_assigned_level, membership_status")
          .not("last_visit_date", "is", null)
          .range(offset, offset + 999);
        if (error) {
          await appendJobLog(JOB_ID, `Fetch error: ${error.message}`);
          break;
        }
        if (!data || data.length === 0) break;
        allPlayers.push(...(data as PlayerRow[]));
        if (data.length < 1000) break;
        offset += 1000;
      }
    }

    const eligible = allPlayers.filter((p) => p.phone && p.sms_opt_in !== false);
    const eligibleIds = eligible.map((p) => p.id);
    await appendJobLog(JOB_ID, `Found ${allPlayers.length} players, ${eligible.length} eligible — bulk-fetching attendances and milestones`);

    // ── 2. Bulk-fetch attendances for eligible players (500-player chunks) ─────
    const attendanceMap = new Map<string, { attended_at: string }[]>();
    for (let i = 0; i < eligibleIds.length; i += 100) {
      const chunk = eligibleIds.slice(i, i + 100);
      let attOffset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("attendances")
          .select("player_id, attended_at")
          .in("player_id", chunk)
          .order("attended_at", { ascending: true })
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

    // ── 3. Bulk-fetch existing milestones for eligible players ─────────────────
    const playerMilestoneMap = new Map<
      string,
      Map<string, { milestone_value: number | null; triggered_at: string }>
    >();
    for (let i = 0; i < eligibleIds.length; i += 100) {
      const chunk = eligibleIds.slice(i, i + 100);
      const { data, error } = await supabase
        .from("player_milestones")
        .select("player_id, milestone_type, milestone_value, triggered_at")
        .in("player_id", chunk);
      if (error) throw new Error(error.message);
      for (const m of (data ?? []) as {
        player_id: string; milestone_type: string;
        milestone_value: number | null; triggered_at: string;
      }[]) {
        if (!playerMilestoneMap.has(m.player_id)) playerMilestoneMap.set(m.player_id, new Map());
        playerMilestoneMap.get(m.player_id)!.set(m.milestone_type, {
          milestone_value: m.milestone_value,
          triggered_at: m.triggered_at,
        });
      }
    }

    await appendJobLog(JOB_ID, `Bulk fetch complete — processing ${eligible.length} eligible players`);

    // ── 4. Process each player in memory; Anthropic + persist only on trigger ──
    for (const player of eligible) {
      try {
        const attendances = attendanceMap.get(player.id) ?? [];
        const milestoneMap = playerMilestoneMap.get(player.id) ?? new Map();
        checked++;

        const decision = computeMilestoneDecision(player, attendances, milestoneMap);
        if (decision) {
          const body = await callAnthropic(decision.userPrompt);
          await persistMilestone(player.id, player, decision.milestoneType, decision.milestoneValue, body, (conv) => conv);
          triggered++;
        }
      } catch (err: any) {
        errorCount++;
        logger.error({ err, playerId: player.id }, "[milestone_check] player error");
      }
      if (checked % 100 === 0) {
        await appendJobLog(JOB_ID, `Processed ${checked}/${eligible.length}…`);
      }
    }

    await appendJobLog(JOB_ID, `Done — checked: ${checked}, triggered: ${triggered}, errors: ${errorCount}`);
    await finishJob(JOB_ID, "done", { checked, triggered, errors: errorCount });
    return { ok: errorCount === 0, stats: { checked, triggered, errors: errorCount } };
  } catch (err: any) {
    logger.error({ err }, "[milestone_check] batch error");
    await appendJobLog(JOB_ID, `Milestone batch failed: ${err.message}`);
    await finishJob(JOB_ID, "error", { checked, triggered, errors: errorCount }, err.message);
    return { ok: false, stats: { checked, triggered, errors: errorCount }, errors: [err.message] };
  }
}
