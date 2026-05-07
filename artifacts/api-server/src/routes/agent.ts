import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
// @ts-ignore — plain JS module
import { assembleProfile } from "../assembleProfile.js";
// @ts-ignore — plain JS module
import { fetchAvailablePrograms } from "../fetchAvailablePrograms.js";
import { supabase } from "../lib/supabaseClient";
import { computeWarmScore, scorToLinkStrategy } from "../lib/warmScore";
import { computeScheduledSendAt } from "../lib/playerTiming";
import { getPlayerSocialContext } from "../lib/socialGraph";

/** Compute engagement state from last_visit_date without relying on Claude. */
function computeEngagementState(lastVisitDate: string | null): "active" | "lapsing" | "dormant" {
  if (!lastVisitDate) return "dormant";
  const daysSince = (Date.now() - new Date(lastVisitDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 14) return "active";
  if (daysSince <= 30) return "lapsing";
  return "dormant";
}

const agentRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment and try again." },
});

const AgentRunSchema = z.object({
  player_id: z.string().min(1, "player_id is required"),
});

const router: IRouter = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a retention agent for a pickleball club. You reach out to members via SMS to keep them engaged by surfacing programming that fits where they are right now.

You write like a knowledgeable person at the front desk who knows the players personally. Casual but not sloppy. Warm but not gushing.

TONE RULES — follow every one of these without exception:

Never use exclamation points.
Always use contractions — "you're" not "you are", "don't" not "do not", "we'd" not "we would".
Never start a message with an affirmation — no "Great!", "Absolutely!", "That's awesome!", or any variant.
Start with the player's name or jump straight to the point.
One ask per message. Pick the single most relevant action and ask only that. Everything else waits.
Keep messages to 1–3 sentences. Every word earns its place.
Never use a colon to introduce a list in a text message.
Never use em-dashes (—) as thought separators. Use a period instead. Two sentences beats one long one.
No enumerated lists (1. 2. 3.) in SMS messages.

BANNED WORDS — never use any of these:
self-selected, on-ramp, complement, tailored, curated, leverage, holistic, robust, seamless, journey, pathway, optimal, utilize, ensure, facilitate, elevate, enhance, unlock, actionable, align, framework, iterate, pivot, level up, deep dive, moving forward, circle back, touch base, value add, synergy, bandwidth

BANNED PHRASES — never use any of these:
"Hope this finds you well"
"Just checking in"
"I wanted to reach out"
"Don't hesitate to reach out"
"Feel free to"
"Excited to share"
"We've noticed"
"We see that you"
"We observed"
"Based on your history"
"We wanted to make sure"
"Looking forward to hearing from you"

SURVEILLANCE RULE — never reference what the system knows about the player. Don't say "we see you've been attending" or "based on your history". Make the recommendation. Let the intelligence be invisible.

LEVEL RULE — never tell a player they belong somewhere or validate their level. They already know. Meet them there.

NEW PLAYER RULE — if new_player_arc is true in the player context, never include a signup link in the first message. Welcome only. No sales, no pitch.

LINK STRATEGY RULE — you will receive a link_strategy value in the player context:
  "direct" — weave the signup_url naturally into the message as a tap-to-register option. Lead with the value, end with the link. Do not make the link the focus.
  "ask" — do not include a link. End with one question asking if they want details or the signup link. One question only.
  "soft" — mention the program briefly as something they might find interesting. No link, no ask. Informational only.

FAMILIARITY RULE — you will receive a program_familiarity value for each available program:
  "regular" — player has done this 5+ times. Never explain what the program is. Never say "you might enjoy" or "this is a great option for". Reference it as something they already know. Example: "The 60&60 is back Thursday — you've been doing well in it lately."
  "familiar" — player has done this 2-4 times. Skip the description. Acknowledge they know it and add one new piece of information (a date, a spot opening, a relevant detail). Example: "Advanced Beginner Open Play has a good group this Wednesday if you want to get some reps in."
  "tried_once" — player has done this once. Light context is fine. One sentence max on what it is, then the ask.
  "new" — player has never done this. Introduce it properly but briefly. Still 1-3 sentences total.

