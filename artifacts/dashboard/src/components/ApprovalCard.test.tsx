import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./ApprovalCard";
import type { Candidate } from "../lib/retentionApi";

// The direct tsx test runner uses classic JSX; Vite supplies the automatic runtime.
Object.assign(globalThis, { React });

for (const step of [1, 2] as const) {
  test(`step ${step} time-change card requires regeneration and reapproval`, () => {
    const candidate = {
      id: "fixture", playbook_key: "ltp_followup", status: "drafted", step,
      sequence_status: "active", player: { name: "Operator Fixture" },
      context: {
        variant: "with_program", reason: "session_changed",
        player_first_name: "Operator",
        trigger: { name: "Learn to Play", date: "2026-09-27" },
        session_change: {
          reason: "start_time_changed",
          old_start_time: "2026-10-04T14:30:00.000Z",
          new_start_time: "2026-10-04T18:00:00.000Z",
        },
      },
      message: { body: "Reviewed old session time" },
    } as Candidate;
    const noop = () => {};
    const html = renderToStaticMarkup(React.createElement(ApprovalCard, {
      c: candidate, busy: false, selected: false, regenerating: false,
      reshuffling: false, sequenceSchemaReady: true, retryContextReady: true,
      onToggle: noop, onSave: async () => true, onApprove: noop, onSkip: noop,
      onRegenerate: noop, onEditingChange: noop, onRetryContext: noop,
      onReshuffle: noop, onLtpBatchRegenerate: noop,
    }));
    assert.ok(html.includes("Session time changed, regenerate before approving"));
    assert.ok(html.includes("Sunday, Oct 4 at 10:30am"));
    assert.ok(html.includes("Sunday, Oct 4 at 2:00pm"));
    assert.ok(html.includes('data-testid="button-regenerate-session-fixture"'));
    assert.match(html.match(/<button[^>]*data-testid="button-approve-fixture"[^>]*>/)?.[0] ?? "", /disabled/);
    assert.ok(!html.includes("This pre-sequence draft"));
  });
}