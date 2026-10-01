export type ApprovalListStatus = "all" | "drafted" | "approved" | "skipped" | "sent" | "needs_context" | "manual_edit";

export function approvalListPath(status: ApprovalListStatus): string {
  return `/api/retention/approvals?status=${encodeURIComponent(status)}`;
}

export function requestApprovalList<T>(
  slug: string,
  status: ApprovalListStatus,
  list: (slug: string, status: ApprovalListStatus) => Promise<T>,
): Promise<T> {
  return list(slug, status);
}