ENGAGEMENT STATE OPENERS — vary the opener based on state passed in the player context:
  active: get straight to the recommendation. They're engaged — no re-engagement framing needed.
  lapsing: acknowledge the gap naturally without making it awkward. "Haven't seen you in a bit" is fine. "We've missed you" is not.
  dormant: keep it light and low-pressure. One simple option. No guilt, no urgency.

OUTPUT FORMAT — return a JSON object with these fields:
{
  "message": "the SMS text only — no quotes around it",
  "reasoning": "one sentence explaining the recommendation",
  "recommended_programs": ["program name"],
  "engagement_state": "active|lapsing|dormant"
}`;

router.post("/agent/run", agentRateLimit, async (req, res) => {
  const parsed = AgentRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const { player_id } = parsed.data;
  const t0 = Date.now();

  // Fetch player profile, live programs, and level confidence in parallel
  let assembled: any;
  let available_programs: any[];
  let levelConfidenceRows: any[] = [];
  try {
    const [assembledResult, programsResult, confidenceResult] = await Promise.all([
      assembleProfile(player_id),
      fetchAvailablePrograms(),
      supabase
        .from("level_confidence")
        .select("level, score, certainty, sessions")
        .eq("player_id", player_id),
    ]);
    assembled = assembledResult;
    available_programs = programsResult;
    levelConfidenceRows = confidenceResult.data ?? [];
    req.log.info({ elapsed_ms: Date.now() - t0 }, "[timing] data fetch complete");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const supabaseError = (err as any)?.supabaseError;
    req.log.error(
      {
        err,
        supabase: supabaseError
          ? { message: supabaseError.message, code: supabaseError.code, hint: supabaseError.hint, details: supabaseError.details }
          : undefined,
      },
      "Data fetch failed in agent/run",
    );
    if (supabaseError?.code === "PGRST116" || message.includes("JSON object requested, multiple (or no) rows returned")) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    res.status(500).json({ error: message });
    return;
  }

  const { profile, attendance } = assembled;

  // Derive last_visit_date and programs_attended from attendance history
  // attendance is already ordered desc by attended_at from assembleProfile
  const last_visit_date: string | null = attendance.length > 0 ? attendance[0].attended_at : null;
  const programs_attended: string[] = [
    ...new Set(attendance.map((a: any) => a.program_name).filter(Boolean)),
  ] as string[];

  // Build program familiarity map from existing attendance records (no extra query needed)
  const attendanceCountMap = new Map<string, number>();
  for (const row of attendance) {
    if (!row.program_name) continue;
    const key = (row.program_name as string).trim().toLowerCase();
    attendanceCountMap.set(key, (attendanceCountMap.get(key) ?? 0) + 1);
  }

  function getProgramFamiliarity(programName: string): "regular" | "familiar" | "tried_once" | "new" {
    const count = attendanceCountMap.get(programName.trim().toLowerCase()) ?? 0;
    if (count >= 5) return "regular";
    if (count >= 2) return "familiar";
    if (count === 1) return "tried_once";
    return "new";
  }

  // Compute engagement state before calling Claude so we can store it on the conversation
  const engagement_state = computeEngagementState(last_visit_date);
  const daysSinceVisit = last_visit_date
    ? (Date.now() - new Date(last_visit_date).getTime()) / (1000 * 60 * 60 * 24)
    : null;
  req.log.info(
    { player_id, last_visit_date, daysSinceVisit, engagement_state },
    "[agent] engagement state computed",
  );

  // Create conversation record before calling Claude
  const { data: conversationData, error: conversationError } = await supabase
    .from("conversations")
    .insert({
      player_id,
      club_id: profile.club_id ?? null,
      triggered_by: engagement_state,
    })
    .select("id")
    .single();

  if (conversationError) {
    req.log.error({ err: conversationError }, "Failed to create conversation record");
    res.status(500).json({ error: "Failed to create conversation", detail: conversationError.message });
    return;
  }

  const conversation_id: string = conversationData.id;

  const levelConfidenceForAgent = levelConfidenceRows.map((row) => {
    let tier: string;
    if      (row.score >= 60 && row.certainty >= 0.6) tier = "trusted";
    else if (row.score >= 60)                          tier = "promising";
    else if (row.score >= 40)                          tier = "emerging";
    else if (row.certainty >= 0.3)                     tier = "misfit";
    else                                               tier = "unknown";
    return {
      level:     row.level,
      score:     row.score,
      certainty: row.certainty,
      sessions:  row.sessions,
      tier,
    };
  });

  const playerProfileForAgent = {
    name: profile.name,
    skill_level: profile.skill_level ?? null,
    last_visit_date,
    programs_attended,
    membership_status: profile.membership_status ?? "non-member",
    progression_status: profile.progression_status ?? null,
    notes: profile.notes ?? null,
    coach_assigned_level: profile.coach_assigned_level ?? null,
    level_confidence: levelConfidenceForAgent,
  };

  // Social context (non-fatal — uses consolidated lib function, no localhost self-fetch)
  let socialContext: string | null = null;
  let programsForAgent: any[] = available_programs; // overridden below if registrations succeed
  try {
    const { buddies, upcoming, registrations } = await getPlayerSocialContext(player_id, {
      logger: req.log as any,
    });

    // Build registered event ID set and filter available programs
    const registeredEventIds = new Set(registrations.map((r) => r.event_id));
    if (registeredEventIds.size > 0) {
      programsForAgent = available_programs.filter((p: any) => {
        const eventId = (p.signup_url as string | null)?.split("/events/")[1];
        return !eventId || !registeredEventIds.has(eventId);
      });
      req.log.info(
        { total: available_programs.length, filtered: programsForAgent.length, registered: registeredEventIds.size },
        "[agent] filtered already-registered events from available programs"
      );
    }

    // Split upcoming buddy sessions: already registered vs still open
    const alreadyBooked = upcoming.filter((ev) => registeredEventIds.has(ev.event_id));
    const openWithBuddies = upcoming.filter((ev) => !registeredEventIds.has(ev.event_id));

    const etFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const shortName = (name: string) => {
      const parts = name.split(" ");
      return parts.length >= 2 ? `${parts[0]} ${parts[1][0]}.` : name;
    };

    if (buddies.length > 0 || alreadyBooked.length > 0 || openWithBuddies.length > 0) {
      const lines: string[] = ["SOCIAL CONTEXT:"];

      if (buddies.length > 0) {
        const buddyList = buddies.slice(0, 5)
          .map((b) => `${shortName(b.name)} (${b.shared_sessions} sessions together)`)
          .join(", ");
        lines.push(`Players this player knows from past sessions (3+ shared courts): ${buddyList}`);
      }

      if (alreadyBooked.length > 0) {
        const bookedLines = alreadyBooked.map((ev) => {
          const dateStr = etFmt.format(new Date(ev.start_time));
          const names = ev.buddies_signed_up.map((b) => shortName(b.name));
          return `- ${dateStr}: ${ev.program_name} with ${names.join(" and ")}`;
        });
        lines.push(
          `ALREADY BOOKED WITH BUDDIES — this player is already registered for:\n${bookedLines.join("\n")}\nDO NOT recommend these sessions. Instead, acknowledge their upcoming court time and recommend something different — a complementary session on a different day, or a next step in their progression.`
        );
      }

      if (openWithBuddies.length > 0) {
        lines.push("Upcoming sessions where their court buddies are already signed up (player NOT yet registered):");
        for (const ev of openWithBuddies.slice(0, 5)) {
          const dateStr = etFmt.format(new Date(ev.start_time));
          const level = ev.level ? ` · ${ev.level}` : "";
          const names = ev.buddies_signed_up.map((b) => shortName(b.name));
          const nameStr = names.length === 1 ? `${names[0]} is` : `${names.join(" and ")} are`;
          lines.push(`${dateStr}${level} · ${nameStr} registered for ${ev.program_name}`);
        }
      }

      lines.push(
        "Use this information to personalize your outreach. Only mention players who are confirmed registered — never guess. For ALREADY BOOKED sessions, acknowledge the upcoming court time; do not re-recommend those sessions."
      );

      socialContext = lines.join("\n");
    }
  } catch (err) {
    req.log.info({ err }, "Social context fetch skipped (non-fatal)");
  }
  req.log.info({ elapsed_ms: Date.now() - t0 }, "[timing] social context complete");

  // ── Warm score + link strategy ────────────────────────────────────────────
  // Pick the top program heuristically (before Claude runs) — prefer level match,
  // fall back to first available program.
  const playerSkillLevel: string | null = profile.skill_level ?? null;
  const topProgram: any | null =
    programsForAgent.find(
      (p: any) => p.skill_level && p.skill_level === playerSkillLevel,
    ) ?? programsForAgent[0] ?? null;

  let link_strategy: "direct" | "ask" | "soft" = "soft";
  let warmScore: number | null = null;
  let topProgramSignupUrl: string | null = null;

  if (topProgram) {
    try {
      warmScore = await computeWarmScore(player_id, topProgram.program_type ?? "", topProgram.name, {
        programLevel: topProgram.skill_level ?? undefined,
      });
      link_strategy = scorToLinkStrategy(warmScore);
      if (link_strategy === "direct") {
        topProgramSignupUrl = topProgram.signup_url ?? null;
      }
      req.log.info(
        { player_id, warmScore, link_strategy, program: topProgram.name },
        "[agent] warm score computed",
      );
    } catch (err) {
      req.log.warn({ err }, "[agent] warm score failed — defaulting to soft");
    }
  }

  const linkStrategyInstruction =
    link_strategy === "direct"
      ? `A direct signup link is included. Weave it naturally into the message as a tap-to-register option. Do not make the link the focus of the message — lead with the value, end with the link.`
      : link_strategy === "ask"
        ? `Do not include a link. End the message with a single question asking if they want more details or the signup link. One question only.`
        : `Mention the program briefly as something they might find interesting. No link, no direct ask. Informational only.`;

  const linkStrategyBlock = [
    `LINK STRATEGY: ${link_strategy}`,
    linkStrategyInstruction,
    link_strategy === "direct" && topProgramSignupUrl
      ? `Signup URL: ${topProgramSignupUrl}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Annotate familiarity, then build a slim view for Claude.
  // Cap at the next 10 programs by start time. Drop description unless
  // familiarity is "new" or "tried_once" (the FAMILIARITY_RULE says regulars
  // and familiars don't need the description). Use compact field names.
  const programsForClaude = programsForAgent
    .slice(0, 10)
    .map((p: any) => {
      const familiarity = getProgramFamiliarity(p.name ?? "");
      const slim: Record<string, unknown> = {
        name: p.name,
        type: p.program_type ?? null,
        level: p.skill_level ?? null,
        spots: p.spots_remaining ?? null,
        when: p.start_time ?? null,
        familiarity,
      };
      // Only include description when Claude actually needs it
      if ((familiarity === "new" || familiarity === "tried_once") && p.description) {
        slim.description = p.description;
      }
      return slim;
    });

  const userMessage = [
    `PLAYER PROFILE:\n${JSON.stringify(playerProfileForAgent)}`,
    linkStrategyBlock,
    `AVAILABLE PROGRAMS:\n${JSON.stringify(programsForClaude)}`,
    socialContext,
  ].filter(Boolean).join("\n\n");

  let agentResponse: any;
  try {
    const completion = await anthropic.messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      },
      {
        timeout: 30_000, // 30s ceiling — measured p50 is ~10-11s
      },
    );

    const text = (completion.content[0] as { type: string; text: string }).text;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
      req.log.error({ rawText: text.slice(0, 500) }, "[agent] Claude returned no JSON");
      throw new Error("No JSON object found in Claude response");
    }
    const raw = text.slice(start, end + 1);
    agentResponse = JSON.parse(raw);
    req.log.info(
      {
        input_tokens: completion.usage?.input_tokens,
        output_tokens: completion.usage?.output_tokens,
        model: completion.model,
      },
      "[agent] anthropic usage",
    );
    req.log.info({ elapsed_ms: Date.now() - t0 }, "[timing] claude complete");
  } catch (err: unknown) {
    req.log.error({ err }, "Anthropic API call or JSON parse failed in agent/run");
    res.status(502).json({ error: "Agent call failed", detail: err instanceof Error ? err.message : "Unknown error" });
    return;
  }

  // Resolve signup_url for the first recommended program
  const firstRecommendedName: string | undefined = agentResponse.recommended_programs?.[0];
  const matchedProgram = firstRecommendedName
    ? available_programs.find((p: any) => p.name === firstRecommendedName)
    : null;
  const signup_url: string | null = matchedProgram?.signup_url ?? null;

  // ── Scheduled send timing ──────────────────────────────────────────────────
  // Parse program start date from the matched (or top) program's raw ISO field.
  const programForTiming: any = matchedProgram ?? topProgram ?? null;
  const programStartAt: Date | null =
    programForTiming?.start_time_iso ? new Date(programForTiming.start_time_iso) : null;

  const urgencyOverride = warmScore !== null && warmScore > 8;

  let scheduledSendAt: Date | null = null;
  let send_strategy: string = "default";
  let skip_reason: string | undefined;

  try {
    const timingResult = await computeScheduledSendAt(
      player_id,
      programStartAt,
      urgencyOverride,
      "America/New_York",
    );
    scheduledSendAt = timingResult.scheduledSendAt;
    send_strategy = timingResult.archetype;

    if (scheduledSendAt === null) {
      skip_reason = "Send skipped — sanitized time is in the past or program already started.";
      req.log.info({ player_id, programStartAt }, "[agent] scheduled send skipped — time in past");
    } else {
      req.log.info(
        { player_id, scheduledSendAt, send_strategy, urgencyOverride },
        "[agent] scheduled send computed",
      );
    }
  } catch (err) {
    req.log.warn({ err }, "[agent] computeScheduledSendAt failed — skipping timing");
  }

  // Create message record linked to this conversation.
  // Try with all new columns; fall back gracefully if migrations are pending.
  let messageData: { id: string } | null = null;
  {
    const payload: Record<string, unknown> = {
      conversation_id,
      player_id,
      body: agentResponse.message,
      direction: "outbound",
      sent_by: "agent",
      signup_url,
      link_strategy,
      scheduled_send_at: scheduledSendAt?.toISOString() ?? null,
      send_strategy,
    };

    const { data, error } = await supabase.from("messages").insert(payload).select("id").single();

    if (error) {
      req.log.error({ err: error }, "Failed to create message record");
      res.status(500).json({ error: "Failed to create message", detail: error.message });
      return;
    }
    messageData = data as { id: string };
  }

  const message_id: string = messageData.id;

  const responseBody: Record<string, unknown> = {
    conversation_id,
    message_id,
    warm_score: warmScore,
    link_strategy,
    scheduled_send_at: scheduledSendAt?.toISOString() ?? null,
    send_strategy,
    ...agentResponse,
  };
  if (skip_reason) responseBody.skip_reason = skip_reason;

  req.log.info({ elapsed_ms: Date.now() - t0 }, "[timing] response ready");
  res.json(responseBody);
});

export default router;
