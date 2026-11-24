import Anthropic from "@anthropic-ai/sdk";
import { validateWinbackText, WINBACK_PLAYBOOK_KEY } from "./winbackRules";
import { AGENT_MODEL } from "./anthropicConfig";
import { isSequenceFlowKey, textRulesForPlaybook } from "./retentionFlows";
import { retentionWeekday } from "./retentionDates";
import { LTP_TEXT_RULES, escapeRegExp } from "./retentionTypes";
import type { RetentionContext, RetentionPlaybook, RetentionTextRules } from "./retentionTypes";
import type { LtpTextSelection, RetentionSequenceStep } from "./retentionTypes";

const VOICE_RULES = `You are a retention agent for a pickleball club. Write like a knowledgeable person at the front desk who knows the players personally: casual but not sloppy, warm but not gushing.

Follow every existing SMS voice rule:
- Never use exclamation points. Always use contractions. Never open with an affirmation. Start with the player's name or jump straight to the point.
- One ask per message. Keep it to 1–3 sentences. Never use a colon to introduce a list, em dashes as thought separators, or enumerated lists.
- Never use these words: self-selected, on-ramp, complement, tailored, curated, leverage, holistic, robust, seamless, journey, pathway, optimal, utilize, ensure, facilitate, elevate, enhance, unlock, actionable, align, framework, iterate, pivot, level up, deep dive, moving forward, circle back, touch base, value add, synergy, bandwidth.
- Never use these phrases: "Hope this finds you well", "Just checking in", "I wanted to reach out", "Don't hesitate to reach out", "Feel free to", "Excited to share", "We've noticed", "We see that you", "We observed", "Based on your history", "We wanted to make sure", "Looking forward to hearing from you".
- Only reference facts in the supplied context. Do not infer prior interactions, player type, motivation, or unstated timing. Never reveal surveillance or say what the system knows. Never validate or assign the player's level.
- For with_program contexts, mention only the supplied next program and facts; do not invent familiarity, event details, urgency, or signup claims. Use its provided signup link naturally when appropriate.
- For no_program contexts, mention only the required attendance fact (the supplied attendance program) with its supplied date_phrase. Do not mention another program or event, date, day, time, classmate, or program suggestion. Generic wording in the verified offer (including the word "program") and a generic booking-page call to action are allowed.`;

export class RetentionTextValidationError extends Error {
  constructor(readonly validation_errors: string[]) {
    super(validation_errors.join("; "));
    this.name = "RetentionTextValidationError";
  }
}

