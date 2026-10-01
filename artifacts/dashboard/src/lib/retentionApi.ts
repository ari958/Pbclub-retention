import { clubApiUrl } from "./ClubContext";
import { approvalListPath, type ApprovalListStatus } from "./approvalListRequest";

export type CandidateStatus = "drafted" | "approved" | "skipped" | "sent";
export type { ApprovalListStatus } from "./approvalListRequest";
export interface Playbook {
  key: string; name: string; enabled: boolean; promo_code: string | null; offer_text: string | null;
  next_program_names: string[]; message_guidance: string | null; holdout_pct: number;
}
export interface ProgramFact { event_id: string; name: string; start_time: string; date: string; time: string; signup_url: string }
export interface Candidate {
  id: string; playbook_key: string; player_id: string; trigger_event_id: string; status: CandidateStatus;
  context: {
    player_first_name: string;
    trigger: { event_id: string; name: string; date: string };
    next_program: (ProgramFact & { spots_remaining: number | null }) | null;
    classmates_signed_up: number;
    already_booked: boolean;
    booked_event: ProgramFact | null;
    promo: { code: string; offer_text: string } | null;
    coupon_warning: string | null;
    evaluated_at: string;
  };
  player: { name: string } | null;
  message: { id: string; body: string; status: string; approved_at: string | null; approved_by: string | null; scheduled_send_at: string | null; sent_at: string | null; simulated?: boolean | null } | null;
}
export interface ApprovalsResponse {
  schema_ready: boolean; playbooks: Playbook[]; candidates: Candidate[]; warnings: string[];
  mode: { retention_only: boolean; require_marketing_consent: boolean; kill_switch?: boolean | null; sms_live?: boolean; test_override_configured?: boolean }; error?: string;
  counts?: { all: number; drafted: number; approved: number; skipped: number; sent: number };
}
export interface GenerateResult {
  created?: number; skipped?: number; errors?: string[]; lookback_days?: number;
  stats?: { found?: number; new_ltp_players?: number; created?: number; skipped?: number; errors?: string[]; skipped_by_reason?: Record<string, number> };
}
export interface BulkResult { approved?: number; approved_count?: number; errors?: string[] }

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
  generate: (s: string, lookbackDays = 7) => call<GenerateResult>(s, "/api/retention/generate", "POST", { lookback_days: lookbackDays }),
  edit: (s: string, id: string, body: string) => call<unknown>(s, `/api/retention/candidates/${id}`, "PATCH", { body }),
  approve: (s: string, id: string, approved_by: string, expected_body: string) =>
    call<unknown>(s, `/api/retention/candidates/${id}/approve`, "POST", { approved_by, expected_body }),
  killSwitch: (s: string, enabled: boolean) => call<unknown>(s, "/api/retention/kill-switch", "PATCH", { enabled }),
  skip: (s: string, id: string) => call<unknown>(s, `/api/retention/candidates/${id}/skip`, "POST", {}),
  bulk: (s: string, key: string, approved_by: string, candidate_ids: string[], expected_bodies: Record<string, string>) =>
    call<BulkResult>(s, `/api/retention/playbooks/${encodeURIComponent(key)}/approve`, "POST", { approved_by, candidate_ids, expected_bodies }),
};
