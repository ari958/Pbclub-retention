/**
 * Retention flow registry.
 *
 * A "flow" is the code-side definition of a retention playbook: which
 * attendance triggers it, how its texts are built, and which verified offer it
 * may mention. The database row in `retention_playbooks` holds the operator
 * tunables (enabled, promo code, next program names, phrase slots) and, since
 * migration 031, a copy of the same rules for the SQL writers; this module
 * holds everything that used to be a hard-coded `"ltp_followup"` or
 * `"LTPNEXT25"` literal inside the engine and the text modules.
 *
 * Learn to Play follow-up is the first and, today, the only registered flow.
 * A second flow is one `defineSequenceFlow` call added to RETENTION_FLOWS plus
 * a matching `retention_playbooks` row (see RUNBOOK "Retention engine
 * generalization" for the remaining route, dashboard and scheduler work).
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
  LTP_TEXT_RULES,
  type LtpSequenceConfig,
  type RetentionPlaybook,
  type RetentionSequenceStep,
  type RetentionTextRules,
} from "./retentionTypes";

export type { RetentionTextRules } from "./retentionTypes";

export const normalizeRetentionName = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/[‐-―_-]/g, " ").replace(/\s+/g, " ").trim();

export const isLearnToPlayName = (value: string) =>
  /\blearn to play\b/.test(normalizeRetentionName(value));

/** Multi-step, code-filled text sequence (no LLM). */
export interface RetentionSequenceFlow {
  maxSteps: 2;
  /** Rules the phrase builder, validators, coupon check and SQL writers share. */
  rules: RetentionTextRules;
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

export type SequenceFlowDefinition = RetentionFlowDefinition & { sequence: RetentionSequenceFlow };

export interface SequenceFlowSpec {
  key: string;
  name: string;
  shortLabel: string;
  isTriggerProgram(programName: string): boolean;
  rules: RetentionTextRules;
  defaultConfig: LtpSequenceConfig;
}

/** Declares a two-step, code-filled sequence flow from its rules alone. */
export function defineSequenceFlow(spec: SequenceFlowSpec): SequenceFlowDefinition {
  const { rules } = spec;
  const sequence: RetentionSequenceFlow = {
    maxSteps: 2,
    rules,
    verifiedPromoCode: rules.verifiedPromoCode,
    verifiedOfferText: rules.verifiedOfferText,
    defaultConfig: spec.defaultConfig,
    validateConfig: (value) => validateLtpSequenceConfig(value, rules),
    readConfig(playbook) {
      return validateLtpSequenceConfig(playbook.ltp_sequence_config ?? spec.defaultConfig, rules);
    },
    playbookForStep(playbook, step) {
      return step === 2 ? { ...playbook, promo_code: null, offer_text: null } : playbook;
    },
    promoCodeForStep(playbook, step) {
      return step === 1 ? (playbook.promo_code ?? rules.verifiedPromoCode) : null;
    },
    buildStepText: (input) => buildLtpStepText({
      ...input, rules: input.rules ?? rules, config: input.config ?? spec.defaultConfig,
    }),
  };
  return {
    key: spec.key,
    name: spec.name,
    shortLabel: spec.shortLabel,
    triggerProgramLabel: rules.triggerProgramLabel,
    isTriggerProgram: spec.isTriggerProgram,
    formatTriggerDate: formatLtpDate,
    opener: (firstName) => `Hi ${firstName}, it's PB Club.`,
    bookingUrl: rules.bookingUrl,
    sequence,
  };
}

export const LTP_FOLLOWUP_FLOW: SequenceFlowDefinition = defineSequenceFlow({
  key: "ltp_followup",
  name: "Learn to Play follow-up",
  shortLabel: "LTP",
  isTriggerProgram: isLearnToPlayName,
  rules: LTP_TEXT_RULES,
  defaultConfig: DEFAULT_LTP_SEQUENCE_CONFIG,
});

export const RETENTION_FLOWS: readonly RetentionFlowDefinition[] = Object.freeze([LTP_FOLLOWUP_FLOW]);

export const DEFAULT_RETENTION_FLOW_KEY = LTP_FOLLOWUP_FLOW.key;

/** Keys the database sequence RPCs accept; one per registered sequence flow. */
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
export function getSequenceFlow(key: string | null | undefined): SequenceFlowDefinition {
  const flow = getRetentionFlow(key);
  if (!flow.sequence) throw Object.assign(new Error(`Retention flow ${flow.key} is not a text sequence`), { status: 400 });
  return flow as SequenceFlowDefinition;
}

/** Text rules for a playbook key, or the Learn to Play rules for keys that are not sequence flows. */
export function textRulesForPlaybook(key: string | null | undefined): RetentionTextRules {
  return findRetentionFlow(key)?.sequence?.rules ?? LTP_TEXT_RULES;
}

/** The sequence flow whose verified coupon this is, if any. */
export function findSequenceFlowByPromoCode(code: string | null | undefined): SequenceFlowDefinition | undefined {
  if (!code) return undefined;
  return RETENTION_FLOWS.find((flow): flow is SequenceFlowDefinition =>
    !!flow.sequence && flow.sequence.verifiedPromoCode === code);
}

/** Every registered flow a batch of candidates belongs to, or an error when they mix flows. */
export function requireSingleFlow(playbookKeys: Iterable<string>): RetentionFlowDefinition {
  const keys = [...new Set(playbookKeys)];
  if (keys.length !== 1) {
    throw Object.assign(new Error("All candidates in a batch must belong to the same retention flow"), { status: 400 });
  }
  return getRetentionFlow(keys[0]);
}

/**
 * The database copy of the rules (migration 031) must agree with the code.
 * Rows read before 031 is applied carry no flow_kind and are accepted as-is.
 */
export function assertPlaybookMatchesFlow(playbook: RetentionPlaybook, flow: SequenceFlowDefinition): void {
  if (playbook.flow_kind === undefined) return;
  const { rules } = flow.sequence;
  const mismatches: string[] = [];
  if (playbook.flow_kind !== "sequence") mismatches.push(`flow_kind is ${playbook.flow_kind}, expected sequence`);
  const expect = (column: string, actual: string | null | undefined, expected: string) => {
    if (actual !== expected) mismatches.push(`${column} is ${JSON.stringify(actual ?? null)}, expected ${JSON.stringify(expected)}`);
  };
  expect("trigger_program_label", playbook.trigger_program_label, rules.triggerProgramLabel);
  expect("verified_promo_code", playbook.verified_promo_code, rules.verifiedPromoCode);
  expect("verified_offer_phrase", playbook.verified_offer_phrase, rules.verifiedOfferPhrase);
  expect("booking_url", playbook.booking_url, rules.bookingUrl);
  if (mismatches.length) {
    throw Object.assign(new Error(
      `retention_playbooks.${playbook.key} disagrees with the ${flow.name} flow in code: ${mismatches.join("; ")}`,
    ), { status: 409 });
  }
}