const TIME_REFERENCE_RE = /\b(?:yesterday|today|tomorrow|tonight|now|soon|later|upcoming|future|this\s+(?:morning|afternoon|evening|day|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|next\s+(?:day|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|last\s+(?:night|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}(?:st|nd|rd|th)|\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\/\d{1,2}|\d+\s+days?\s+(?:from\s+now|later|away)|(?:in|within)\s+(?:a\s+few|\d+)\s+days?|morning|afternoon|evening)\b/i;
const NO_PROGRAM_EXTRA_TIME_RE = /\b(?:in|within|after)\s+(?:a\s+couple(?:\s+of)?|couple(?:\s+of)?|a\s+few|few|several|a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b|\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:spring|summer|fall|autumn|winter|noon|midnight)\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\bnext\s+time\b/i;
const NO_PROGRAM_SUGGESTION_RE = /\b(?:(?:(?:you should|you could|you might|you may|why not|consider|we recommend|i recommend|we suggest|i suggest)\s+(?:try|join|attend|take|play|sign up for|register for|book|check out|trying|joining|attending|taking|playing|signing up for|registering for|booking|checking out)\s+(?:(?:a|an|the|another|our|your|next|upcoming)\s+)?(?:beginner\s+|intermediate\s+|advanced\s+)?(?:programs?|events?|activities?))|(?:try|join|attend|take|play|sign up for|register for|check out)\s+(?:(?:a|an|the|another|our|your)\s+)?(?:beginner\s+|intermediate\s+|advanced\s+)?(?:class(?:es)?|programs?|events?|activities?|sessions?|lessons?|clinics?|open\s+play|drills?|guided\s+play))\b/i;
const NO_PROGRAM_CLASSMATE_RE = /\b(?:classmates?|class(?:es)?|peers?|friends?|fellow players|other (?:players|members|people|participants)|members|participants|people from your class|people you met|players you know|everyone|your group)\b/i;
/** The trigger program's full name or its initials ("LTP"), which a no-program text must not repeat. */
function triggerProgramReferencePattern(rules: RetentionTextRules): RegExp {
  const words = rules.triggerProgramLabel.trim().split(/\s+/);
  const initials = words.map((word) => word[0]).join("");
  const spaced = words.map(escapeRegExp).join("\\s+");
  return new RegExp(`\\b${escapeRegExp(initials)}\\b|\\b${spaced}\\b`, "i");
}
function exactTokenPattern(token: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(token)}(?![\\p{L}\\p{N}_])`, "u");
}
const NO_PROGRAM_WEEKDAY_ABBREVIATION_RE = /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;
const NO_PROGRAM_ACTIVITY_RE = /\b(?:beginner\s+|intermediate\s+|advanced\s+)?(?:class(?:es)?|lessons?|clinics?|open\s+play|drills?|guided\s+play|sessions?|round\s+robins?|leagues?|tournaments?|camps?|courses?|workshops?|practices?)\b/i;
const NO_PROGRAM_RETURN_SUGGESTION_RE = /\b(?:when(?:ever)?|before|after|until|again|recently|previously|see you|look(?:ing)? forward to|come back|coming back|return(?:ing)? to|back on (?:the )?court|next time|ready to get back)\b/i;
const PROMOTION_PERCENT_RE = /\b(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
const PROMOTION_MONEY_RE = /\$\s*(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?)\s+(?:dollars?|bucks?)\b/gi;
const PROMOTION_NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-]+(?:and|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)){0,3}";
const PROMOTION_WORD_PERCENT_RE = new RegExp(`\\b(${PROMOTION_NUMBER_WORD})\\s+percent\\b`, "gi");
const PROMOTION_WORD_MONEY_RE = new RegExp(`\\b(${PROMOTION_NUMBER_WORD})\\s+(?:dollars?|bucks?)\\b`, "gi");
const PROMOTION_BENEFIT_RE = /\b(?:free|freebies?|complimentary|bonus|gift(?:\s+cards?)?|rewards?|perks?|credits?|benefits?|unlimited|priority|exclusive|guaranteed|waived?|no[\s-]+charge|no[\s-]+cost|cashback|cash\s+back|rebates?)\b/gi;
const SEQUENCE_TIME_REFERENCE_RE = /\b(?:yesterday|today|tomorrow|tonight|now|soon|later|upcoming|this\s+(?:morning|afternoon|evening|day|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|next\s+(?:day|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|last\s+(?:night|week|weekend|month|year|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}(?:st|nd|rd|th)|\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\/\d{1,2}|\d+\s+days?\s+(?:from\s+now|later|away)|(?:in|within)\s+(?:a\s+few|\d+)\s+days?|morning|afternoon|evening)\b/i;

function renderLtpStoredTemplate(template: string, facts: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_whole, key: string) => facts[key] ?? "\u0000");
}

/** Strictly validates deterministic sequence copy; no model-generated LTP can use this path. */
export function validateLtpSequenceText(
  body: string,
  context: RetentionContext,
  selection: LtpTextSelection,
  rules: RetentionTextRules = LTP_TEXT_RULES,
): string[] {
  const errors: string[] = [];
  const text = body.trim();
  if (!selection || (selection.step !== 1 && selection.step !== 2)) return ["LTP sequence context needs a valid step selection"];
  if (!selection.slot_indices || !selection.slot_templates || !selection.opener || !selection.ltp_date) {
    return ["LTP sequence context is missing its persisted phrase-selection snapshot"];
  }
  const step = selection.step as RetentionSequenceStep;
  const expectedOpener = selection.opener;
  if (!text.startsWith(expectedOpener) || !text.includes(context.player_first_name.trim())) {
    errors.push("Message must start with the selected opener and include the player's first name");
  }
  if (/[–—]| - /u.test(text)) errors.push('Message cannot contain em/en dashes or spaced hyphens (" - ")');
  if ([...text].length > 320) errors.push("Message must be 320 Unicode characters or fewer");
  if (/[\r\n]/.test(text)) errors.push("LTP sequence message must be a single line");

  const noProgram = context.variant === "no_program";
  const requiredSlots = step === 1
    ? noProgram ? ["opener", "thanks", "offer_no_program"] : ["opener", "thanks", "next_step", "offer"]
    : noProgram ? ["opener", "nudge", "no_program_cta"] : ["opener", "nudge", "next_step"];
  if (Object.keys(selection.slot_templates).length !== requiredSlots.length
    || requiredSlots.some((key) => typeof selection.slot_templates[key] !== "string" || !Number.isInteger(selection.slot_indices[key]))) {
    errors.push("LTP phrase selection does not match the selected step and variant");
    return errors;
  }

  const safeCode = step === 1 ? rules.verifiedPromoCode : "";
  const knownProgram = context.next_program;
  const knownWhen = step === 2 && noProgram ? "" : selection.when ?? "";
  const facts = {
    first: context.player_first_name.trim(),
    ltp_date: selection.ltp_date,
    when: knownWhen,
    program: knownProgram?.name ?? "",
    promo: safeCode,
  };
  if (renderLtpStoredTemplate(selection.slot_templates.opener, facts) !== selection.opener) {
    errors.push("Selected opener does not match the saved phrase-slot snapshot");
  }
  const expectedParts = [expectedOpener];
  for (const key of requiredSlots.filter((item) => item !== "opener")) {
    expectedParts.push(renderLtpStoredTemplate(selection.slot_templates[key], facts));
  }
  const expectedLink = noProgram ? rules.bookingUrl : knownProgram?.signup_url ?? "";
  if (!expectedLink) errors.push("LTP sequence context is missing the selected program's booking link");
  const expectedBody = `${expectedParts.join(" ")} ${expectedLink}`;
  if (text !== expectedBody) errors.push("Message differs from its immutable code-filled phrase selection");
  if (!text.endsWith(expectedLink)) errors.push("The booking link must be the final text with no punctuation after it");

  const programLabelPattern = new RegExp(`\\b${escapeRegExp(rules.triggerProgramLabel)}\\b`);
  const offerPhrasePattern = new RegExp(`\\b${escapeRegExp(rules.verifiedOfferPhrase)}\\b`, "i");
  const promoCodePattern = new RegExp(`\\b${escapeRegExp(rules.verifiedPromoCode)}\\b`);
  if (step === 1) {
    if (!programLabelPattern.test(text)) errors.push(`Step 1 must name ${rules.triggerProgramLabel}`);
    if (!context.trigger?.date || !text.includes(selection.ltp_date)) errors.push(`Step 1 must contain the code-filled ${rules.triggerProgramLabel} attendance date`);
    if (!context.promo || context.promo.code !== rules.verifiedPromoCode) {
      errors.push(`Step 1 requires the live-verified ${rules.verifiedPromoCode} coupon`);
    } else {
      const benefit = context.promo.offer_text;
      const containsVerifiedBenefit = !!benefit && (
        text.toLocaleLowerCase().includes(benefit.toLocaleLowerCase())
        || offerPhrasePattern.test(text)
      );
      if (!containsVerifiedBenefit) errors.push(`Step 1 requires the verified ${rules.verifiedOfferPhrase} ${rules.verifiedPromoCode} benefit`);
      const claims = [...text.matchAll(PROMOTION_PERCENT_RE)];
      if (rules.verifiedPercent === null ? claims.length !== 0
        : claims.length !== 1 || Number(claims[0]?.[1]) !== rules.verifiedPercent) {
        errors.push(`Step 1 must contain exactly the verified ${rules.verifiedOfferPhrase} offer and no other percentage`);
      }
      PROMOTION_BENEFIT_RE.lastIndex = 0;
      if (PROMOTION_BENEFIT_RE.test(text)) errors.push("Step 1 cannot claim an unverified bonus or benefit");
      PROMOTION_BENEFIT_RE.lastIndex = 0;
    }
    if (noProgram) {
      if (context.next_program) errors.push("No-program step 1 cannot name a program or event");
      if (!context.booking_url || context.booking_url !== rules.bookingUrl) {
        errors.push("No-program step 1 must use the approved generic booking link");
      }
    } else {
      if (!knownProgram || !selection.when) errors.push("With-program step 1 needs its live-verified session and time");
      if (context.promo?.code === rules.verifiedPromoCode && text.includes(rules.verifiedPromoCode) === false) {
        errors.push(`Step 1 must contain the exact ${rules.verifiedPromoCode} code`);
      }
    }
  } else {
    if (context.promo || promoCodePattern.test(text)
      || /\b\d+(?:\.\d+)?\s*%|\b\d+\s+percent\b|\b(?:discount|coupon|promo(?:tion)?)\b/i.test(text)) {
      errors.push("Step 2 cannot contain a promo code, coupon, percentage, discount, or offer");
    }
    if (noProgram) {
      if (context.next_program) errors.push("No-program step 2 cannot name a next program or event");
      if (!text.endsWith(rules.bookingUrl)) errors.push("No-program step 2 must end with the club booking page");
    } else if (!knownProgram || !selection.when) {
      errors.push("With-program step 2 needs a fresh live-verified session and time");
    }
  }

  const suppliedFacts = [
    selection.opener,
    selection.ltp_date,
    selection.when ?? "",
    knownProgram?.name ?? "",
    expectedLink,
    ...(step === 1 ? [rules.triggerProgramLabel, rules.verifiedPromoCode, context.promo?.offer_text ?? ""] : []),
    ...(step === 2 && noProgram ? [selection.slot_templates.no_program_cta ?? ""] : []),
  ].filter(Boolean).sort((a, b) => b.length - a.length);
  let unexplained = text;
  for (const fact of suppliedFacts) unexplained = unexplained.replace(fact, " ");
  if (SEQUENCE_TIME_REFERENCE_RE.test(unexplained)) {
    errors.push(`Message may only mention the code-filled ${rules.triggerProgramLabel} date and selected session time`);
  }
  const urls = text.match(/(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi) ?? [];
  if (urls.length !== 1 || !urls[0]?.replace(/[),.;!?]+$/g, "").includes(expectedLink.replace(/[),.;!?]+$/g, ""))) {
    errors.push("Message must contain only its selected final booking URL");
  }
  if (noProgram && step === 1) {
    const attendanceClause = `${rules.triggerProgramLabel} on ${selection.ltp_date}`;
    const afterAttendance = text.replace(selection.opener, " ").replace(attendanceClause, " ");
    const withoutVerifiedOffer = afterAttendance.replace(
      renderLtpStoredTemplate(selection.slot_templates.offer_no_program, facts),
      " ",
    );
    if (/\b(?:class(?:es)?|lesson(?:s)?|clinics?|drills?|guided play|programs?|events?|tournaments?|leagues?|camps?|sessions?|open play|practice)\b/i.test(withoutVerifiedOffer)) {
      errors.push("No-program step 1 must not mention another program or activity");
    }
  }
  return [...new Set(errors)];
}

function retentionVariant(context: RetentionContext): "with_program" | "no_program" | null {
  if (context.variant) return context.variant;
  return context.next_program ? "with_program" : null;
}

function normalizeProgramName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase()
    .replace(/[\u2010-\u2015_-]/g, " ")
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsProgramName(text: string, name: string): boolean {
  const normalizedText = ` ${normalizeProgramName(text)} `;
  const normalizedName = normalizeProgramName(name);
  return !!normalizedName && normalizedText.includes(` ${normalizedName} `);
}

function textAfterRequiredOpener(text: string, context: RetentionContext): string {
  const opener = `Hi ${context.player_first_name.trim()}, it's PB Club.`;
  return text.startsWith(opener) ? text.slice(opener.length) : text;
}

function noProgramAttendancePattern(datePhrase: string, rules: RetentionTextRules): RegExp {
  return new RegExp(
    `\\b(?:[Tt]hanks|[Tt]hank you) for (?:coming to|attending) ${escapeRegExp(rules.triggerProgramLabel)} ${escapeRegExp(datePhrase)}(?![\\p{L}\\p{N}_])`,
    "u",
  );
}

function unsupportedPromotionClaims(text: string, verifiedOffer: string): boolean {
  const exceedsVerifiedClaimCount = (
    claims: RegExpMatchArray[],
    verifiedClaims: RegExpMatchArray[],
    normalize: (match: RegExpMatchArray) => string,
  ): boolean => {
    const remaining = new Map<string, number>();
    for (const match of verifiedClaims) {
      const key = normalize(match);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const match of claims) {
      const key = normalize(match);
      const count = remaining.get(key) ?? 0;
      if (!count) return true;
      remaining.set(key, count - 1);
    }
    return false;
  };
  if (exceedsVerifiedClaimCount(
    [...text.matchAll(PROMOTION_PERCENT_RE)],
    [...verifiedOffer.matchAll(PROMOTION_PERCENT_RE)],
    (match) => String(Number(match[1])),
  )) return true;

  const wordNumberToValue = (number: string): number => {
    const units: Record<string, number> = {
      zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
      ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
      seventeen: 17, eighteen: 18, nineteen: 19,
    };
    const tens: Record<string, number> = {
      twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    };
    let total = 0;
    let current = 0;
    for (const part of number.toLocaleLowerCase().replace(/-/g, " ").split(/\s+/)) {
      if (part === "and") continue;
      if (part in units) current += units[part];
      else if (part in tens) current += tens[part];
      else if (part === "hundred") current = (current || 1) * 100;
      else if (part === "thousand") {
        total += (current || 1) * 1000;
        current = 0;
      }
    }
    return total + current;
  };
  if (exceedsVerifiedClaimCount(
    [...text.matchAll(PROMOTION_WORD_PERCENT_RE)],
    [...verifiedOffer.matchAll(PROMOTION_WORD_PERCENT_RE)],
    (match) => String(wordNumberToValue(match[1])),
  )) return true;

  const normalizeMoney = (value: string) => Number(value.replace(/,/g, ""));
  if (exceedsVerifiedClaimCount(
    [...text.matchAll(PROMOTION_MONEY_RE)],
    [...verifiedOffer.matchAll(PROMOTION_MONEY_RE)],
    (match) => String(normalizeMoney(match[1] ?? match[2])),
  )) return true;
  if (exceedsVerifiedClaimCount(
    [...text.matchAll(PROMOTION_WORD_MONEY_RE)],
    [...verifiedOffer.matchAll(PROMOTION_WORD_MONEY_RE)],
    (match) => String(wordNumberToValue(match[1])),
  )) return true;

  return exceedsVerifiedClaimCount(
    [...text.matchAll(PROMOTION_BENEFIT_RE)],
    [...verifiedOffer.matchAll(PROMOTION_BENEFIT_RE)],
    (match) => match[0].toLocaleLowerCase().replace(/[\s-]+/g, " "),
  );
}

function hasUnresolvedLiveLookupError(
  diagnostics: unknown,
  inLookupScope = false,
  inTextGenerationScope = false,
): boolean {
  if (!diagnostics || typeof diagnostics !== "object") return false;
  if (Array.isArray(diagnostics)) {
    return diagnostics.some((entry) =>
      hasUnresolvedLiveLookupError(entry, inLookupScope, inTextGenerationScope),
    );
  }
  const record = diagnostics as Record<string, unknown>;
  if (!inTextGenerationScope && inLookupScope && record.status === "error") return true;
  return Object.entries(record).some(([key, value]) => {
    const textGenerationScope = inTextGenerationScope || /text[\s_-]*generation/i.test(key);
    const lookupScope = !textGenerationScope && (inLookupScope || /lookup/i.test(key));
    return hasUnresolvedLiveLookupError(value, lookupScope, textGenerationScope);
  });
}

function validateUrls(text: string, context: RetentionContext, rules: RetentionTextRules): string[] {
  const errors: string[] = [];
  const variant = retentionVariant(context);
  const allowedUrls = variant === "no_program"
    ? [rules.bookingUrl]
    : [context.next_program?.signup_url, context.booked_event?.signup_url];
  const knownUrls = new Set(
    allowedUrls.filter(Boolean)
      .map((url) => String(url).replace(/[),.;!?]+$/g, "")),
  );
  const urls = text.match(/(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi) ?? [];
  for (const rawUrl of urls) {
    const url = rawUrl.replace(/[),.;!?]+$/g, "");
    if (!knownUrls.has(url)) errors.push("Message includes a link that is not present in the supplied context");
  }
  return errors;
}

