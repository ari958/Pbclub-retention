import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { canRetryRetentionContext, retryRetentionContextBatch } from "../retentionEngine";
import { supabase } from "../supabaseClient";
import type { RetentionCandidate } from "../retentionTypes";

test("context retry eligibility never includes other review states or reasons", () => {
  for (const status of ["drafted", "approved", "skipped", "sent", "needs_context", "manual_edit"]) {
    for (const reason of ["context_lookup_failed", "no_next_program", "already_returned", "text_generation_failed", null]) {
      assert.equal(canRetryRetentionContext({
        status: status as RetentionCandidate["status"], context: { reason } as RetentionCandidate["context"],
      }), status === "needs_context" && ["context_lookup_failed", "no_next_program"].includes(String(reason)));
    }
  }
});

test("missing retry migration prevents reads, PodPlay calls, model calls, and writes", async () => {
  const originalRpc = supabase.rpc;
  const originalFrom = supabase.from;
  const calls: string[] = [];
  try {
    supabase.rpc = (async (name: string) => {
      calls.push(name);
      return { data: false, error: null };
    }) as any;
    supabase.from = (() => { throw new Error("No table read should happen before readiness"); }) as any;
    await assert.rejects(retryRetentionContextBatch("test-club", ["candidate"]), (error: any) =>
      error.status === 503 && /migration 012/.test(error.message));
    assert.deepEqual(calls, ["retention_context_retry_ready"]);
  } finally {
    supabase.rpc = originalRpc;
    supabase.from = originalFrom;
  }
});

test("batch preflight rejects protected rows before any context work", async () => {
  const originalRpc = supabase.rpc;
  const originalFrom = supabase.from;
  try {
    supabase.rpc = (async () => ({ data: true, error: null })) as any;
    supabase.from = (() => ({
      select() { return this; }, eq() { return this; },
      async in() { return { data: [{ id: "candidate", status: "skipped", context: { reason: "already_returned" } }], error: null }; },
    })) as any;
    await assert.rejects(retryRetentionContextBatch("test-club", ["candidate"]),
      (error: any) => error.status === 409);
  } finally {
    supabase.rpc = originalRpc;
    supabase.from = originalFrom;
  }
});

test("retry migration binds candidate/message/context snapshots without changing approval evidence", () => {
  const sql = fs.readFileSync(new URL("../../../migrations/012_retention_context_retry.sql", import.meta.url), "utf8");
  assert.match(sql, /c\.status IS DISTINCT FROM 'needs_context'/);
  assert.match(sql, /'context_lookup_failed','no_next_program'/);
  for (const snapshot of ["p_expected_context", "p_expected_updated_at", "p_expected_message_id", "p_expected_body"]) {
    assert.match(sql, new RegExp(`IS DISTINCT FROM ${snapshot}`));
  }
  for (const field of ["approved_at", "approved_by", "approved_body", "scheduled_send_at", "sent_at", "dispatch_claimed_at"]) {
    assert.match(sql, new RegExp(`m\\.${field} IS NOT NULL`));
  }
  assert.match(sql, /FOR UPDATE/);
  assert.doesNotMatch(sql, /SET\s+(?:approved_at|approved_by|approved_body|scheduled_send_at|sent_at)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.retention_retry_context/);
  assert.match(sql, /TO service_role/);
});