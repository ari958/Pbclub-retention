import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
// @ts-ignore — plain JS module
import { assembleProfile } from "../assembleProfile.js";
// @ts-ignore — plain JS module
import { fetchAvailablePrograms } from "../fetchAvailablePrograms.js";
import { supabase } from "../lib/supabaseClient";

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

OUTPUT FORMAT
Return only a valid JSON object. No preamble, no explanation outside the JSON.

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

  const userMessage = `PLAYER PROFILE:\n${JSON.stringify(playerProfileForAgent, null, 2)}\n\nAVAILABLE PROGRAMS:\n${JSON.stringify(available_programs, null, 2)}`;

  let agentResponse: any;
  try {
    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = (completion.content[0] as { type: string; text: string }).text;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
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

  // Create message record linked to this conversation
  const { data: messageData, error: messageError } = await supabase
    .from("messages")
    .insert({
      conversation_id,
      body: agentResponse.message,
      direction: "outbound",
      sent_by: "agent",
      signup_url,
    })
    .select("id")
    .single();

  if (messageError) {
    req.log.error({ err: messageError }, "Failed to create message record");
    res.status(500).json({ error: "Failed to create message", detail: messageError.message });
    return;
  }

  const message_id: string = messageData.id;

  res.json({
    conversation_id,
    message_id,
    ...agentResponse,
  });
});

export default router;
