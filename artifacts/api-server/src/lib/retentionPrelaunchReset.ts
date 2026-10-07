/**
 * This is only a preselection check. The database repeats the evidence checks
 * under player/sequence/message locks before superseding an archived candidate.
 * A generic skip, simulation, approval, or previously delivered sequence is
 * never permission for another first touch.
 */
export function canReplacePrelaunchCandidate(candidate: any, triggerEventId: string): boolean {
  const message = candidate.messages;
  const sequence = candidate.retention_sequences;
  return candidate.status === "skipped"
    && candidate.context?.reason === "pre_launch_reset"
    && candidate.step === 1
    && candidate.trigger_event_id === triggerEventId
    && message?.status === "archived"
    && message.error_message === "pre_launch_reset"
    && message.direction === "outbound"
    && message.simulated === false
    && [
      "approved_at", "approved_by", "approved_body", "scheduled_send_at",
      "sent_at", "dispatch_claimed_at", "dispatch_token", "twilio_message_sid",
      "delivery_status", "delivered_at", "retention_delivery_kind",
    ].every(field => message[field] === null)
    && sequence?.sequence_status === "active"
    && sequence.trigger_event_id === triggerEventId
    && [
      "step1_sent_at", "step1_message_id", "step1_delivery_kind",
      "step2_sent_at", "step2_message_id", "exited_at", "exit_reason",
    ].every(field => sequence[field] === null);
}
