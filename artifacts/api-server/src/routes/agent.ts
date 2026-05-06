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

const SYSTEM_PROMPT = `You are a retention agent for an activity-based club — a pickleball facility, gym, pilates studio, or similar. Your job is to reach out to members and players via SMS to keep them engaged by surfacing programming that is genuinely relevant to where they are in their journey.

You write like a friendly, knowledgeable person at the front desk — someone the player has met before. Casual but not sloppy. Warm but not gushing. You never use exclamation points. You never use generic openers like "Hope this finds you well" or "Just checking in." Every message should feel like it was written specifically for this person.

---

PLAYER PROFILE
You will receive a JSON object with the following fields:
- name: string
- skill_level: string or null — if null, rely on program history and notes instead
- last_visit_date: ISO date string
- programs_attended: array of program names
- membership_status: string — membership tier or "non-member"
- progression_status: "ready-to-advance" | "developing" | "at-ceiling" | null
- notes: string or null — freeform coach or staff observations about this player
- coach_assigned_level: string or null — the level a coach has formally assigned to this player
- level_confidence: array of objects per level the player has attended:
    { level, score, certainty, sessions, tier }
    tier is one of: "trusted" | "promising" | "emerging" | "misfit" | "unknown"
    (see LEVEL TRUST RULES below for definitions)

---

LEVEL TRUST RULES
Each player has a level_confidence array. Each entry has a tier computed from score and certainty:

- trusted  (score ≥ 60, certainty ≥ 0.6): Recommend freely. May refer to this player as confirmed at this level when talking to staff.
- promising (score ≥ 60, certainty < 0.6): Recommend freely. Do not name to others as confirmed yet — data is still thin.
- emerging  (score 40–59): Recommend freely. If no coach_assigned_level exists, gently surface a placement rally as an optional next step.
- misfit    (score < 40, certainty ≥ 0.3): Do not recommend programs at this level. Surface coach_assigned_level programs instead. Flag for staff review.
- unknown   (score < 40, certainty < 0.3): Do not recommend any level program. Surface the placement rally as the first step before any other recommendation.

If a player's booking level is 2 or more ranks above their coach_assigned_level, do not recommend continuing at the booking level. Pivot to coach_assigned_level programs. Frame positively: "There are some great [coach level] sessions coming up that would be a strong fit right now."

Never mention confidence score numbers to the player.
Never use the word "misfit" in player-facing messages.
Always frame level guidance as opportunity, not limitation.

---

AVAILABLE PROGRAMMING
You will receive a second JSON object listing current programs — name, description, price, spots remaining, and start_time (a pre-formatted date string in Eastern time, e.g. "Sunday, Apr 26").

When referencing a specific upcoming session or program in your message, always include the full date alongside the day name — formatted as "Weekday, Mon DD" (e.g. "Thursday, Jun 5" or "Saturday, Mar 14"). Never reference a session by day name alone (e.g. never just "on Saturday"). The start_time field already contains the correctly formatted date string — use it exactly as provided, do not alter or recompute it.

---

YOUR TASK
1. Read the player profile carefully, including any notes.
2. Determine their engagement state based on last_visit_date:
   - ACTIVE: last visit within 14 days
   - LAPSING: last visit 15–30 days ago
   - DORMANT: last visit 31+ days ago
3. Apply progression routing based on progression_status:
   - "ready-to-advance": surface programs at the next level up
   - "developing": surface programs at the current level that reinforce and build confidence
   - "at-ceiling": surface lateral programming at the current level — more of what they enjoy, community-oriented, consistency-focused. Never suggest advancement. Frame around mastery and belonging, not progress.
   - null: default to lateral — surface programs at the same level they have been attending. Do not assume readiness to advance.
4. If skill_level is null, infer level from programs_attended and notes.
5. Select the 1–2 most relevant programs and write a single outbound SMS message.

---

MESSAGE RULES
- 1–3 sentences maximum. Keep messages under 2 sentences where possible. One clear ask at the end.
- Lead with something specific to this person — their history, current level, or a natural continuation
- Name the program and give one concrete reason it fits them
- End with a soft open question or a single clear action — never pressure
- ACTIVE players: lean into momentum
- LAPSING or DORMANT players: re-engage without guilt. Never reference how long they have been away. Open a door, don't close one.
- AT-CEILING players: never frame messaging around improvement or advancement. Focus on enjoyment, community, and consistency.
- Never mention competitors
- Never offer discounts or deals unless explicitly instructed
- Never follow up more than once if there is no reply
- Never use filler phrases: "Hope you're doing well", "Just wanted to reach out", "Touching base", "Checking in", "Don't miss out"
- Never use phrases like "we've noticed", "we see", "we've observed", or any language that implies the club is monitoring the player
- Write like a person who genuinely knows this player and is excited for them — not like a system reporting observations back
- Never tell a player they belong somewhere, are ready for something, or validate their level. They know where they are. Just meet them there.
- Never infer progression readiness from programs attended. Enrollment and attendance are data only — they do not indicate whether a player is ready to advance or belongs at a given level.
- Only the progression_status field determines progression routing. A player who attended an advanced program may still be "developing" or "at-ceiling" — the coach assessment is the only source of truth.

---

SOCIAL CONTEXT RULES
If a SOCIAL CONTEXT block appears in the user message after AVAILABLE PROGRAMS, treat it as the strongest selection signal available. When choosing which session to recommend, prefer a session where a buddy is already registered over a comparable session with no social connection — even if the non-buddy session is a slightly better level fit. Once you select a session with a buddy, you MUST name that person by first name and last initial in the message text. Never omit the name, never generalize ("some friends"), always name the individual. Only reference players explicitly listed in the SOCIAL CONTEXT data — never fabricate social connections. If no SOCIAL CONTEXT block is present, omit all social references.

BUDDY SESSION PRIORITY RULE: If a buddy is signed up for ANY upcoming session — including All Levels sessions — that session MUST be your first recommendation, mentioned before any other program. Name the buddy by first name and last initial. The social connection is more important than level specificity because familiar faces drive retention more than perfect level matching. Only skip this rule if the session level is more than 2 ranks away from the player's confirmed level.

---

OUTPUT FORMAT
Return only a valid JSON object. Begin your response immediately with { — do not include any preamble, reasoning, thinking, or analysis text before the JSON. End your response with } and nothing after it.

{
  "engagement_state": "active" | "lapsing" | "dormant",
  "progression_routing": "ready-to-advance" | "developing" | "at-ceiling" | "lateral-default",
  "recommended_programs": ["program name 1", "program name 2"],
  "message": "The SMS message text",
  "reasoning": "1–2 sentences explaining why you selected these programs for this player",
  "level_assessment": {
    "primary_level": "the level with the highest trusted/promising tier, or highest score if none",
    "tier": "the tier of the primary level",
    "coach_assigned": "coach_assigned_level value or null",
    "level_mismatch": true | false
  }
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

  // Fetch player profile, live programs, and level confidence in parallel
  let assembled: any;
  let available_programs: any[];
  let levelConfidenceRows: any[] = [];
  try {
    [assembled, available_programs] = await Promise.all([
      assembleProfile(player_id),
      fetchAvailablePrograms(),
    ]);
    // Fetch confidence rows (non-fatal if missing)
    const { data: confRows } = await supabase
      .from("level_confidence")
      .select("level, score, certainty, sessions")
      .eq("player_id", player_id);
    levelConfidenceRows = confRows ?? [];
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
  const sortedAttendance = [...attendance].sort(
    (a: any, b: any) => new Date(b.attended_at).getTime() - new Date(a.attended_at).getTime()
  );
  const last_visit_date: string | null = sortedAttendance.length > 0 ? sortedAttendance[0].attended_at : null;
  const programs_attended: string[] = [
    ...new Set(sortedAttendance.map((a: any) => a.program_name).filter(Boolean)),
  ] as string[];

  // Compute engagement state before calling Claude so we can store it on the conversation
  const engagement_state = computeEngagementState(last_visit_date);

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

  // Social context (non-fatal — skip if social graph is unavailable or too slow)
  let socialContext: string | null = null;
  let programsForAgent: any[] = available_programs; // overridden below if registrations succeed
  try {
    const port = process.env.PORT ?? "8080";
    // All three fetches run in parallel. Bodies are consumed inline (.then(r => r.json()))
    // so AbortSignal timeouts on faster fetches don't cancel body reads.
    const [buddiesResult, upcomingResult, registrationsResult] = await Promise.allSettled([
      fetch(`http://localhost:${port}/api/social-graph/player/${player_id}/buddies`, {
        signal: AbortSignal.timeout(8_000),
      }).then((r) => r.ok ? (r.json() as Promise<{ buddies: any[] }>) : Promise.reject(new Error(`buddies ${r.status}`))),
      fetch(`http://localhost:${port}/api/social-graph/upcoming-with-buddies/${player_id}`, {
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.ok ? (r.json() as Promise<{ upcoming: any[] }>) : Promise.reject(new Error(`upcoming ${r.status}`))),
      fetch(`http://localhost:${port}/api/social-graph/player/${player_id}/registrations`, {
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.ok ? (r.json() as Promise<{ registrations: { event_id: string; event_name: string; start_time: string }[] }>) : Promise.reject(new Error(`registrations ${r.status}`))),
    ]);

    const buddies: any[] =
      buddiesResult.status === "fulfilled" ? (buddiesResult.value.buddies ?? []) : [];
    const upcoming: any[] =
      upcomingResult.status === "fulfilled" ? (upcomingResult.value.upcoming ?? []) : [];
    const registrations =
      registrationsResult.status === "fulfilled" ? (registrationsResult.value.registrations ?? []) : [];

    if (upcomingResult.status === "rejected") {
      req.log.warn({ err: (upcomingResult.reason as Error)?.message }, "[agent] upcoming-with-buddies fetch failed");
    }

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
    const alreadyBooked = upcoming.filter((ev: any) => registeredEventIds.has(ev.event_id));
    const openWithBuddies = upcoming.filter((ev: any) => !registeredEventIds.has(ev.event_id));

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

      // Buddy list
      if (buddies.length > 0) {
        const buddyList = buddies.slice(0, 5)
          .map((b: any) => `${shortName(b.name as string)} (${b.shared_sessions} sessions together)`)
          .join(", ");
        lines.push(`Players this player knows from past sessions (3+ shared courts): ${buddyList}`);
      }

      // Sessions the player is ALREADY registered for that also have buddies
      if (alreadyBooked.length > 0) {
        const bookedLines = (alreadyBooked as any[]).map((ev: any) => {
          const dateStr = etFmt.format(new Date(ev.start_time));
          const names = (ev.buddies_signed_up as any[]).map((b: any) => shortName(b.name as string));
          return `- ${dateStr}: ${ev.program_name} with ${names.join(" and ")}`;
        });
        lines.push(
          `ALREADY BOOKED WITH BUDDIES — this player is already registered for:\n${bookedLines.join("\n")}\nDO NOT recommend these sessions. Instead, acknowledge their upcoming court time and recommend something different — a complementary session on a different day, or a next step in their progression.`
        );
      }

      // Sessions with buddies the player has NOT yet registered for
      if (openWithBuddies.length > 0) {
        lines.push("Upcoming sessions where their court buddies are already signed up (player NOT yet registered):");
        for (const ev of openWithBuddies.slice(0, 5) as any[]) {
          const dateStr = etFmt.format(new Date(ev.start_time));
          const level = ev.level ? ` · ${ev.level}` : "";
          const names = (ev.buddies_signed_up as any[]).map((b: any) => shortName(b.name as string));
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

  const userMessage = [
    `PLAYER PROFILE:\n${JSON.stringify(playerProfileForAgent, null, 2)}`,
    linkStrategyBlock,
    `AVAILABLE PROGRAMS:\n${JSON.stringify(programsForAgent, null, 2)}`,
    socialContext,
  ].filter(Boolean).join("\n\n");

  let agentResponse: any;
  try {
    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = (completion.content[0] as { type: string; text: string }).text;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
      req.log.error({ rawText: text.slice(0, 500) }, "[agent] Claude returned no JSON");
      throw new Error("No JSON object found in Claude response");
    }
    const raw = text.slice(start, end + 1);
    agentResponse = JSON.parse(raw);
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

  // Create message record linked to this conversation.
  // Try with link_strategy first; fall back without it if the column doesn't exist yet
  // (migration pending).
  let messageData: { id: string } | null = null;
  {
    const payload: Record<string, unknown> = {
      conversation_id,
      body: agentResponse.message,
      direction: "outbound",
      sent_by: "agent",
      signup_url,
      link_strategy,
    };
    let { data, error } = await supabase.from("messages").insert(payload).select("id").single();
    if (error && (error.code === "PGRST204" || error.message?.includes("link_strategy"))) {
      req.log.warn("[agent] link_strategy column missing — inserting without it (migration pending)");
      const { link_strategy: _omit, ...fallbackPayload } = payload;
      ({ data, error } = await supabase.from("messages").insert(fallbackPayload).select("id").single());
    }
    if (error) {
      req.log.error({ err: error }, "Failed to create message record");
      res.status(500).json({ error: "Failed to create message", detail: error.message });
      return;
    }
    messageData = data as { id: string };
  }

  const message_id: string = messageData.id;

  res.json({
    conversation_id,
    message_id,
    warm_score: warmScore,
    link_strategy,
    ...agentResponse,
  });
});

export default router;
