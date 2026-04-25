import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
// @ts-ignore — plain JS module
import { assembleProfile } from "../assembleProfile.js";
// @ts-ignore — plain JS module
import { fetchAvailablePrograms } from "../fetchAvailablePrograms.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

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

---

AVAILABLE PROGRAMMING
You will receive a second JSON object listing current programs — name, description, price, spots remaining, and start_time (ISO timestamp of when the session begins).

When referencing a specific upcoming session or program in your message, always include the full date alongside the day name — formatted as "Sunday, Apr 27" (day name, abbreviated month, day number). Never reference a session by day name alone (e.g. never just "on Sunday"). Derive this date from the program's start_time field.

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
  "reasoning": "1–2 sentences explaining why you selected these programs for this player"
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

  // Fetch player profile and live programs in parallel
  let assembled: any;
  let available_programs: any[];
  try {
    [assembled, available_programs] = await Promise.all([
      assembleProfile(player_id),
      fetchAvailablePrograms(),
    ]);
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

  const playerProfileForAgent = {
    name: profile.name,
    skill_level: profile.skill_level ?? null,
    last_visit_date,
    programs_attended,
    membership_status: profile.membership_status ?? "non-member",
    progression_status: profile.progression_status ?? null,
    notes: profile.notes ?? null,
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
