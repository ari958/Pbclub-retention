import type { Candidate, LtpSequenceConfig } from "./retentionApi";

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

export type LtpPhraseSlotKey =
  | "step1.opener" | "step1.thanks" | "step1.next_step" | "step1.offer" | "step1.offer_no_program"
  | "step2.opener" | "step2.nudge" | "step2.next_step" | "step2.no_program_cta";

export const LTP_PHRASE_SLOT_KEYS: LtpPhraseSlotKey[] = [
  "step1.opener", "step1.thanks", "step1.next_step", "step1.offer", "step1.offer_no_program",
  "step2.opener", "step2.nudge", "step2.next_step", "step2.no_program_cta",
];

export function ltpPhraseSlot(config: LtpSequenceConfig, key: LtpPhraseSlotKey): string[] {
  const [step, slot] = key.split(".") as ["step1" | "step2", string];
  const slots = config[step] as Record<string, readonly string[]>;
  return [...(slots[slot] ?? [])];
}

export function updateLtpPhraseSlot(
  config: LtpSequenceConfig,
  key: LtpPhraseSlotKey,
  values: string[],
): LtpSequenceConfig {
  const [step, slot] = key.split(".") as ["step1" | "step2", string];
  return { ...config, [step]: { ...config[step], [slot]: values } } as LtpSequenceConfig;
}

export function parsePhraseSlotEditor(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function validateLtpSequenceConfig(
  input: unknown,
): input is LtpSequenceConfig {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  if (!Number.isInteger(value.step2_gap_days) || Number(value.step2_gap_days) < 7 || Number(value.step2_gap_days) > 30) return false;
  for (const key of LTP_PHRASE_SLOT_KEYS) {
    const [step, slot] = key.split(".") as ["step1" | "step2", string];
    const phrases = (value[step] as Record<string, unknown> | undefined)?.[slot];
    if (!Array.isArray(phrases) || phrases.length === 0
      || phrases.length > 32
      || phrases.some((phrase) => typeof phrase !== "string" || !phrase.trim() || phrase.length > 240)) return false;
  }
  return true;
}

export function isLtpCandidate(candidate: Pick<Candidate, "playbook_key">): boolean {
  return candidate.playbook_key === "ltp_followup";
}

/** Prefer the code-filled value embedded in the copy, not a legacy display format. */
export function formatLtpTriggerFact(candidate: Candidate): string {
  const trigger = candidate.context.trigger;
  if (!trigger) return "unavailable";
  const name = trigger.name ?? "Unknown event";
  if (isLtpCandidate(candidate) && candidate.context.ltp_text) {
    return `${name} on ${candidate.context.ltp_text.ltp_date}`;
  }
  if (isLtpCandidate(candidate)) return `${name} on ${formatLtpDateFact(trigger.date) ?? "date unavailable"}`;
  return `${name} on ${trigger.date ?? "date unavailable"}`;
}

export function formatLtpAttendanceDate(candidate: Candidate): string | null {
  if (!isLtpCandidate(candidate)) return null;
  return candidate.context.ltp_text?.ltp_date ?? formatLtpDateFact(candidate.context.trigger?.date);
}

/** Keep the session date/time in the facts panel byte-for-byte in sync with LTP copy. */
export function formatLtpNextProgramFact(candidate: Candidate): string {
  const program = candidate.context.next_program;
  if (!program) return "none found";
  if (isLtpCandidate(candidate)) {
    const when = candidate.context.ltp_text?.when ?? formatLtpSessionWhen(program.start_time);
    return `${program.name}, ${when ?? "session time unavailable"}`;
  }
  return `${program.name}, ${program.date} ${program.time}`;
}

function formatLtpDateFact(date: string | undefined): string | null {
  if (!date) return null;
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return null;
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  if (Number.isNaN(instant.getTime())
    || instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day) {
    return null;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];
  return `${months[month - 1]} ${day}`;
}

export function formatLtpSessionWhen(startTime: string): string | null {
  const instant = new Date(startTime);
  if (!Number.isFinite(instant.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.weekday}, ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute}${String(parts.dayPeriod).toLowerCase()}`;
}

export function canReshuffleLtpCandidate(
  candidate: Pick<Candidate, "playbook_key" | "status" | "step" | "context" | "sequence_status">,
  schemaReady: boolean,
): boolean {
  const step = candidate.step ?? candidate.context.ltp_text?.step;
  return schemaReady && isLtpCandidate(candidate)
    && candidate.status === "drafted"
    && step !== undefined
    && candidate.context.ltp_text?.step === step
    && candidate.context.reason == null
    && candidate.sequence_status === "active";
}

/** Old model-built drafts are deliberately blocked until their slot-based text is rebuilt. */
export function canApproveLtpCandidate(
  candidate: Pick<Candidate, "playbook_key" | "status" | "step" | "context" | "sequence_status">,
  schemaReady: boolean,
): boolean {
  if (!isLtpCandidate(candidate)) return true;
  const step = candidate.step ?? candidate.context.ltp_text?.step ?? 1;
  return schemaReady
    && candidate.context.ltp_text?.step === step
    && candidate.context.reason == null
    && candidate.status === "drafted"
    && candidate.sequence_status === "active";
}