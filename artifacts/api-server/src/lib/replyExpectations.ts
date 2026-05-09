import { supabase } from "./supabaseClient";

/**
 * Reply Expectation pattern.
 *
 * When an outbound message expects a structured reply (e.g. "1 or 2" for
 * session feedback, "yes" or "no" for a future buddy invite), the sending
 * flow creates a reply_expectations row recording what was sent and how to
 * route a future reply back to the originating intent.
 *
 * The inbound webhook in routes/messages.ts looks up the player's active
 * (unresolved, unexpired) expectation and dispatches the reply to the
 * appropriate handler by `kind`.
 *
 * This module is the only sanctioned way to create or resolve expectations.
 * Do not insert into reply_expectations directly from feature flows.
 */

export type ReplyExpectationKind =
  | "session_feedback";
  // Future kinds: "milestone_share", "recap_followup", "buddy_invite", etc.

const DEFAULT_TTL_HOURS: Record<ReplyExpectationKind, number> = {
  session_feedback: 4,
};

export interface ExpectReplyInput {
  playerId: string;
  kind: ReplyExpectationKind;
  metadata: Record<string, unknown>;
  conversationId: string;
  ttlHours?: number;
}

export interface ActiveExpectation {
  id: string;
  player_id: string;
  kind: ReplyExpectationKind;
  metadata: Record<string, unknown>;
  conversation_id: string;
  created_at: string;
  expires_at: string;
}

/**
 * Record an expectation that the given player will reply to a recent
 * outbound message. Idempotent against the per-kind unique index: if an
 * active expectation already exists for the same dedupe key, the existing
 * one is returned and no new row is created.
 *
 * Throws if the database call fails for reasons other than the dedupe
 * conflict; callers should surface the error.
 */
export async function expectReply(
  input: ExpectReplyInput,
): Promise<{ id: string; deduped: boolean }> {
  const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS[input.kind];
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("reply_expectations")
    .insert({
      player_id: input.playerId,
      kind: input.kind,
      metadata: input.metadata,
      conversation_id: input.conversationId,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error) {
    // Dedupe conflict: the partial unique index rejected the insert because
    // an active expectation already exists for this (player, kind, dedupe key).
    // Look it up and return its id so the caller can proceed idempotently.
    if (error.code === "23505") {
      const existing = await findActiveExpectation(input.playerId, input.kind);
      if (existing) return { id: existing.id, deduped: true };
    }
    throw error;
  }

  return { id: data!.id, deduped: false };
}

/**
 * Look up the most recent active (unresolved, unexpired) expectation for
 * this player. If `kind` is provided, restricts to that kind. Returns null
 * if no active expectation exists.
 */
export async function findActiveExpectation(
  playerId: string,
  kind?: ReplyExpectationKind,
): Promise<ActiveExpectation | null> {
  let query = supabase
    .from("reply_expectations")
    .select("id, player_id, kind, metadata, conversation_id, created_at, expires_at")
    .eq("player_id", playerId)
    .is("resolved_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1);

  if (kind) query = query.eq("kind", kind);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as ActiveExpectation | null) ?? null;
}

/**
 * Mark an expectation as resolved. Resolution must be one of:
 *   - 'matched'    — a reply was received and successfully handled
 *   - 'expired'    — TTL passed without a reply (set by sweeper job)
 *   - 'superseded' — a newer expectation of the same kind replaced this one
 */
export async function resolveExpectation(
  id: string,
  resolution: "matched" | "expired" | "superseded",
): Promise<void> {
  const { error } = await supabase
    .from("reply_expectations")
    .update({
      resolved_at: new Date().toISOString(),
      resolution,
    })
    .eq("id", id)
    .is("resolved_at", null); // don't overwrite an already-resolved row

  if (error) throw error;
}
