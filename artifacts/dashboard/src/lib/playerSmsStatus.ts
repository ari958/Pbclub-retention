import type { PlayerSmsStatus } from "@workspace/api-client-react";

const sources: Record<string, string> = {
  stop_reply: "STOP reply",
  carrier_21610: "Carrier (21610)",
  manual: "Manual",
};

export function playerSmsStatusLabel(status: PlayerSmsStatus, timezone: string): string {
  if (status.status === "active") return "Active";
  if (status.status === "unknown") return "Unknown";
  const event = status.latest_optout_event;
  let date = "date unknown";
  if (event?.occurred_at && Number.isFinite(Date.parse(event.occurred_at))) {
    date = new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: timezone,
    }).format(new Date(event.occurred_at));
  }
  return `Opted out (${date}, ${event ? sources[event.source] ?? "source unknown" : "source unknown"})`;
}
