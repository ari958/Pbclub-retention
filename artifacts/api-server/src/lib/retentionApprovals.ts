import {
  ListRetentionApprovalsQueryParams,
  type ListRetentionApprovalsParams,
} from "@workspace/api-zod";
import type { RetentionCandidate, RetentionMessage } from "./retentionTypes";

export const CANDIDATE_STATUSES = ["drafted", "approved", "skipped", "sent", "needs_context", "manual_edit"] as const;

export type ApprovalListStatus = NonNullable<ListRetentionApprovalsParams["status"]> | "needs_context" | "manual_edit";
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export function parseApprovalListStatus(value: unknown) {
  const parsed = ListRetentionApprovalsQueryParams.safeParse({ status: value ?? "all" });
  if (!parsed.success) return parsed;
  return { success: true as const, data: (parsed.data.status ?? "all") as ApprovalListStatus };
}

export function applyCandidateStatusFilter(query: any, status: ApprovalListStatus): any {
  return status === "all" ? query : query.eq("status", status);
}

export function decorateApprovalCandidates(
  candidates: RetentionCandidate[],
  players: Map<string, { name: string }>,
  messages: Map<string, RetentionMessage>,
) {
  return candidates.map((candidate) => ({
    ...candidate,
    player: { name: players.get(candidate.player_id)?.name ?? "Unknown" },
    message: candidate.message_id ? messages.get(candidate.message_id) ?? null : null,
    context: candidate.context,
  }));
}