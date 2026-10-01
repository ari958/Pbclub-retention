import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL } from "./anthropicConfig";
import { retentionWeekday } from "./retentionDates";
import type { RetentionContext, RetentionPlaybook } from "./retentionTypes";

const VOICE_RULES = `You are a retention agent for a pickleball club. Write like a knowledgeable person at the front desk who knows the players personally: casual but not sloppy, warm but not gushing.

Follow every existing SMS voice rule:
- Never use exclamation points. Always use contractions. Never open with an affirmation. Start with the player's name or jump straight to the point.
- One ask per message. Keep it to 1–3 sentences. Never use a colon to introduce a list, em dashes as thought separators, or enumerated lists.
- Never use these words: self-selected, on-ramp, complement, tailored, curated, leverage, holistic, robust, seamless, journey, pathway, optimal, utilize, ensure, facilitate, elevate, enhance, unlock, actionable, align, framework, iterate, pivot, level up, deep dive, moving forward, circle back, touch base, value add, synergy, bandwidth.
- Never use these phrases: "Hope this finds you well", "Just checking in", "I wanted to reach out", "Don't hesitate to reach out", "Feel free to", "Excited to share", "We've noticed", "We see that you", "We observed", "Based on your history", "We wanted to make sure", "Looking forward to hearing from you".
- Only reference facts in the supplied context. Do not infer prior interactions, player type, motivation, or unstated timing. Never reveal surveillance or say what the system knows. Never validate or assign the player's level.
- Mention only the supplied next program and facts; do not invent familiarity, event details, urgency, or signup claims. Use a provided signup link naturally when appropriate.`;

export class RetentionTextValidationError extends Error {
  constructor(readonly validation_errors: string[]) {
    super(validation_errors.join("; "));
    this.name = "RetentionTextValidationError";
  }
}

