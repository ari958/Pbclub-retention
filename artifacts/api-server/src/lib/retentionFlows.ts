/**
 * Retention flow registry.
 *
 * A "flow" is the code-side definition of a retention playbook: which
 * attendance triggers it, how its texts are built, and which verified offer it
 * may mention. The database row in `retention_playbooks` holds the operator
 * tunables (enabled, promo code, next program names, phrase slots); this
 * module holds everything that used to be a hard-coded `"ltp_followup"` or
 * `"LTPNEXT25"` literal inside the engine.
 *
 * Learn to Play follow-up is the first and, today, the only registered flow.
 * Registering a second sequence flow also needs database work: the sequence
 * RPCs in migration 013 only accept `ltp_followup` (see RUNBOOK open items).
 */
import {
  buildLtpStepText,
  DEFAULT_LTP_SEQUENCE_CONFIG,
  formatLtpDate,
  validateLtpSequenceConfig,
  type BuildLtpPhraseInput,
  type BuiltLtpStep,
} from "./ltpPhraseBuilder";
import {
  RETENTION_LTP_VERIFIED_OFFER_TEXT,
  RETENTION_NO_PROGRAM_BOOKING_URL,
  type LtpSequenceConfig,
  type RetentionPlaybook,
  type RetentionSequenceStep,
} from "./retentionTypes";

export const normalizeRetentionName = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/[‐-―_-]/g, " ").replace(/\s+/g, " ").trim();

export const isLearnToPlayName = (value: string) =>
  /\blearn to play\b/.test(normalizeRetentionName(value));

/** Multi-step, code-filled text sequence (no LLM). */
export interface RetentionSequenceFlow {
  maxSteps: 2;
  /** The only coupon this flow may ever mention; verified live before use. */
  verifiedPromoCode: string;
  /** Canonical offer wording that backs the verified coupon. */
  verifiedOfferText: string;
  defaultConfig: LtpSequenceConfig;
  validateConfig(value: unknown): LtpSequenceConfig;
  /** Validated phrase-slot config from the playbook row, or the default. */
  readConfig(playbook: Pick<RetentionPlaybook, "ltp_sequence_config">): LtpSequenceConfig;
  /** Playbook as seen by a given step (later steps carry no offer). */
  playbookForStep(playbook: RetentionPlaybook, step: RetentionSequenceStep): RetentionPlaybook;
  /** Promo code the step's text is allowed to include, or null. */
  promoCodeForStep(playbook: Pick<RetentionPlaybook, "promo_code">, step: RetentionSequenceStep): string | null;
  buildStepText(input: BuildLtpPhraseInput): BuiltLtpStep;
}

export interface RetentionFlowDefinition {
  /** Matches `retention_playbooks.key` and `retention_candidates.playbook_key`. */
  key: string;
  name: string;
  /** Short noun for run-history labels ("Rebuild LTP"). */
  shortLabel: string;
  /** Human name of the triggering program, used in operator-facing errors. */
  triggerProgramLabel: string;
  /** Does an attendance row's program name start this flow? */
  isTriggerProgram(programName: string): boolean;
  /** Club-local trigger date as it appears in texts ("Oct 3"). */
  formatTriggerDate(date: string): string;
  /** Required first sentence of every text in this flow. */
  opener(firstName: string): string;
  /** Generic booking page used when no specific program is offered. */
  bookingUrl: string;
  /** Present when texts are built by the deterministic phrase builder. */
  sequence: RetentionSequenceFlow | null;
}

const LTP_SEQUENCE: RetentionSequenceFlow = {
  maxSteps: 2,
  verifiedPromoCode: "LTPNEXT25",
  verifiedOfferText: RETENTION_LTP_VERIFIED_OFFER_TEXT,
  defaultConfig: DEFAULT_LTP_SEQUENCE_CONFIG,
  validateConfig: validateLtpSequenceConfig,
  readConfig(playbook) {
    return validateLtpSequenceConfig(playbook.ltp_sequence_config ?? DEFAULT_LTP_SEQUENCE_CONFIG);
  },
  playbookForStep(playbook, step) {
    return step === 2 ? { ...playbook, promo_code: null, offer_text: null } : playbook;
  },
  promoCodeForStep(playbook, step) {
    return step === 1 ? (playbook.promo_code ?? LTP_SEQUENCE.verifiedPromoCode) : null;
  },
  buildStepText: buildLtpStepText,
};

export const LTP_FOLLOWUP_FLOW: RetentionFlowDefinition = {
  key: "ltp_followup",
  name: "Learn to Play follow-up",
  shortLabel: "LTP",
  triggerProgramLabel: "Learn to Play",
  isTriggerProgram: isLearnToPlayName,
  formatTriggerDate: formatLtpDate,
  opener: (firstName) => `Hi ${firstName}, it's PB Club.`,
  bookingUrl: RETENTION_NO_PROGRAM_BOOKING_URL,
  sequence: LTP_SEQUENCE,
};

export const RETENTION_FLOWS: readonly RetentionFlowDefinition[] = Object.freeze([LTP_FOLLOWUP_FLOW]);

export const DEFAULT_RETENTION_FLOW_KEY = LTP_FOLLOWUP_FLOW.key;

/** Keys the database sequence RPCs (migration 013) accept today. */
export type RetentionSequenceFlowKey = "ltp_followup";

export function findRetentionFlow(key: string | null | undefined): RetentionFlowDefinition | undefined {
  if (!key) return undefined;
  return RETENTION_FLOWS.find((flow) => flow.key === key);
}

export function getRetentionFlow(key: string | null | undefined): RetentionFlowDefinition {
  const flow = findRetentionFlow(key);
  if (!flow) throw Object.assign(new Error(`Unknown retention flow: ${key ?? "(none)"}`), { status: 400 });
  return flow;
}

export function isSequenceFlowKey(key: string | null | undefined): key is RetentionSequenceFlowKey {
  return !!findRetentionFlow(key)?.sequence;
}

/** Throws unless the key names a registered sequence flow. */
export function getSequenceFlow(key: string | null | undefined): RetentionFlowDefinition & { sequence: RetentionSequenceFlow } {
  const flow = getRetentionFlow(key);
  if (!flow.sequence) throw Object.assign(new Error(`Retention flow ${flow.key} is not a text sequence`), { status: 400 });
  return flow as RetentionFlowDefinition & { sequence: RetentionSequenceFlow };
}

/** Every registered flow a batch of candidates belongs to, or an error when they mix flows. */
export function requireSingleFlow(playbookKeys: Iterable<string>): RetentionFlowDefinition {
  const keys = [...new Set(playbookKeys)];
  if (keys.length !== 1) {
    throw Object.assign(new Error("All candidates in a batch must belong to the same retention flow"), { status: 400 });
  }
  return getRetentionFlow(keys[0]);
}
