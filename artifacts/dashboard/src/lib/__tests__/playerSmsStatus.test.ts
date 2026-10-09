import assert from "node:assert/strict";
import { test } from "node:test";
import { playerSmsStatusLabel } from "../playerSmsStatus";
import type { PlayerSmsStatus } from "@workspace/api-client-react";

const status: PlayerSmsStatus = {
  status: "opted_out", opted_out: true, sms_opt_in: false,
  latest_optout_event: { occurred_at: "2026-10-09T00:15:00Z", source: "stop_reply", twilio_optout_type: "STOP" },
};

test("player SMS labels: flags win over history; club-local dates and all opt-out sources", () => {
  assert.equal(playerSmsStatusLabel(status, "America/New_York"), "Opted out (Oct 8, 2026, STOP reply)");
  assert.equal(playerSmsStatusLabel({ ...status, status: "active", opted_out: false, sms_opt_in: true }, "America/New_York"), "Active");
  for (const [source, label] of [["manual", "Manual"], ["carrier_21610", "Carrier (21610)"]] as const) {
    assert.equal(playerSmsStatusLabel({ ...status, latest_optout_event: {
      occurred_at: null, source, twilio_optout_type: null,
    } }, "America/New_York"), `Opted out (date unknown, ${label})`);
  }
  assert.equal(playerSmsStatusLabel({ ...status, latest_optout_event: null }, "America/New_York"), "Opted out (date unknown, source unknown)");
  assert.equal(playerSmsStatusLabel({ ...status, status: "unknown", opted_out: null, sms_opt_in: null }, "America/New_York"), "Unknown");
});
