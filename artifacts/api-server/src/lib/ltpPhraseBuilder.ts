import { z } from "zod";
import {
  LTP_TEXT_RULES,
  escapeRegExp,
  type LtpSequenceConfig,
  type LtpTextSelection,
  type RetentionContext,
  type RetentionSequenceStep,
  type RetentionTextRules,
} from "./retentionTypes";

export const DEFAULT_LTP_SEQUENCE_CONFIG: LtpSequenceConfig = {
  step2_gap_days: 7,
  step1: {
    opener: ["Hi {first}, it's PB Club."],
    thanks: [
      "Thanks for coming to Learn to Play on {ltp_date}.",
      "Great having you at Learn to Play on {ltp_date}.",
      "Glad you made it to Learn to Play on {ltp_date}.",
      "Hope you enjoyed Learn to Play on {ltp_date}.",
    ],
    next_step: [
      "A good next step is {program} on {when}.",
      "If you're ready for more, {program} is on {when}.",
      "{program} on {when} is a natural next step.",
      "Next up for a lot of new players: {program} on {when}.",
    ],
    offer: [
      "Use code {promo} for 25% off:",
      "Here's 25% off with code {promo}:",
      "Code {promo} takes 25% off:",
    ],
    offer_no_program: [
      "Use code {promo} for 25% off your next program:",
      "Here's 25% off your next program with code {promo}:",
    ],
  },
  step2: {
    opener: ["Hi {first}, it's PB Club.", "Hey {first}, PB Club here."],
    nudge: [
      "Hope you're ready to get back out there.",
      "We'd love to see you back on the court.",
      "Thinking about your next session?",
    ],
    next_step: [
      "{program} on {when} still has spots.",
      "{program} on {when} is a great fit after Learn to Play.",
      "There's room in {program} on {when}.",
    ],
    no_program_cta: ["Here's what's coming up:"],
  },
};

const SlotArraySchema = z.array(z.string().trim().min(1).max(240)).min(1).max(32);
const Step1ConfigSchema = z.object({
  opener: SlotArraySchema,
  thanks: SlotArraySchema,
  next_step: SlotArraySchema,
  offer: SlotArraySchema,
  offer_no_program: SlotArraySchema,
}).strict();
const Step2ConfigSchema = z.object({
  opener: SlotArraySchema,
  nudge: SlotArraySchema,
  next_step: SlotArraySchema,
  no_program_cta: SlotArraySchema,
}).strict();

export const LtpSequenceConfigSchema = z.object({
  step2_gap_days: z.number().int().min(7).max(30),
  step1: Step1ConfigSchema,
  step2: Step2ConfigSchema,
}).strict();