function validateCommonLtpText(text: string, context: RetentionContext, rules: RetentionTextRules): string[] {
  const errors: string[] = [];
  const opener = `Hi ${context.player_first_name.trim()}, it's PB Club.`;
  if (!text.startsWith(opener)) errors.push(`Message must open exactly with "${opener}"`);
  if (/[\u2013\u2014]/u.test(text)) errors.push("Message must not contain em or en dashes");
  if (!exactTokenPattern(rules.verifiedPromoCode).test(text)) {
    errors.push(`Message must include ${rules.verifiedPromoCode} as an exact token`);
  }
  if (/ - /u.test(text)) errors.push('Message must not contain a spaced hyphen (" - ")');
  if ([...text].length > 320) errors.push("Message must be 320 Unicode characters or fewer");
  return errors;
}

function validateWithProgramLtpText(text: string, context: RetentionContext): string[] {
  const errors: string[] = [];
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
  return errors;
}

function validateNoProgramLtpText(text: string, context: RetentionContext, rules: RetentionTextRules): string[] {
  const errors: string[] = [];
  let scannedText = textAfterRequiredOpener(text, context);
  if (!context.date_phrase) {
    errors.push("No-program text requires the supplied date_phrase");
  } else {
    const attendancePattern = noProgramAttendancePattern(context.date_phrase, rules);
    if (!attendancePattern.test(scannedText)) {
      errors.push(`Message must thank the player for coming to or attending ${rules.triggerProgramLabel} with date_phrase verbatim`);
    } else {
      scannedText = scannedText.replace(attendancePattern, " ");
    }
  }
  if (context.next_program) errors.push("A no_program context must not include a next program");
  if (context.booking_url !== rules.bookingUrl) {
    errors.push("No-program context must provide the exact approved booking-page URL");
  }
  if (
    !context.promo
    || context.promo.code !== rules.verifiedPromoCode
    || context.promo.offer_text !== rules.verifiedOfferText
  ) {
    errors.push(`No-program text requires the canonical offer backed by verified ${rules.verifiedPromoCode} benefits`);
  } else {
    const normalizedText = text.replace(/\s+/g, " ").toLocaleLowerCase();
    const normalizedOffer = context.promo.offer_text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (!normalizedText.includes(normalizedOffer)) errors.push("Message must include the verified offer text");
  }
  if (!text.includes(rules.bookingUrl)) {
    errors.push("Message must include the exact approved booking-page URL");
  }
  if (/\bthank(?:s| you)?\b/i.test(scannedText)) {
    errors.push("No-program message must not include generic or additional thanking");
  }
  if (
    TIME_REFERENCE_RE.test(scannedText)
    || NO_PROGRAM_EXTRA_TIME_RE.test(scannedText)
    || NO_PROGRAM_RETURN_SUGGESTION_RE.test(scannedText)
  ) {
    errors.push("No-program message must not include date, day, time, or return-timing references");
  }
  if (NO_PROGRAM_WEEKDAY_ABBREVIATION_RE.test(scannedText)) {
    errors.push("No-program message must not include weekday abbreviations");
  }
  if (NO_PROGRAM_SUGGESTION_RE.test(scannedText)) errors.push("No-program message must not suggest an activity or program");
  if (NO_PROGRAM_CLASSMATE_RE.test(scannedText)) errors.push("No-program message must not reference classmates or other players");
  if (triggerProgramReferencePattern(rules).test(scannedText)) errors.push(`No-program message must not name the ${rules.triggerProgramLabel} program`);
  if (NO_PROGRAM_ACTIVITY_RE.test(scannedText)) {
    errors.push("No-program message must not mention a specific program or activity type");
  }
  if (!Array.isArray(context.forbidden_program_names)) {
    errors.push("No-program context must provide forbidden program names");
  }
  const forbiddenNames = [
    context.trigger?.name,
    ...(context.forbidden_program_names ?? []),
  ].filter((name): name is string => typeof name === "string" && !!name.trim());
  if (forbiddenNames.some((name) => containsProgramName(scannedText, name))) {
    errors.push("No-program message must not mention a specific program or event name");
  }
  if (context.promo && unsupportedPromotionClaims(text, context.promo.offer_text)) {
    errors.push("No-program message includes promotion claims beyond the verified offer");
  }
  return errors;
}

