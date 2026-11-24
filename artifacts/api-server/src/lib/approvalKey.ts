import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Narrow machine credential for approving retention drafts from a chat
 * session (Ari, 2026-11-24). Sent as a header the cloud environment's network
 * proxy injects; the value never appears in chat or in the repo.
 *
 * It can only: list approvals, approve one candidate, skip one candidate.
 * Every other route still requires the dashboard's operator login.
 * Off unless RETENTION_APPROVAL_KEY is set (32+ characters) on the server.
 */
export const APPROVAL_KEY_HEADER = "x-retention-approval-key";
export const APPROVAL_KEY_ACTOR = "chat-approval";
const MIN_KEY_LENGTH = 32;

const ALLOWED: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/api\/retention\/approvals$/],
  ["POST", /^\/api\/retention\/candidates\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:approve|skip)$/i],
];

const digest = (value: string) => createHash("sha256").update(value).digest();

export function approvalKeyRouteAllowed(method: string, path: string): boolean {
  return ALLOWED.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(path));
}

/** "ok" when the header carries the configured key for an allowed route; why not otherwise. */
export function checkApprovalKey(
  req: Pick<Request, "method" | "path" | "get">,
  configured = process.env.RETENTION_APPROVAL_KEY,
): "ok" | "absent" | "disabled" | "invalid" | "route_not_allowed" {
  const presented = req.get(APPROVAL_KEY_HEADER);
  if (presented === undefined) return "absent";
  if (!configured || configured.length < MIN_KEY_LENGTH) return "disabled";
  if (!timingSafeEqual(digest(presented.trim()), digest(configured))) return "invalid";
  if (!approvalKeyRouteAllowed(req.method, req.path)) return "route_not_allowed";
  return "ok";
}

/** "HH:MM" in New York time, inside the 8:30am-7:30pm window that is valid every day. */
export function parseSendTimeEt(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return null;
  const total = hour * 60 + minute;
  return total >= 8 * 60 + 30 && total <= 19 * 60 + 30 ? { hour, minute } : null;
}
