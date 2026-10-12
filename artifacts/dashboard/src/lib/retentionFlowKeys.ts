/**
 * Flow-kind helpers with no imports, so pure helpers and tests can use them
 * without loading the API client (which reads Vite env at import time).
 */
export interface FlowPlaybookFields {
  flow_kind?: "single" | "sequence";
}

/** The Learn to Play flow. Only the LTP-specific test tools and reports name it directly. */
export const LTP_FOLLOWUP_KEY = "ltp_followup";

export function isSequencePlaybook(playbook: FlowPlaybookFields | null | undefined): boolean {
  return playbook?.flow_kind === "sequence";
}
