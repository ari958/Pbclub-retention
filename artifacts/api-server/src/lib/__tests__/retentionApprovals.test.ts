import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCandidateStatusFilter,
  decorateApprovalCandidates,
  parseApprovalListStatus,
} from "../retentionApprovals.js";
import type { RetentionCandidate } from "../retentionTypes.js";

test("approval list status accepts all supported filters and defaults to all", () => {
  for (const status of ["all", "drafted", "approved", "skipped", "sent", "needs_context", "manual_edit"] as const) {
    assert.deepEqual(parseApprovalListStatus(status), { success: true, data: status });
  }
  assert.deepEqual(parseApprovalListStatus(undefined), { success: true, data: "all" });
});

test("invalid approval list status is rejected and never added as a database filter", () => {
  const parsed = parseApprovalListStatus("queued");
  assert.equal(parsed.success, false);

  let filtered = false;
  const query = { eq: () => { filtered = true; return query; } };
  assert.equal(applyCandidateStatusFilter(query, "all"), query);
  assert.equal(filtered, false);
});

test("selected history status is applied to the candidate query", () => {
  for (const status of ["drafted", "approved", "skipped", "sent", "needs_context", "manual_edit"] as const) {
    let actual: [string, string] | null = null;
    const query = { eq: (column: string, value: string) => { actual = [column, value]; return query; } };
    applyCandidateStatusFilter(query, status);
    assert.deepEqual(actual, ["status", status]);
  }
});

test("candidate counters include both fail-closed review states", async () => {
  const { CANDIDATE_STATUSES } = await import("../retentionApprovals.js");
  assert.ok(CANDIDATE_STATUSES.includes("needs_context"));
  assert.ok(CANDIDATE_STATUSES.includes("manual_edit"));
});

test("sent history preserves the candidate and joined message send details", () => {
  const candidate = {
    id: "candidate-sent",
    club_id: "club-1",
    player_id: "player-1",
    playbook_key: "attendance",
    trigger_event_id: "event-1",
    context: { player_first_name: "Sam" },
    status: "sent",
    message_id: "message-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  } as RetentionCandidate;
  const sentAt = "2026-01-02T12:30:00.000Z";
  const result = decorateApprovalCandidates(
    [candidate],
    new Map([["player-1", { name: "Sam Player" }]]),
    new Map([["message-1", {
      id: "message-1",
      body: "Thanks for joining us.",
      status: "sent",
      approved_at: "2026-01-01T10:00:00.000Z",
      approved_by: "Coach",
      scheduled_send_at: "2026-01-02T12:00:00.000Z",
      sent_at: sentAt,
      simulated: true,
    }]]),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].status, "sent");
  assert.equal(result[0].player?.name, "Sam Player");
  assert.equal(result[0].message?.sent_at, sentAt);
  assert.equal(result[0].message?.body, "Thanks for joining us.");
  assert.equal((result[0].message as { simulated?: boolean }).simulated, true);
});
