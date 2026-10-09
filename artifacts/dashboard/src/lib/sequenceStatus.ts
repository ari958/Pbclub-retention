import type { Candidate } from "./retentionApi";

export const SEQUENCE_STATUS_LABELS: Record<NonNullable<Candidate["sequence_status"]>, string> = {
  active: "active",
  paused_reply: "paused reply",
  exited_booked: "exited booked",
  exited_opt_out: "exited opt out",
  completed: "completed",
  exited_test: "Closed (test)",
};

export function displaySequenceStatus(status: string | null | undefined): string {
  if (!status) return "sequence unavailable";
  return SEQUENCE_STATUS_LABELS[status as keyof typeof SEQUENCE_STATUS_LABELS]
    ?? status.replaceAll("_", " ");
}
