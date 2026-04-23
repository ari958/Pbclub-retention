import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
// @ts-ignore — plain JS module
import { assembleProfile } from "../assembleProfile.js";

const ProgramSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  price: z.number().optional(),
  spots_remaining: z.number().optional(),
});

const AgentRunSchema = z.object({
  player_id: z.string().min(1, "player_id is required"),
  available_programs: z.array(ProgramSchema).min(1, "available_programs must be a non-empty array"),
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
You will receive a second JSON object listing current programs — name, description, price, and spots remaining.

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
- 1–3 sentences maximum
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

router.post("/agent/run", async (req, res) => {
  const parsed = AgentRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const { player_id, available_programs } = parsed.data;

  let assembled;
  try {
    assembled = await assembleProfile(player_id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const supabaseError = (err as any)?.supabaseError;
    req.log.error(
      { err, supabase: supabaseError ? { message: supabaseError.message, code: supabaseError.code, hint: supabaseError.hint, details: supabaseError.details } : undefined },
      "assembleProfile failed in agent/run",
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

  let agentResponse;
  try {
    const completion = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const raw = (completion.content[0] as { type: string; text: string }).text.trim();
    agentResponse = JSON.parse(raw);
  } catch (err: unknown) {
    req.log.error({ err }, "Anthropic API call or JSON parse failed in agent/run");
    res.status(502).json({ error: "Agent call failed", detail: err instanceof Error ? err.message : "Unknown error" });
    return;
  }

  res.json(agentResponse);
});

export default router;
