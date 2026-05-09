import { supabase } from "./supabaseClient";
import { logger } from "./logger";

// 4-level order for gap calculation — index 0 = lowest
const LEVEL_ORDER = ["beginner", "advanced_beginner", "intermediate", "advanced"] as const;

function normalizeLevelString(level: string | null | undefined): string | null {
  if (!level) return null;
  const l = level.toLowerCase().trim();
  if (l === "beginner") return "beginner";
  if (l === "advanced beginner" || l === "advanced_beginner") return "advanced_beginner";
  if (l === "low intermediate" || l === "intermediate") return "intermediate";
  if (l === "advanced intermediate" || l === "advanced") return "advanced";
  return null;
}

function levelIndex(level: string | null | undefined): number {
  const normalized = normalizeLevelString(level);
  if (!normalized) return -1;
  return LEVEL_ORDER.indexOf(normalized as (typeof LEVEL_ORDER)[number]);
}

function decayMultiplier(lastVisitDate: string | null): number {
  if (!lastVisitDate) return 0.3;
  const daysSince = (Date.now() - new Date(lastVisitDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 30) return 1.0;
  if (daysSince <= 90) return 0.6;
  return 0.3;
}

async function cacheScore(playerId: string, score: number): Promise<void> {
  const { error } = await supabase
    .from("players")
    .update({
      warm_score: score,
      warm_score_updated_at: new Date().toISOString(),
    })
    .eq("id", playerId);
  if (error) {
    logger.warn({ playerId, err: error.message }, "[warmScore] failed to cache score");
  }
}

export interface WarmScoreOptions {
  programStartDate?: Date;
  programLevel?: string;
  forceRefresh?: boolean;
}

/**
 * Compute a warm score for a player+program combination.
 * Higher = warmer (more likely to engage directly).
 *
 * Score interpretation:
 *   > 6  → "direct"  — embed signup link
 *   3–6  → "ask"     — ask if they want details/link
 *   < 3  → "soft"    — mention only, no ask, no link
 *
 * Special returns:
 *   10   → force warm (program starts within 48 h)
 *  -10   → force cold (player opted out / negative reply)
 *   0    → ask first  (brand-new player < 14 days)
 */
export async function computeWarmScore(
  playerId: string,
  programType: string,
  programName: string,
  options: WarmScoreOptions = {},
): Promise<number> {
  const { programStartDate, programLevel, forceRefresh = false } = options;

  // ── Fetch player row ──────────────────────────────────────────────────────
  const { data: player, error: playerError } = await supabase
    .from("players")
    .select(
      "id, last_visit_date, progression_status, skill_level, warm_score, warm_score_updated_at",
    )
    .eq("id", playerId)
    .maybeSingle();

  if (playerError || !player) {
    logger.warn({ playerId, err: playerError?.message }, "[warmScore] player not found");
    return 0;
  }

  // ── Cache check ───────────────────────────────────────────────────────────
  if (!forceRefresh && player.warm_score != null && player.warm_score_updated_at) {
    const ageMs = Date.now() - new Date(player.warm_score_updated_at).getTime();
    if (ageMs < 24 * 60 * 60 * 1000) {
      logger.info({ playerId, cached: player.warm_score }, "[warmScore] returning cached score");
      return player.warm_score as number;
    }
  }

  // ── EDGE: program starts within 48 hours → force warm ────────────────────
  if (programStartDate) {
    const hoursUntil = (programStartDate.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntil >= 0 && hoursUntil <= 48) {
      logger.info({ playerId, hoursUntil }, "[warmScore] imminent program — forcing warm (10)");
      await cacheScore(playerId, 10);
      return 10;
    }
  }

  // ── Fetch messages and attendances in parallel ────────────────────────────
  // Uses messages.player_id (denormalized 2026-05-07) — no conversations join needed
  const [messagesResult, attendancesResult] = await Promise.all([
    supabase
      .from("messages")
      .select("direction, reply_sentiment, body, link_clicked, ignored")
      .eq("player_id", playerId),
    supabase
      .from("attendances")
      .select("program_name, program_type, session_type, attended_at")
      .eq("player_id", playerId),
  ]);
  const allMsgs: any[] = messagesResult.data ?? [];
  const inboundMsgs = allMsgs.filter((m: any) => m.direction === "inbound");
  const outboundMsgs = allMsgs.filter((m: any) => m.direction === "outbound");

  // ── EDGE: negative sentiment or STOP → force cold ────────────────────────
  const hasNegative = inboundMsgs.some(
    (m: any) =>
      m.reply_sentiment === "negative" ||
      (typeof m.body === "string" && m.body.toLowerCase().includes("stop")),
  );
  if (hasNegative) {
    logger.info({ playerId }, "[warmScore] negative/stop — forcing cold (-10)");
    await cacheScore(playerId, -10);
    return -10;
  }

  const allAttendances: any[] = attendancesResult.data ?? [];

  // ── EDGE: new player (first attendance < 14 days ago, or no attendance yet) ──
  // Uses first attendance date rather than players.created_at — created_at is
  // the DB row insert timestamp, which fires the "new" branch for every player
  // imported during initial setup.
  if (allAttendances.length === 0) {
    logger.info({ playerId }, "[warmScore] no attendance history — returning 0");
    await cacheScore(playerId, 0);
    return 0;
  }
  const firstAttendedAt = allAttendances
    .map((a: any) => new Date(a.attended_at).getTime())
    .reduce((min: number, t: number) => (t < min ? t : min), Date.now());
  const daysSinceFirstAttended = (Date.now() - firstAttendedAt) / (1000 * 60 * 60 * 24);
  if (daysSinceFirstAttended < 14) {
    logger.info({ playerId, daysSinceFirstAttended }, "[warmScore] new player (first attendance < 14d) — returning 0");
    await cacheScore(playerId, 0);
    return 0;
  }

  // ── Decay multiplier (attendance-based signals only) ──────────────────────
  const decay = decayMultiplier(player.last_visit_date);

  let score = 0;

  // ─── POSITIVE ATTENDANCE-BASED SIGNALS (apply decay) ─────────────────────

  // +5  exact program match
  if (allAttendances.some((a: any) => a.program_name === programName)) {
    score += 5 * decay;
  }

  // +4  same program_type attended before
  if (
    programType &&
    allAttendances.some(
      (a: any) => a.program_type && a.program_type === programType,
    )
  ) {
    score += 4 * decay;
  }

  // +2  attended a trial or intro session
  if (
    allAttendances.some(
      (a: any) =>
        a.session_type && ["trial", "intro"].includes(a.session_type.toLowerCase()),
    )
  ) {
    score += 2 * decay;
  }

  // ─── POSITIVE NON-ATTENDANCE SIGNALS (no decay) ───────────────────────────

  // +3  progression_status = "ready-to-advance"
  if (player.progression_status === "ready-to-advance") score += 3;

  // +4  replied positively to a prior message
  if (inboundMsgs.some((m: any) => m.reply_sentiment === "positive")) score += 4;

  // +3  clicked a link in a prior message
  if ([...inboundMsgs, ...outboundMsgs].some((m: any) => m.link_clicked === true)) score += 3;

  // ─── NEGATIVE SIGNALS ─────────────────────────────────────────────────────

  // -2  has never attended this program_type
  const hasAttendedType =
    programType &&
    allAttendances.some((a: any) => a.program_type && a.program_type === programType);
  if (!hasAttendedType) score -= 2;

  // -3  2+ ignored outbound messages
  const ignoredCount = outboundMsgs.filter((m: any) => m.ignored === true).length;
  if (ignoredCount >= 2) score -= 3;

  // -3  program level is 2+ levels above player's skill_level
  if (programLevel && player.skill_level) {
    const gap = levelIndex(programLevel) - levelIndex(player.skill_level);
    if (gap >= 2) score -= 3;
  }

  // -2  last visit 30+ days ago (or no visit at all)
  const lastVisit = player.last_visit_date;
  if (lastVisit) {
    const daysSince = (Date.now() - new Date(lastVisit).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= 30) score -= 2;
  } else {
    score -= 2;
  }

  // -1  no coach assessment (progression_status is null)
  if (!player.progression_status) score -= 1;

  const finalScore = Math.round(score);

  logger.info(
    { playerId, programType, programName, score: finalScore, decay },
    "[warmScore] computed",
  );

  await cacheScore(playerId, finalScore);
  return finalScore;
}

/** Map a numeric warm score to a link strategy string. */
export function scoreToLinkStrategy(score: number): "direct" | "ask" | "soft" {
  if (score > 6) return "direct";
  if (score >= 3) return "ask";
  return "soft";
}
