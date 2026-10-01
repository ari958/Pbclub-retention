import { logger } from "./logger";
import { isRetentionOnlyMode } from "./retentionPolicy";
import { supabase } from "./supabaseClient";

export class RetentionDispatchAuthorizationError extends Error {
  constructor(message: string, readonly statusCode: 403 | 500) {
    super(message);
    this.name = "RetentionDispatchAuthorizationError";
  }
}

interface RetentionCandidateDispatchRow {
  id?: string;
  message_id?: string | null;
  player_id?: string | null;
  club_id?: string | null;
  status?: string | null;
  context?: unknown;
}

export async function verifyRetentionCandidateDispatch(
  messageId: string,
  playerId: string,
  clubId: string | null | undefined,
  messageApprovedAt: string | null | undefined,
): Promise<RetentionCandidateDispatchRow | null> {
  const { data: candidate, error } = await supabase
    .from("retention_candidates")
    .select("*")
    .eq("message_id", messageId)
    .maybeSingle();

  if (error) {
    logger.error({ messageId, err: error.message }, "Could not verify retention candidate before SMS dispatch");
    throw new RetentionDispatchAuthorizationError(
      `Retention candidate approval could not be verified: ${error.message}`,
      500,
    );
  }

  if (!isRetentionOnlyMode()) return candidate as RetentionCandidateDispatchRow | null;

  const blocked = (message: string): never => {
    throw new RetentionDispatchAuthorizationError(message, 403);
  };

  if (!candidate) {
    blocked("Retention-only dispatch requires an approved retention candidate linked to this message");
  }

  const linked = candidate as RetentionCandidateDispatchRow;
  if (
    linked.message_id !== messageId ||
    linked.player_id !== playerId ||
    !clubId ||
    linked.club_id !== clubId
  ) {
    blocked("Retention candidate does not match this message, player, and active club");
  }
  // Current schema records approval as candidate.status='approved' and stamps
  // the linked messages.approved_at; retention_candidates has no approved_at.
  if (
    linked.status !== "approved" ||
    typeof messageApprovedAt !== "string" ||
    !messageApprovedAt.trim()
  ) {
    blocked("Retention candidate and linked message have not been explicitly approved");
  }
  return linked;
}