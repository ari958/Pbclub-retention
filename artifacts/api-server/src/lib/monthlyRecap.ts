import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "./supabaseClient";
import { startJob, finishJob, appendJobLog } from "./jobStore";
import { logger } from "./logger";
import type { BatchResult } from "./milestoneCheck";
import { isRetentionOnlyMode } from "./retentionPolicy";
import { AGENT_MODEL } from "./anthropicConfig";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const JOB_ID = "monthly_recap";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function recapMonthKey(month: number, year: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthName(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

// ─── Single-player recap ───────────────────────────────────────────────────────

export async function generateMonthlyRecap(
  playerId: string,
  month: number,
  year: number,
  dryRun = false
): Promise<{ skipped: boolean; reason?: string; message_body?: string; stats?: any }> {
  if (isRetentionOnlyMode()) {
    return { skipped: true, reason: "Legacy monthly recap generation is parked by RETENTION_ONLY_MODE" };
  }
  const recapKey = recapMonthKey(month, year);

  // 1. Fetch player
  const { data: player, error: playerErr } = await supabase
    .from("players")
    .select("id, name, phone, club_id, sms_opt_in, membership_status, coach_assigned_level, last_outbound_at, coach_level_set_at")
    .eq("id", playerId)
    .maybeSingle();

  if (playerErr || !player) {
    return { skipped: true, reason: playerErr?.message ?? "player not found" };
  }

  // 2. Skip if opted out or no phone
  if (player.sms_opt_in === false) return { skipped: true, reason: "sms_opt_in false" };
  if (!player.phone) return { skipped: true, reason: "no phone" };

  // 3. Check for existing recap
  if (!dryRun) {
    const { data: existing } = await supabase
      .from("monthly_recaps")
      .select("id")
      .eq("player_id", playerId)
      .eq("recap_month", recapKey)
      .maybeSingle();
    if (existing) return { skipped: true, reason: "already queued" };
  }

  // 4. Compute recap stats
  const recapStart = new Date(year, month - 1, 1).toISOString().split("T")[0];
  const recapEnd   = new Date(year, month, 0).toISOString().split("T")[0];

  const [sessionsRes, totalRes, playerEventsRes] = await Promise.all([
    // sessions this month
    supabase
      .from("attendances")
      .select("id", { count: "exact", head: true })
      .eq("player_id", playerId)
      .gte("attended_at", recapStart)
      .lte("attended_at", recapEnd),
    // total sessions ever
    supabase
      .from("attendances")
      .select("id", { count: "exact", head: true })
      .eq("player_id", playerId)
      .lte("attended_at", recapEnd),
    // event_ids this player attended this month (for partner computation)
    supabase
      .from("attendances")
      .select("event_id")
      .eq("player_id", playerId)
      .gte("attended_at", recapStart)
      .lte("attended_at", recapEnd),
  ]);

  const sessionsThisMonth = sessionsRes.count ?? 0;
  const totalSessionsEver = totalRes.count ?? 0;

  // Skip if fewer than 2 sessions
  if (sessionsThisMonth < 2) {
    return { skipped: true, reason: `only ${sessionsThisMonth} sessions (min 2)` };
  }

  // Compute unique partners manually from event overlap
  let uniqueCourtPartners = 0;
  let topPartners: { name: string; shared: number }[] = [];

  const playerEventIds = (playerEventsRes.data ?? []).map((r: any) => r.event_id).filter(Boolean);
  if (playerEventIds.length > 0) {
    const { data: partnerRows } = await supabase
      .from("attendances")
      .select("player_id")
      .in("event_id", playerEventIds)
      .neq("player_id", playerId);

    if (partnerRows && partnerRows.length > 0) {
      const countMap: Record<string, number> = {};
      for (const row of partnerRows) {
        countMap[row.player_id] = (countMap[row.player_id] ?? 0) + 1;
      }
      uniqueCourtPartners = Object.keys(countMap).length;

      // Top 3 partners
      const sorted = Object.entries(countMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      const topIds = sorted.map(([id]) => id);
      const { data: nameRows } = await supabase
        .from("players")
        .select("id, name")
        .in("id", topIds);

      const nameMap: Record<string, string> = {};
      for (const r of nameRows ?? []) nameMap[r.id] = r.name;

      topPartners = sorted.map(([id, shared]) => ({
        name: nameMap[id] ?? "Unknown",
        shared,
      }));
    }
  }

  // Level change this month?
  let levelChanged = false;
  if (player.coach_assigned_level && player.coach_level_set_at) {
    const setAt = player.coach_level_set_at.split("T")[0];
    levelChanged = setAt >= recapStart && setAt <= recapEnd;
  }

  const firstName = player.name.split(" ")[0];
  const mn = monthName(month);

  // 5. Build prompt
  let partnerLine = "";
  if (topPartners.length > 0) {
    const formatted = topPartners.map((p) => {
      const parts = p.name.trim().split(" ");
      const li = parts.length > 1 ? parts[parts.length - 1][0] + "." : "";
      return `${parts[0]}${li ? " " + li : ""} (${p.shared}x)`;
    }).join(", ");
    partnerLine = `- Most frequent court partners: ${formatted}`;
  }

  const userMsg = `Write a monthly recap message for ${firstName}.

Their ${mn} stats:
- Sessions attended: ${sessionsThisMonth}
- Total sessions ever at PB Club: ${totalSessionsEver}
- Unique players shared court with: ${uniqueCourtPartners}
${partnerLine}
${levelChanged ? `- Level updated to: ${player.coach_assigned_level}` : ""}
${player.membership_status === "member" ? "- Membership: Active member" : ""}

Make it feel warm and personal. Reference their court partners by first name and last initial if available. Celebrate their consistency. End with an encouraging nudge to keep playing.`;

  const systemMsg = `You are a warm, encouraging retention agent for PB Club, a pickleball facility. Write a monthly recap SMS message for a player. The message should feel personal and celebratory — like it came from a coach who knows them, not a marketing tool. Keep it under 160 characters if possible, or under 320 if you need to include all the stats. Do not use hashtags. Do not mention the club name more than once. End with a forward-looking nudge to come back. Output only the message text, no subject line, no preamble.`;

  // 6. Call Anthropic
  let messageBody = "";
  const completion = await anthropic.messages.create({
    model: AGENT_MODEL,
    max_tokens: 300,
    system: systemMsg,
    messages: [{ role: "user", content: userMsg }],
  });
  messageBody = (completion.content[0] as { type: string; text: string }).text.trim();

  const stats = {
    sessions_this_month: sessionsThisMonth,
    total_sessions_ever: totalSessionsEver,
    unique_court_partners: uniqueCourtPartners,
    top_partners: topPartners,
    level_changed: levelChanged,
  };

  if (dryRun) {
    return { skipped: false, message_body: messageBody, stats };
  }

  // 8. Create conversation
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .insert({ player_id: playerId, club_id: player.club_id, triggered_by: "monthly_recap" })
    .select("id")
    .single();

  if (convErr || !conv) throw new Error(convErr?.message ?? "failed to create conversation");

  // 10. Record monthly_recap row FIRST — acts as the idempotency marker.
  // If a crash follows and the job is re-run, the existence check at the top of
  // this function will short-circuit before generating or sending a second SMS.
  // Trade-off: if the message INSERT below fails, the player misses this month's
  // recap SMS. That is the correct failure mode — one missed recap beats two.
  await supabase
    .from("monthly_recaps")
    .upsert(
      { player_id: playerId, recap_month: recapKey, message_queued: true },
      { onConflict: "player_id,recap_month", ignoreDuplicates: true }
    );

  // 9. Insert message
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

  return { skipped: false, message_body: messageBody, stats };
}

// ─── Batch runner ──────────────────────────────────────────────────────────────

export async function runMonthlyRecapBatch(
  month: number,
  year: number
): Promise<BatchResult> {
  if (isRetentionOnlyMode()) {
    throw new Error("Legacy monthly recap generation is parked by RETENTION_ONLY_MODE");
  }
  await startJob(JOB_ID);
  await appendJobLog(JOB_ID, `Monthly recap batch started — ${monthName(month)} ${year}`);

  let queued = 0, skipped = 0, errorCount = 0;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id")
      .not("last_visit_date", "is", null)
      .neq("sms_opt_in", false)
      .not("phone", "is", null)
      .range(offset, offset + 999);

    if (error) {
      await appendJobLog(JOB_ID, `Fetch error: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;

    for (const player of data) {
      try {
        const result = await generateMonthlyRecap(player.id, month, year);
        if (result.skipped) skipped++;
        else queued++;
      } catch (err: any) {
        errorCount++;
        logger.error({ err, playerId: player.id }, "[monthly_recap] player error");
      }
      await delay(100);
    }

    if (data.length < 1000) break;
    offset += 1000;
  }

  await appendJobLog(JOB_ID, `Done — queued: ${queued}, skipped: ${skipped}, errors: ${errorCount}`);
  await finishJob(JOB_ID, "done", { queued, skipped, errors: errorCount });
  return { ok: errorCount === 0, stats: { queued, skipped, errors: errorCount } };
}