const TIME_REFERENCE_RE = /\b(?:yesterday|today|tomorrow|tonight|now|soon|later|upcoming|future|this\s+(?:morning|afternoon|evening|day|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|next\s+(?:day|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|last\s+(?:night|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}(?:st|nd|rd|th)|\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\/\d{1,2}|\d+\s+days?\s+(?:from\s+now|later|away)|(?:in|within)\s+(?:a\s+few|\d+)\s+days?|morning|afternoon|evening)\b/i;

function validateUrls(text: string, context: RetentionContext): string[] {
  const errors: string[] = [];
  const knownUrls = new Set(
    [context.next_program?.signup_url, context.booked_event?.signup_url].filter(Boolean)
      .map((url) => String(url).replace(/[),.;!?]+$/g, "")),
  );
  const urls = text.match(/(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi) ?? [];
  for (const rawUrl of urls) {
    const url = rawUrl.replace(/[),.;!?]+$/g, "");
    if (!knownUrls.has(url)) errors.push("Message includes a link that is not present in the supplied context");
  }
  return errors;
}

function validateLtpText(text: string, context: RetentionContext): string[] {
  const errors: string[] = [];
  const opener = `Hi ${context.player_first_name.trim()}, it's PB Club.`;
  if (!text.startsWith(opener)) errors.push(`Message must open exactly with "${opener}"`);
  if (/[\u2013\u2014]/u.test(text)) errors.push("Message must not contain em or en dashes");
  if (!text.includes("LTPNEXT25")) errors.push("Message must include LTPNEXT25 exactly");

  const next = context.next_program;
  if (!next) {
    errors.push("A next program is required");
  } else {
    if (!text.toLocaleLowerCase().includes(next.name.toLocaleLowerCase())) errors.push("Message must include the next program name");
    const programDay = context.next_program_day ?? retentionWeekday(next.date);
    const escapedDatePhrase = context.date_phrase?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const datePhrasePattern = escapedDatePhrase
      ? new RegExp(`(?<![\\p{L}\\p{N}])${escapedDatePhrase}(?![\\p{L}\\p{N}])`, "iu")
      : null;
    let withoutAllowedTimes = datePhrasePattern ? text.replace(datePhrasePattern, " ") : text;
    withoutAllowedTimes = withoutAllowedTimes.replace(
      new RegExp(`\\b${programDay.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
      " ",
    );
    if (TIME_REFERENCE_RE.test(withoutAllowedTimes)) {
      errors.push("Message contains a time reference other than date_phrase and the next-program weekday");
    }
    if (!context.date_phrase || !text.includes(context.date_phrase)) errors.push("Message must include date_phrase verbatim");
    if (!text.toLocaleLowerCase().includes(programDay.toLocaleLowerCase())) errors.push("Message must include the next program's day");
    if (!text.includes(next.signup_url)) errors.push("Message must include the next program's signup link");
  }
  if ([...text].length > 320) errors.push("Message must be 320 Unicode characters or fewer");
  return errors;
}

export function validateRetentionTextBody(
  body: string,
  context: RetentionContext,
  playbook: RetentionPlaybook,
): string {
  const text = body.trim();
  if (!text) throw new RetentionTextValidationError(["Claude did not return a non-empty retention text body"]);
  const errors = validateUrls(text, context);
  if (playbook.key === "ltp_followup") {
    errors.push(...validateLtpText(text, context));
    if (!context.promo && /(?:\b\d+(?:\.\d+)?\s*%|\b\d+\s+percent\b|\b(?:discount|promo(?:tion)?|coupon|free|complimentary|save|savings|offer)\b)/i.test(text)) {
      errors.push("Message includes an unverified promotion");
    }
  } else if (!context.promo) {
    const promoLanguage = /(?:\b\d+(?:\.\d+)?\s*%|\b\d+\s+percent\b|\b(?:discount|promo(?:tion)?|coupon|free|complimentary|save|savings|offer)\b)/i;
    if (promoLanguage.test(text) || (playbook.promo_code && text.toLowerCase().includes(playbook.promo_code.toLowerCase()))) {
      errors.push("Claude included promotion language although this context has no valid promo");
    }
  }
  if (errors.length) throw new RetentionTextValidationError([...new Set(errors)]);
  return text;
}

export interface RetentionTextResult {
  body: string | null;
  validation_errors: string[];
  generated_preview: string | null;
}

export async function writeRetentionText(
  context: RetentionContext,
  playbook: RetentionPlaybook,
): Promise<RetentionTextResult> {
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
  const validationErrors: string[] = [];
  let generatedPreview: string | null = null;
  // Initial attempt plus at most two feedback retries.
  for (let attempt = 0; attempt < 3; attempt++) {
    const correction = validationErrors.length
      ? `\n\nYour previous answer failed validation: ${validationErrors.join("; ")}. Rewrite it to satisfy every requirement.`
      : "";
    const response = await client.messages.create({
      model: AGENT_MODEL,
      max_tokens: 8192,
      system: `${VOICE_RULES}
Write only the message body. Use only supplied context facts. Never invent facts.
${playbook.key === "ltp_followup"
    ? `For this Learn to Play follow-up, begin exactly with "Hi ${context.player_first_name}, it's PB Club.". Include LTPNEXT25 exactly, the complete next-program name, its weekday, and its signup_url. Include date_phrase verbatim as the only time reference other than the required next-program weekday. If already_booked, do not claim or describe the code as an offer or discount; include the required exact code without inventing benefits. Use no em/en dashes and stay within 320 Unicode characters.`
    : `If already_booked, thank the player and say "see you at [booked event name]" without mentioning an offer.`}
Respect the playbook guidance.`,
      messages: [{
        role: "user",
        content: `Context JSON:\n${JSON.stringify(context)}\n\nPlaybook guidance:\n${playbook.message_guidance ?? "No additional guidance."}${correction}`,
      }],
      tools: [{ name: "write_retention_text", description: "Return the SMS body only.", input_schema: schema }],
      tool_choice: { type: "tool", name: "write_retention_text" },
    });
    const block = response.content.find((item) => item.type === "tool_use");
    const body = block?.type === "tool_use" ? (block.input as { body?: unknown }).body : null;
    if (typeof body !== "string") throw new Error("Claude did not return a non-empty retention text body");
    generatedPreview = body.trim();
    try {
      return { body: validateRetentionTextBody(body, context, playbook), validation_errors: [], generated_preview: null };
    } catch (error) {
      if (!(error instanceof RetentionTextValidationError)) throw error;
      validationErrors.splice(0, validationErrors.length, ...error.validation_errors);
    }
  }
  return { body: null, validation_errors: validationErrors, generated_preview: generatedPreview };
}