export function validateRetentionTextBody(
  body: string,
  context: RetentionContext,
  playbook: RetentionPlaybook,
): string {
  const text = body.trim();
  if (!text) throw new RetentionTextValidationError(["Claude did not return a non-empty retention text body"]);
  if (context.reason === "context_lookup_failed" || hasUnresolvedLiveLookupError(context.diagnostics)) {
    throw new RetentionTextValidationError(["Live retention context lookups are unresolved"]);
  }
  if (playbook.key === WINBACK_PLAYBOOK_KEY) {
    const winbackErrors = validateWinbackText(text, context);
    if (winbackErrors.length) throw new RetentionTextValidationError(winbackErrors);
    return text;
  }
  const rules = textRulesForPlaybook(playbook.key);
  const errors = validateUrls(text, context, rules);
  if (isSequenceFlowKey(playbook.key)) {
    if (context.ltp_text) {
      const sequenceErrors = validateLtpSequenceText(text, context, context.ltp_text, rules);
      if (sequenceErrors.length) throw new RetentionTextValidationError(sequenceErrors);
      return text;
    }
    const variant = retentionVariant(context);
    errors.push(...validateCommonLtpText(text, context, rules));
    if (variant === "with_program") errors.push(...validateWithProgramLtpText(text, context));
    else if (variant === "no_program") errors.push(...validateNoProgramLtpText(text, context, rules));
    else errors.push("LTP context must specify a variant or include a legacy next program");
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

function projectRetentionTextFacts(context: RetentionContext, rules: RetentionTextRules): Record<string, unknown> {
  if (retentionVariant(context) === "no_program") {
    const verifiedPromo = context.promo?.code === rules.verifiedPromoCode
      && context.promo.offer_text === rules.verifiedOfferText
      ? { code: context.promo.code, offer_text: context.promo.offer_text }
      : null;
    return {
      player_first_name: context.player_first_name,
      attendance: { program: rules.triggerProgramLabel, attended: true },
      date_phrase: context.date_phrase,
      promo: verifiedPromo,
      booking_url: context.booking_url,
    };
  }
  const nextProgram = context.next_program;
  return {
    player_first_name: context.player_first_name,
    trigger: { name: context.trigger.name, date: context.trigger.date },
    next_program: nextProgram ? {
      name: nextProgram.name,
      signup_url: nextProgram.signup_url,
    } : null,
    next_program_day: context.next_program_day
      ?? (nextProgram ? retentionWeekday(nextProgram.date) : undefined),
    date_phrase: context.date_phrase,
    already_booked: context.already_booked,
    ...(context.already_booked && context.booked_event
      ? { booked_event: { name: context.booked_event.name } }
      : {}),
    promo: context.promo ? { code: context.promo.code, offer_text: context.promo.offer_text } : null,
  };
}

export async function writeRetentionText(
  context: RetentionContext,
  playbook: RetentionPlaybook,
): Promise<RetentionTextResult> {
  const rules = textRulesForPlaybook(playbook.key);
  if (isSequenceFlowKey(playbook.key)) {
    throw new Error(`${rules.triggerProgramLabel} texts must use the code-only sequence phrase builder, not LLM generation`);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Claude credentials are not configured (ANTHROPIC_API_KEY)");
  const client = new Anthropic({ apiKey });
  const schema = {
    type: "object" as const,
    properties: { body: { type: "string" } },
    required: ["body"],
    additionalProperties: false,
  };
  const validationErrors: string[] = [];
  let generatedPreview: string | null = null;
  const variant = retentionVariant(context);
  const promptContext = projectRetentionTextFacts(context, rules);
  const guidance = variant === "no_program"
    ? ""
    : `\n\nPlaybook guidance:\n${playbook.message_guidance ?? "No additional guidance."}`;
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
${isSequenceFlowKey(playbook.key)
    ? retentionVariant(context) === "no_program"
        ? `For this no-program message, begin exactly with "Hi ${context.player_first_name}, it's PB Club.". Thank the player for coming to or attending ${rules.triggerProgramLabel}, using the exact words "${rules.triggerProgramLabel}" and date_phrase verbatim. This is the only attendance or program reference allowed; do not mention any other program or event, date, day, time, classmate, or other-player reference. Do not add generic thanks for joining or being part of the club. Include the exact verified promo code and promo.offer_text, and this exact URL: ${rules.bookingUrl}. Generic wording in promo.offer_text, including the word "program", is allowed. A generic booking-page call to action such as "Book here" is allowed. Do not suggest attending/joining/trying a specific activity or program, or name a specific activity type. Do not use conditional timing such as "when you're ready", "whenever", "before", "after", or "again". Do not add any other link. Use no em/en dashes or spaced hyphens (" - ") and stay within 320 Unicode characters.`
      : `For this ${rules.triggerProgramLabel} follow-up, begin exactly with "Hi ${context.player_first_name}, it's PB Club.". Include ${rules.verifiedPromoCode} exactly, the complete next-program name, its weekday, and its signup_url. Include date_phrase verbatim as the only time reference other than the required next-program weekday. If already_booked, do not claim or describe the code as an offer or discount; include the required exact code without inventing benefits. Use no em/en dashes and stay within 320 Unicode characters.`
    : `If already_booked, thank the player and say "see you at [booked event name]" without mentioning an offer.`}
      ${variant === "no_program" ? "No generic playbook guidance applies to this variant." : "Respect the playbook guidance."}`,
      messages: [{
        role: "user",
        content: `Context JSON:\n${JSON.stringify(promptContext)}${guidance}${correction}`,
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