export function validateLtpSequenceConfig(value: unknown, rules: RetentionTextRules = LTP_TEXT_RULES): LtpSequenceConfig {
  const parsed = LtpSequenceConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${rules.triggerProgramLabel} phrase configuration: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const programLabel = new RegExp(`\\b${escapeRegExp(rules.triggerProgramLabel)}\\b`);
  const offerPhrase = new RegExp(`\\b${escapeRegExp(rules.verifiedOfferPhrase)}\\b`);
  const promoCode = new RegExp(`\\b${escapeRegExp(rules.verifiedPromoCode)}\\b`);
  const configuration = parsed.data;
  const allowedPlaceholders = new Set(["first", "ltp_date", "when", "program", "promo"]);
  for (const [step, groups] of Object.entries(configuration) as Array<[string, unknown]>) {
    if (step === "step2_gap_days") continue;
    for (const [group, slots] of Object.entries(groups as Record<string, string[]>)) {
      for (const slot of slots) {
        for (const [, placeholder] of slot.matchAll(/\{([^}]+)\}/g)) {
          if (!allowedPlaceholders.has(placeholder)) throw new Error(`Unsupported phrase placeholder {${placeholder}} in ${step}.${group}`);
        }
        if (/[{}]/.test(slot.replace(/\{[^}]+\}/g, ""))) throw new Error(`Malformed phrase placeholder in ${step}.${group}`);
        if (/[–—]| - /.test(slot)) throw new Error(`Phrase slots cannot contain em dashes, en dashes, or spaced hyphens (${step}.${group})`);
      }
    }
  }
  if (configuration.step1.opener.some((slot) => !/^(?:Hi \{first\}, it's PB Club\.|Hey \{first\}, PB Club here\.)$/.test(slot))) {
    throw new Error("Step 1 openers must identify the player and PB Club");
  }
  if (configuration.step1.thanks.some((slot) =>
    !programLabel.test(slot)
    || !slot.includes("{ltp_date}")
    || !/\b(?:thanks|thank|glad|hope you enjoyed|great having)\b/i.test(slot))) {
    throw new Error(`Step 1 thanks slots must thank the player, name ${rules.triggerProgramLabel}, and include {ltp_date}`);
  }
  if (configuration.step1.next_step.some((slot) => !slot.includes("{program}") || !slot.includes("{when}"))) {
    throw new Error("Step 1 next_step slots must include {program} and {when}");
  }
  if (configuration.step1.offer.some((slot) => !slot.includes("{promo}") || !offerPhrase.test(slot))) {
    throw new Error(`Step 1 offer slots must include the verified {promo} ${rules.verifiedOfferPhrase} benefit`);
  }
  if (configuration.step1.offer_no_program.some((slot) => !slot.includes("{promo}") || !offerPhrase.test(slot))) {
    throw new Error(`Step 1 no-program offer slots must include the verified {promo} ${rules.verifiedOfferPhrase} benefit`);
  }
  if (configuration.step2.opener.some((slot) => !slot.includes("{first}"))) {
    throw new Error("Step 2 opener slots must include {first}");
  }
  if (configuration.step2.opener.some((slot) => /\{(?!first\})/.test(slot.replace(/\{first\}/g, "")))) {
    throw new Error("Step 2 opener slots may only interpolate {first}");
  }
  if ([...configuration.step2.nudge, ...configuration.step2.no_program_cta]
    .some((slot) => /\{[^}]*\}/.test(slot))) {
    throw new Error("Step 2 nudge and no-program CTA slots cannot invent code-filled facts");
  }
  if (configuration.step2.next_step.some((slot) => !slot.includes("{program}") || !slot.includes("{when}"))) {
    throw new Error("Step 2 next_step slots must include {program} and {when}");
  }
  if (configuration.step2.next_step.some((slot) => /\{(?!program\}|when\})/.test(slot.replace(/\{program\}|\{when\}/g, "")))) {
    throw new Error("Step 2 next-step slots may only interpolate {program} and {when}");
  }
  if (configuration.step1.next_step.some((slot) => /\{(?!program\}|when\})/.test(slot.replace(/\{program\}|\{when\}/g, "")))) {
    throw new Error("Step 1 next-step slots may only interpolate {program} and {when}");
  }
  if (configuration.step1.offer.some((slot) => /\{(?!promo\})/.test(slot.replace(/\{promo\}/g, "")))) {
    throw new Error("Step 1 offer slots may only interpolate {promo}");
  }
  for (const slot of [...configuration.step2.nudge, ...configuration.step2.no_program_cta]) {
    if (/\{(?:when|ltp_date|program|promo)\}/.test(slot)) {
      throw new Error("Step 2 nudge/no-program slots cannot invent dates, events, programs, or a promotion");
    }
    if (promoCode.test(slot) || /\b\d+(?:\.\d+)?\s*%|\b(?:percent|discount)\b/i.test(slot)) {
      throw new Error("Step 2 slots cannot contain a coupon or promotion");
    }
  }
  for (const [group, slots] of Object.entries(configuration.step2)) {
    for (const slot of slots) {
      if (promoCode.test(slot) || /\b\d+(?:\.\d+)?\s*%|\b\d+\s+percent\b|\b(?:percent|discount|coupon|promo(?:tion)?|free|complimentary|offer)\b/i.test(slot)) {
        throw new Error(`Step 2 ${group} slots cannot mention a coupon, promotion, or benefit`);
      }
    }
  }
  for (const slot of configuration.step1.thanks) {
    if (/\{(?!ltp_date\})/.test(slot.replace(/\{ltp_date\}/g, ""))) {
      throw new Error("Step 1 thanks slots may only interpolate {ltp_date}");
    }
  }
  for (const slot of configuration.step1.offer_no_program) {
    if (/\{(?!promo\})/.test(slot.replace(/\{promo\}/g, ""))) {
      throw new Error("Step 1 no-program offer slots may only interpolate {promo}");
    }
  }
  return configuration;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function formatLtpDate(date: string): string {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) throw new Error("LTP date must be an ET calendar date");
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  if (Number.isNaN(instant.getTime())
    || instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) {
    throw new Error("LTP date must be an ET calendar date");
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];
  return `${months[month - 1]} ${day}`;
}

