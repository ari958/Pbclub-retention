import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertRetentionDraftFresh, retentionRebuildLookbackDays } from "../retentionFreshness";
import { isRetentionTriggerDate } from "../retentionDates";
import { addCalendarDays, toEtDate } from "../retentionDates";
import { regenerateLtpCandidateBatch } from "../retentionEngine";
import { supabase } from "../supabaseClient";

test("live rebuilding discards the historical test window, including after override removal", () => {
  for (const savedDays of [3, 7, 14, 30]) {
    for (const override of ["", "  ", undefined]) {
      // Explicit empty value isolates this test from inherited environment.
      assert.equal(retentionRebuildLookbackDays({ lookback_days: savedDays, stale: true }, override ?? ""), 3);
    }
  }
  assert.equal(retentionRebuildLookbackDays({ stale: true }, ""), 3);
});

test("explicit redirected tests retain their historical window and never silently become live drafts", () => {
  for (const savedDays of [7, 14, 30]) {
    const days = retentionRebuildLookbackDays({ lookback_days: savedDays, stale: true }, "+15555550100");
    assert.equal(days, savedDays);
    assert.throws(() => assertRetentionDraftFresh({
      context: { lookback_days: days, stale: days > 3 },
    }), /Stale retention draft/);
  }
  assert.equal(retentionRebuildLookbackDays({ stale: true }, "+15555550100"), 30);
  assert.throws(() => retentionRebuildLookbackDays({ lookback_days: 4 }, "+15555550100"), RangeError);
});

test("recent attendance can be rebuilt for live review but old or same-day attendance remains ineligible", () => {
  const days = retentionRebuildLookbackDays({ lookback_days: 7, stale: true }, "");
  assert.equal(isRetentionTriggerDate("2026-10-06", "2026-10-08", days), true);
  assert.equal(isRetentionTriggerDate("2026-10-05", "2026-10-08", days), true);
  for (const date of ["2026-10-04", "2026-10-08", "2026-10-09"]) {
    assert.equal(isRetentionTriggerDate(date, "2026-10-08", days), false);
  }
  assert.doesNotThrow(() => assertRetentionDraftFresh({
    context: { lookback_days: days, stale: false, draft_generated_at: "2026-10-08T16:56:33Z" },
  }, new Date("2026-10-08T17:00:00Z")));
});

test("rebuild support does not bypass the old-draft, historical-window, or expiry approval guards", () => {
  const now = new Date("2026-10-08T17:00:00Z");
  for (const context of [
    { lookback_days: 7, stale: false },
    { lookback_days: 3, stale: true },
    { lookback_days: 3, stale: false, draft_generated_at: "2026-10-03T17:00:00Z" },
  ]) {
    assert.throws(() => assertRetentionDraftFresh({ context }, now));
  }
});

test("LTP rebuild verifies live step-1 attendance before context work and preserves step-2's due window", () => {
  const source = readFileSync(new URL("../retentionEngine.ts", import.meta.url), "utf8");
  const batch = source.slice(source.indexOf("async function buildLtpBatchWriteItems("),
    source.indexOf("function optionsNonce("));
  assert.match(batch, /operation === "create"[\s\S]*?: retentionRebuildLookbackDays\(previousContext\)/);
  assert.match(batch, /step === 1 && !isRetentionTriggerDate\(trigger\.date, toEtDate\(sendAt\), lookbackDays\)/);
  assert.ok(batch.indexOf("outside the current") < batch.indexOf("buildRetentionContext("));
  assert.match(batch, /expected_context: selectedOperation === "create" \? null : previousContext/);
});

