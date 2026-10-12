import type { Candidate, LtpSequenceConfig } from "./retentionApi";
import { LTP_FOLLOWUP_KEY, type FlowPlaybookFields } from "./retentionFlowKeys";

type FlowPlaybook = FlowPlaybookFields | null | undefined;

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

/**
 * A candidate belongs to a two-step sequence flow when its playbook row says
 * so. Without the row (older callers, tests) the Learn to Play key is the
 * only sequence flow we can assume.
 */
export function isSequenceCandidate(candidate: Pick<Candidate, "playbook_key">, playbook?: FlowPlaybook): boolean {
  if (playbook?.flow_kind) return playbook.flow_kind === "sequence";
  return candidate.playbook_key === LTP_FOLLOWUP_KEY;
}

/** Prefer the code-filled value embedded in the copy, not a legacy display format. */
export function formatLtpTriggerFact(candidate: Candidate, playbook?: FlowPlaybook): string {
  const trigger = candidate.context.trigger;
  if (!trigger) return "unavailable";
  const name = trigger.name ?? "Unknown event";
  if (isSequenceCandidate(candidate, playbook) && candidate.context.ltp_text) {
    return `${name} on ${candidate.context.ltp_text.ltp_date}`;
  }
  if (isSequenceCandidate(candidate, playbook)) return `${name} on ${formatLtpDateFact(trigger.date) ?? "date unavailable"}`;
  return `${name} on ${trigger.date ?? "date unavailable"}`;
}

export function formatLtpAttendanceDate(candidate: Candidate, playbook?: FlowPlaybook): string | null {
  if (!isSequenceCandidate(candidate, playbook)) return null;
  return candidate.context.ltp_text?.ltp_date ?? formatLtpDateFact(candidate.context.trigger?.date);
}

/** Keep the session date/time in the facts panel byte-for-byte in sync with LTP copy. */
export function formatLtpNextProgramFact(candidate: Candidate, playbook?: FlowPlaybook): string {
  const program = candidate.context.next_program;
  if (!program) return "none found";
  if (isSequenceCandidate(candidate, playbook)) {
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
  playbook?: FlowPlaybook,
): boolean {
  const step = candidate.step ?? candidate.context.ltp_text?.step;
  return schemaReady && isSequenceCandidate(candidate, playbook)
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
  playbook?: FlowPlaybook,
): boolean {
  if (!isSequenceCandidate(candidate, playbook)) return true;
  const step = candidate.step ?? candidate.context.ltp_text?.step ?? 1;
  return schemaReady
    && candidate.context.ltp_text?.step === step
    && candidate.context.reason == null
    && candidate.status === "drafted"
    && candidate.sequence_status === "active";
}