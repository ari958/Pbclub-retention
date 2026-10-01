import { clubApiUrl } from "./ClubContext";
import { approvalListPath, type ApprovalListStatus } from "./approvalListRequest";

export type CandidateStatus = "drafted" | "approved" | "skipped" | "sent" | "needs_context" | "manual_edit";
export type { ApprovalListStatus } from "./approvalListRequest";
export interface Playbook {
  key: string; name: string; enabled: boolean; promo_code: string | null; offer_text: string | null;
  next_program_names: string[]; message_guidance: string | null; holdout_pct: number;
  ltp_sequence_config?: LtpSequenceConfig | null;
}
export interface LtpSequenceConfig {
  step2_gap_days: number;
  step1: {
    opener: string[]; thanks: string[]; next_step: string[]; offer: string[]; offer_no_program: string[];
  };
  step2: {
    opener: string[]; nudge: string[]; next_step: string[]; no_program_cta: string[];
  };
}
export interface ProgramFact { event_id: string; name: string; start_time: string; date: string; time: string; signup_url: string }
export interface Candidate {
  id: string; playbook_key: string; player_id: string; trigger_event_id: string; status: CandidateStatus;
  context: {
    ltp_text?: { step: 1 | 2; seed_nonce: number; slot_indices: Record<string, number>; slot_templates: Record<string, string>; opener: string; ltp_date: string; when: string | null };
    variant?: "with_program" | "no_program";
    booking_url?: string;
    forbidden_program_names?: string[];
    player_first_name?: string | null;
    trigger?: { event_id?: string; name?: string; date?: string } | null;
    next_program?: (ProgramFact & { spots_remaining: number | null }) | null;
    classmates_signed_up?: number | null;
    already_booked?: boolean | null;
    booked_event?: ProgramFact | null;
    promo?: { code: string; offer_text: string } | null;
    coupon_warning?: string | null;
    evaluated_at?: string | null;
    stale?: boolean;
    lookback_days?: number;
    reason?: string | null;
    errors?: unknown[];
    validation_errors?: string[];
    date_phrase?: string | null;
    send_date?: string | null;
    send_date_et?: string | null;
    next_program_day?: string | null;
    generated_preview?: string | null;
    diagnostics?: unknown;
  };
  step?: 1 | 2;
  sequence_id?: string | null;
  sequence_status?: "active" | "paused_reply" | "exited_booked" | "exited_opt_out" | "completed" | null;
  exited_at?: string | null;
  exit_reason?: string | null;
  booked_event_id?: string | null;
  step1_text?: string | null;
  step1_sent_at?: string | null;
  player: { name: string } | null;
  message: { id: string; body: string; status: string; approved_at: string | null; approved_by: string | null; scheduled_send_at: string | null; sent_at: string | null; simulated?: boolean | null; retention_delivery_kind?: "real" | "test" | "simulated" | null } | null;
}
export interface ApprovalsResponse {
  schema_ready: boolean; retry_context_ready: boolean; sequence_schema_ready: boolean; playbooks: Playbook[]; candidates: Candidate[]; warnings: string[];
  mode: { retention_only: boolean; require_marketing_consent: boolean; kill_switch?: boolean | null; sms_live?: boolean; test_override_configured?: boolean }; error?: string;
  counts?: { all: number; drafted: number; approved: number; skipped: number; sent: number; needs_context?: number; manual_edit?: number };
}
export interface GenerateResult {
  created?: number; skipped?: number; needs_context?: number; manual_edit?: number; errors?: string[]; lookback_days?: number;
  stats?: { found?: number; new_ltp_players?: number; created?: number; skipped?: number; needs_context?: number; manual_edit?: number; errors?: string[]; skipped_by_reason?: Record<string, number> };
}
export interface RegenerateResult {
  candidate_id: string;
  status: "drafted" | "needs_context" | "manual_edit" | "skipped";
  reason: string | null;
  body: string | null;
  context: Candidate["context"];
  validation_errors?: string[];
}
export interface PodplayRetryTelemetry {
  total_calls: number;
  listing_calls: number;
  signup_calls: number;
  trigger_calls: number;
  coupon_calls: number;
  rate_limit_count: number;
  retries: Array<{ path: string; attempt: number; retry_number: number; wait_ms: number; status: number }>;
}
export interface RetryContextEnvelope {
  schema_ready: boolean;
  results: RegenerateResult[];
  failures?: Array<{ candidate_id: string; error: string; http_status: number }>;
  podplay: PodplayRetryTelemetry;
}
export interface LtpRegenerateBatchEnvelope {
  schema_ready: boolean;
  results: RegenerateResult[];
  failures?: Array<{ candidate_id: string; error: string; http_status: number }>;
  podplay: PodplayRetryTelemetry;
}
export interface BulkResult { approved?: number; approved_count?: number; errors?: string[] }

export const DEFAULT_LOOKBACK_DAYS = 3 as const;
export const LOOKBACK_DAY_OPTIONS = [3, 7, 14, 30] as const;

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function call<T>(slug: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(clubApiUrl(slug, path), {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

export const retentionApi = {
  list: (s: string, status: ApprovalListStatus) => call<ApprovalsResponse>(s, approvalListPath(status)),
  generate: (s: string, lookbackDays: number = DEFAULT_LOOKBACK_DAYS) => call<GenerateResult>(s, "/api/retention/generate", "POST", { lookback_days: lookbackDays }),
  regenerate: (s: string, id: string) => call<RegenerateResult>(s, `/api/retention/candidates/${id}/regenerate`, "POST"),
  retryContext: (s: string, id: string) =>
    call<RetryContextEnvelope>(s, `/api/retention/candidates/${id}/retry-context`, "POST", {}),
  retryContextBatch: (s: string, candidate_ids: string[]) =>
    call<RetryContextEnvelope>(s, "/api/retention/retry-context", "POST", { candidate_ids }),
  regenerateLtpBatch: (s: string, candidate_ids: string[]) =>
    call<LtpRegenerateBatchEnvelope>(s, "/api/retention/regenerate-batch", "POST", { candidate_ids }),
  reshuffleLtp: (s: string, id: string) =>
    call<RegenerateResult>(s, `/api/retention/candidates/${id}/reshuffle`, "POST", {}),
  updatePlaybookSequenceConfig: (s: string, key: string, config: LtpSequenceConfig) =>
    call<Playbook>(s, `/api/retention/playbooks/${encodeURIComponent(key)}/config`, "PATCH", { ltp_sequence_config: config }),
  edit: (s: string, id: string, body: string) => call<unknown>(s, `/api/retention/candidates/${id}`, "PATCH", { body }),
  approve: (s: string, id: string, approved_by: string, expected_body: string) =>
    call<unknown>(s, `/api/retention/candidates/${id}/approve`, "POST", { approved_by, expected_body }),
  killSwitch: (s: string, enabled: boolean) => call<unknown>(s, "/api/retention/kill-switch", "PATCH", { enabled }),
  skip: (s: string, id: string) => call<unknown>(s, `/api/retention/candidates/${id}/skip`, "POST", {}),
  bulk: (s: string, key: string, approved_by: string, candidate_ids: string[], expected_bodies: Record<string, string>) =>
    call<BulkResult>(s, `/api/retention/playbooks/${encodeURIComponent(key)}/approve`, "POST", { approved_by, candidate_ids, expected_bodies }),
};