test("real regeneration entry point rebuilds recent test-window drafts but never approves or sends", async () => {
  for (const age of [2, 6]) {
    const originalFrom = supabase.from;
    const originalRpc = supabase.rpc;
    const originalFetch = globalThis.fetch;
    const originalOverride = process.env.SMS_TEST_OVERRIDE_TO;
    delete process.env.SMS_TEST_OVERRIDE_TO;
    const triggerDate = addCalendarDays(toEtDate(new Date()), -age);
    const candidate: any = {
      id: "00000000-0000-4000-8000-000000000041",
      player_id: "00000000-0000-4000-8000-000000000042",
      club_id: "00000000-0000-4000-8000-000000000043",
      message_id: "00000000-0000-4000-8000-000000000044",
      sequence_id: "00000000-0000-4000-8000-000000000045",
      trigger_event_id: "fixture-trigger",
      playbook_key: "ltp_followup", step: 1, status: "drafted",
      updated_at: new Date().toISOString(),
      context: {
        trigger: { date: triggerDate, name: "Learn to Play", event_id: "fixture-trigger" },
        lookback_days: 7, stale: true,
      },
    };
    const message = { id: candidate.message_id, body: "Previously reviewed fixture draft", status: "pending" };
    const writes: any[] = [];
    const calls: string[] = [];
    try {
      supabase.from = ((table: string) => {
        const q: any = {
          select() { return q; }, eq() { return q; }, in() { return q; },
          maybeSingle() {
            const rows: Record<string, unknown> = {
              players: { id: candidate.player_id, name: "Sam Fixture", external_id: "fixture-player", opted_out: false, sms_opt_in: true },
              messages: message,
              retention_playbooks: { key: "ltp_followup", name: "LTP", enabled: true, promo_code: "LTPNEXT25",
                offer_text: "25% off", next_program_names: [], holdout_pct: 0 },
              clubs: { platform_subdomain: "fixture-only", platform_api_key: "synthetic-key", timezone: "America/New_York" },
            };
            assert.ok(table in rows, `unexpected table ${table}`);
            return Promise.resolve({ data: rows[table], error: null });
          },
          then(resolve: any, reject: any) {
            assert.ok(["retention_candidates", "attendances"].includes(table), `unexpected list ${table}`);
            return Promise.resolve({ data: table === "retention_candidates" ? [candidate] : [], error: null }).then(resolve, reject);
          },
        };
        return q;
      }) as any;
      supabase.rpc = (async (name: string, args: any) => {
        calls.push(name);
        if (name === "retention_sequence_ready") return { data: true, error: null };
        assert.equal(name, "retention_sequence_save_batch", "no approval, claim, or dispatch RPC is allowed");
        writes.push(...args.p_items);
        return { data: [], error: null };
      }) as any;
      globalThis.fetch = (async (input: any) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://fixture-only.podplay.app");
        let payload;
        if (url.pathname.endsWith("/events/fixture-trigger")) {
          payload = { item: { id: "fixture-trigger", name: "Learn to Play", startTime: `${triggerDate}T15:00:00Z` } };
        } else if (url.pathname.includes("/coupons")) {
          payload = { items: [{ code: "LTPNEXT25", active: true, discountType: "PERCENT_OFF", value: 25,
            eligibleType: "EVENT_CLASS", eligibleTypes: ["EVENT_CLASS"], eligibleEventIds: [] }] };
        } else {
          assert.equal(url.pathname, "/apis/v2/events");
          payload = { items: [] };
        }
        return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
      }) as any;
      const result = await regenerateLtpCandidateBatch(candidate.club_id, [candidate.id]);
      assert.equal(result.failures.length, 0);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].context.lookback_days, 3);
      assert.equal(writes[0].context.stale, false);
      assert.equal(writes[0].expected_context.stale, true, "the original test context remains the CAS snapshot");
      if (age === 2) {
        assert.equal(result.results[0].status, "drafted", JSON.stringify(result.results[0].context.errors));
        assert.ok(result.results[0].body);
      } else {
        assert.equal(result.results[0].status, "needs_context");
        assert.equal(result.results[0].body, null);
        assert.match(result.results[0].context.errors!.join(" "), /outside the current 3-day eligibility window/);
      }
      assert.deepEqual(calls, ["retention_sequence_ready", "retention_sequence_save_batch"]);
      assert.equal(message.status, "pending");
    } finally {
      supabase.from = originalFrom;
      supabase.rpc = originalRpc;
      globalThis.fetch = originalFetch;
      if (originalOverride === undefined) delete process.env.SMS_TEST_OVERRIDE_TO;
      else process.env.SMS_TEST_OVERRIDE_TO = originalOverride;
    }
  }
});
