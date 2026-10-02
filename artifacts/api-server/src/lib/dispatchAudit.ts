import { performance } from "node:perf_hooks";
import { logger } from "./logger";

export type DispatchCheckResult = "pass" | "blocked" | "error";

export function logDispatchCheck(
  messageId: string | undefined,
  check: string,
  result: DispatchCheckResult,
  startedAt: number,
  details: Record<string, unknown> = {},
): void {
  if (!messageId) return;
  logger.info({
    messageId, check, result,
    duration_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
    ...details,
  }, "[dispatch] check");
}

/** Tracks the active transport stage, including failures before a claim. */
export class DispatchAudit {
  private active?: { check: string; startedAt: number };
  constructor(readonly messageId: string) {}
  begin(check: string): void {
    this.end("pass");
    this.active = { check, startedAt: performance.now() };
  }
  end(result: DispatchCheckResult, details: Record<string, unknown> = {}): void {
    if (!this.active) return;
    logDispatchCheck(this.messageId, this.active.check, result, this.active.startedAt, details);
    this.active = undefined;
  }
}