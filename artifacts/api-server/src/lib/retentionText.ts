import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL } from "./anthropicConfig";
import type { RetentionContext, RetentionPlaybook } from "./retentionTypes";

const VOICE_RULES = `You are a retention agent for a pickleball club. Write like a knowledgeable person at the front desk who knows the players personally: casual but not sloppy, warm but not gushing.

Follow every existing SMS voice rule:
- Never use exclamation points. Always use contractions. Never open with an affirmation. Start with the player's name or jump straight to the point.
- One ask per message. Keep it to 1–3 sentences. Never use a colon to introduce a list, em dashes as thought separators, or enumerated lists.
- Never use these words: self-selected, on-ramp, complement, tailored, curated, leverage, holistic, robust, seamless, journey, pathway, optimal, utilize, ensure, facilitate, elevate, enhance, unlock, actionable, align, framework, iterate, pivot, level up, deep dive, moving forward, circle back, touch base, value add, synergy, bandwidth.
- Never use these phrases: "Hope this finds you well", "Just checking in", "I wanted to reach out", "Don't hesitate to reach out", "Feel free to", "Excited to share", "We've noticed", "We see that you", "We observed", "Based on your history", "We wanted to make sure", "Looking forward to hearing from you".
- Only reference facts in the supplied context. Do not infer prior interactions, player type, motivation, or unstated timing. Never reveal surveillance or say what the system knows. Never validate or assign the player's level.
- Mention only the supplied next program and facts; do not invent familiarity, event details, urgency, or signup claims. Use a provided signup link naturally when appropriate.`;

export function validateRetentionTextBody(
  body: string,
  context: RetentionContext,
  playbook: RetentionPlaybook,
): string {
  const text = body.trim();
  if (!text) throw new Error("Claude did not return a non-empty retention text body");
  if (!context.promo) {
    const promoLanguage = /(?:\b\d+(?:\.\d+)?\s*%|\b\d+\s+percent\b|\b(?:discount|promo(?:tion)?|coupon|free|complimentary|save|savings|offer)\b)/i;
    if (promoLanguage.test(text) || (playbook.promo_code && text.toLowerCase().includes(playbook.promo_code.toLowerCase()))) {
      throw new Error("Claude included promotion language although this context has no valid promo");
    }
  }
  const knownUrls = new Set(
    [context.next_program?.signup_url, context.booked_event?.signup_url].filter(Boolean)
      .map((url) => String(url).replace(/[),.;!?]+$/g, "")),
  );
  const urls = text.match(/(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi) ?? [];
  for (const rawUrl of urls) {
    const url = rawUrl.replace(/[),.;!?]+$/g, "");
    if (!knownUrls.has(url)) throw new Error("Claude included a link that is not present in the supplied context");
  }
  return text;
}

export async function writeRetentionText(
  context: RetentionContext,
  playbook: RetentionPlaybook,
): Promise<string> {
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY
    ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Claude credentials are not configured (AI_INTEGRATIONS_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY)");
  const client = new Anthropic({
    apiKey,
    ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
      ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL }
      : {}),
  });
  const schema = {
    type: "object" as const,
    properties: { body: { type: "string" } },
    required: ["body"],
    additionalProperties: false,
  };
  const response = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 8192,
    system: `${VOICE_RULES}\nYou may write only the message body. Use only facts explicitly present in the supplied context. Never invent facts or include facts from outside it. If already_booked is true, send a thank-you and say "see you at [booked event name]"; do not mention a promotion or offer. If there is a promo object, offer only that exact offer and code. Mention a suggested program only when next_program is non-null. Respect the playbook guidance.`,
    messages: [{
      role: "user",
      content: `Context JSON:\n${JSON.stringify(context)}\n\nPlaybook guidance:\n${playbook.message_guidance ?? "No additional guidance."}`,
    }],
    tools: [{ name: "write_retention_text", description: "Return the SMS body only.", input_schema: schema }],
    tool_choice: { type: "tool", name: "write_retention_text" },
  });
  const block = response.content.find((item) => item.type === "tool_use");
  const body = block?.type === "tool_use" ? (block.input as { body?: unknown }).body : null;
  if (typeof body !== "string") throw new Error("Claude did not return a non-empty retention text body");
  return validateRetentionTextBody(body, context, playbook);
}