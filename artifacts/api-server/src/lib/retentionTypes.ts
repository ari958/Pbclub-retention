export const RETENTION_NO_PROGRAM_BOOKING_URL = "https://pbclub.podplay.app";
export const RETENTION_LTP_VERIFIED_OFFER_TEXT = "25% off your next program";

export interface RetentionPlaybook {
  key: string;
  name: string;
  enabled: boolean;
  promo_code: string | null;
  offer_text: string | null;
  next_program_names: string[];
  message_guidance: string | null;
  holdout_pct: number;
  ltp_sequence_config?: LtpSequenceConfig;
  /** Flow rules read by the sequence RPCs (migration 031). Absent on rows read before it is applied. */
  flow_kind?: "single" | "sequence";
  trigger_program_label?: string | null;
  verified_promo_code?: string | null;
  verified_offer_phrase?: string | null;
  booking_url?: string | null;
}

export type LtpSequenceStatus = "active" | "paused_reply" | "exited_booked" | "exited_opt_out" | "completed" | "exited_test";
export type RetentionSequenceStep = 1 | 2;

export interface LtpSequenceStep1Slots {
  opener: string[];
  thanks: string[];
  next_step: string[];
  offer: string[];
  offer_no_program: string[];
}

export interface LtpSequenceStep2Slots {
  opener: string[];
  nudge: string[];
  next_step: string[];
  no_program_cta: string[];
}

export interface LtpSequenceConfig {
  step2_gap_days: number;
  step1: LtpSequenceStep1Slots;
  step2: LtpSequenceStep2Slots;
}

export interface LtpTextSelection {
  step: RetentionSequenceStep;
  seed_nonce: number;
  slot_indices: Record<string, number>;
  slot_templates: Record<string, string>;
  opener: string;
  ltp_date: string;
  when: string | null;
}

export interface RetentionNextProgram {
  event_id: string;
  name: string;
  start_time: string;
  date: string;
  time: string;
  signup_url: string;
  spots_remaining: number;
}

export interface RetentionContext {
  ltp_test_mode?: boolean;
  /** Omitted only on legacy contexts; infer with_program only when next_program exists. */
  variant?: "with_program" | "no_program";
  trigger: { event_id: string; name: string; date: string };
  player_first_name: string;
  next_program: RetentionNextProgram | null;
  booking_url?: string;
  forbidden_program_names?: string[];
  classmates_signed_up: number;
  already_booked: boolean;
  booked_event: {
    event_id: string;
    name: string;
    start_time: string;
    date: string;
    time: string;
    signup_url: string;
  } | null;
  promo: { code: string; offer_text: string } | null;
  coupon_warning: string | null;
  evaluated_at: string;
  diagnostics?: Record<string, unknown>;
  errors?: string[];
  reason?: string | null;
  validation_errors?: string[];
  date_phrase?: string;
  send_date_et?: string;
  next_program_day?: string;
  generated_preview?: string | null;
  lookback_days?: number;
  stale?: boolean;
  ltp_text?: LtpTextSelection;
  [evidence: string]: unknown;
}

export interface RetentionCandidate {
  id: string;
  club_id: string;
  player_id: string;
  playbook_key: string;
  trigger_event_id: string;
  context: RetentionContext;
  status: "drafted" | "approved" | "skipped" | "sent" | "needs_context" | "manual_edit";
  message_id: string | null;
  created_at: string;
  updated_at: string;
  step?: RetentionSequenceStep;
  sequence_id?: string | null;
  sequence_status?: LtpSequenceStatus;
  exited_at?: string | null;
  exit_reason?: string | null;
  booked_event_id?: string | null;
}

export interface RetentionMessage {
  id: string;
  body: string | null;
  status: string;
  approved_at: string | null;
  approved_by: string | null;
  scheduled_send_at: string | null;
  sent_at: string | null;
  simulated?: boolean | null;
  retention_delivery_kind?: "real" | "test" | "simulated" | null;
}