export function formatLtpWhen(startTime: string): string {
  const instant = new Date(startTime);
  if (!Number.isFinite(instant.getTime())) throw new Error("LTP session needs a valid live ET start time");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.weekday}, ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute}${String(parts.dayPeriod).toLowerCase()}`;
}

function choose(slots: string[], candidateId: string, step: RetentionSequenceStep, seedNonce: number, group: string) {
  const selectedIndex = stableHash(`${candidateId}:${step}:${seedNonce}:${group}`) % slots.length;
  return { selectedIndex, phrase: slots[selectedIndex] };
}

function fill(template: string, facts: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_placeholder, name: string) => {
    const fact = facts[name];
    if (fact === undefined) throw new Error(`Code-filled LTP fact {${name}} is unavailable`);
    return fact;
  });
}

export interface BuildLtpPhraseInput {
  candidateId: string;
  seedNonce: number;
  step: RetentionSequenceStep;
  context: RetentionContext;
  promoCode?: string | null;
  config?: unknown;
  preferredSlotIndices?: Record<string, number>;
  /** Flow rules; Learn to Play when omitted. */
  rules?: RetentionTextRules;
}

export interface BuiltLtpStep {
  body: string;
  context: RetentionContext;
  selected_slot_templates: Record<string, string>;
}

export function buildLtpStepText(input: BuildLtpPhraseInput): BuiltLtpStep {
  const { candidateId, step, context } = input;
  const rules = input.rules ?? LTP_TEXT_RULES;
  const config = validateLtpSequenceConfig(input.config ?? DEFAULT_LTP_SEQUENCE_CONFIG, rules);
  if (!/^[\w-]{1,128}$/.test(candidateId)) throw new Error("Candidate ID is required to seed deterministic phrase slots");
  if (!Number.isSafeInteger(input.seedNonce) || input.seedNonce < 0) throw new Error("Phrase seed nonce must be a non-negative safe integer");
  if (!context.trigger?.date || !context.player_first_name.trim()) throw new Error("LTP step builder requires a trigger date and player first name");
  const allowedSteps = step === 1 ? config.step1 : config.step2;
  const selection: Record<string, number> = {};
  const templates: Record<string, string> = {};
  const chooseGroup = (name: string, slots: string[]) => {
    const preferredIndex = input.preferredSlotIndices?.[name];
    const selectedIndex = Number.isInteger(preferredIndex) && preferredIndex! >= 0 && preferredIndex! < slots.length
      ? preferredIndex!
      : choose(slots, candidateId, step, input.seedNonce, name).selectedIndex;
    const picked = { selectedIndex, phrase: slots[selectedIndex] };
    selection[name] = picked.selectedIndex;
    templates[name] = picked.phrase;
    return picked.phrase;
  };
  const firstName = context.player_first_name.trim();
  const ltpDate = formatLtpDate(context.trigger.date);
  const program = context.next_program;
  const when = program ? formatLtpWhen(program.start_time) : null;
  const expectsProgram = !!program && !!when && context.variant !== "no_program";
  if (step === 1 && (context.promo?.code !== rules.verifiedPromoCode
    || !context.promo.offer_text?.toLocaleLowerCase().includes(rules.verifiedOfferPhrase.toLocaleLowerCase()))) {
    throw new Error(`Step 1 cannot be built without a currently verified ${rules.verifiedPromoCode} ${rules.verifiedOfferPhrase} offer`);
  }

  const openerTemplate = chooseGroup("opener", allowedSteps.opener);
  const opener = fill(openerTemplate, { first: firstName });
  const facts = { first: firstName, ltp_date: ltpDate, program: program?.name ?? "", when: when ?? "", promo: step === 1 ? (input.promoCode ?? context.promo?.code ?? rules.verifiedPromoCode) : "" };
  const parts = [opener];
  if (step === 1) {
    const thanksTemplate = chooseGroup("thanks", config.step1.thanks);
    parts.push(fill(thanksTemplate, facts));
    if (expectsProgram) {
      const nextStepTemplate = chooseGroup("next_step", config.step1.next_step);
      parts.push(fill(nextStepTemplate, facts));
      const offerTemplate = chooseGroup("offer", config.step1.offer);
      parts.push(fill(offerTemplate, facts));
    } else {
      const offerTemplate = chooseGroup("offer_no_program", config.step1.offer_no_program);
      parts.push(fill(offerTemplate, facts));
    }
  } else {
    const nudgeTemplate = chooseGroup("nudge", config.step2.nudge);
    parts.push(fill(nudgeTemplate, facts));
    if (expectsProgram) {
      const nextStepTemplate = chooseGroup("next_step", config.step2.next_step);
      parts.push(fill(nextStepTemplate, facts));
    } else {
      const ctaTemplate = chooseGroup("no_program_cta", config.step2.no_program_cta);
      parts.push(fill(ctaTemplate, facts));
    }
  }
  const link = expectsProgram ? program!.signup_url : rules.bookingUrl;
  const body = `${parts.join(" ")} ${link}`;
  const textContext: LtpTextSelection = {
    step,
    seed_nonce: input.seedNonce,
    slot_indices: selection,
    slot_templates: templates,
    opener,
    ltp_date: ltpDate,
    when: expectsProgram ? when : null,
  };
  const nextContext: RetentionContext = {
    ...context,
    variant: expectsProgram ? "with_program" : "no_program",
    ...(step === 2 ? { promo: null, coupon_warning: null } : {}),
    ...(!expectsProgram ? { booking_url: rules.bookingUrl } : {}),
    date_phrase: `on ${ltpDate}`,
    ltp_text: textContext,
    reason: null,
    errors: [],
    validation_errors: [],
  };
  delete nextContext.generated_preview;
  return { body, context: nextContext, selected_slot_templates: templates };
}
