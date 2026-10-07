import { DEFAULT_RETENTION_LOOKBACK_DAYS } from "./retentionDates";

export const RETENTION_DRAFT_EXPIRY_DAYS = 5;

/** Fail before approval/claim: stale historical drafts must never reach live transport. */
export function assertRetentionDraftFresh(candidate: { created_at?: string; context?: unknown }, now = new Date()) {
  const context = candidate.context as Record<string, unknown> | null;
  if (context?.stale === true || Number(context?.lookback_days ?? DEFAULT_RETENTION_LOOKBACK_DAYS) > DEFAULT_RETENTION_LOOKBACK_DAYS) {
    throw Object.assign(new Error("Stale retention draft; regenerate with the production 3-day lookback"), { status: 409 });
  }
  const generatedAt = typeof context?.draft_generated_at === "string" ? context.draft_generated_at : candidate.created_at;
  if (generatedAt) {
    const created = Date.parse(generatedAt);
    if (!Number.isFinite(created) || now.getTime() - created >= RETENTION_DRAFT_EXPIRY_DAYS * 86400000) {
      throw Object.assign(new Error("Retention draft expired after 5 days; regenerate and review"), { status: 409 });
    }
  }
}
