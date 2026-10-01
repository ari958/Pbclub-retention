const RETRYABLE_CONTEXT_REASONS = new Set(["context_lookup_failed", "no_next_program"]);

export function isRetryContextEligible(status: unknown, reason: unknown): boolean {
  return status === "needs_context" && typeof reason === "string" && RETRYABLE_CONTEXT_REASONS.has(reason);
}