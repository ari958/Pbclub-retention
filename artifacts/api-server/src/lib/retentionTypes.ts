export interface RetentionPlaybook {
  key: string;
  name: string;
  enabled: boolean;
  promo_code: string | null;
  offer_text: string | null;
  next_program_names: string[];
  message_guidance: string | null;
  holdout_pct: number;
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
  trigger: { event_id: string; name: string; date: string };
  player_first_name: string;
  next_program: RetentionNextProgram | null;
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
}

export interface RetentionMessage {
  id: string;
  body: string | null;
  status: string;
  approved_at: string | null;
  approved_by: string | null;
  scheduled_send_at: string | null;
  sent_at: string | null;
}