import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyStoredLtpDestinations } from "../ltpTestDestinations";
import { ltpTestRpc } from "../ltpTestTools";
import { supabase } from "../supabaseClient";

const one = { id: "one", status: "sent", sent_at: "2026-10-01T00:00:00Z", twilio_message_sid: "SMone" };
test("clock refuses absent override, real destination, incomplete evidence, or any mismatched later message", async () => {
  let calls = 0;
  const read = async (sid: string) => { calls++; return { sid, to: sid === "SMone" ? "+12015550100" : "+12015550101" }; };
  await assert.rejects(verifyStoredLtpDestinations([one], "", read), /required/);
  assert.equal(calls, 0);
  await assert.rejects(verifyStoredLtpDestinations([one], "+12015550199", read), /Every sent/);
  await assert.rejects(verifyStoredLtpDestinations([one, { ...one, id: "two", twilio_message_sid: "SMtwo" }], "+12015550100", read), /Every sent/);
  await assert.rejects(verifyStoredLtpDestinations([{ ...one, twilio_message_sid: null }], "+12015550100", read), /incomplete/);
  assert.deepEqual(await verifyStoredLtpDestinations([one], "+1 (201) 555-0100", read),
    [{ message_id: "one", twilio_message_sid: "SMone", to: "+12015550100" }]);
  await assert.rejects(verifyStoredLtpDestinations([one], "+12015550100", async () => { throw new Error("unavailable"); }), /unavailable/);
});

test("backdate refusal resolves the sequence for audit but never invokes a mutation RPC without override", async () => {
  const from = supabase.from, rpc = supabase.rpc, override = process.env.SMS_TEST_OVERRIDE_TO;
  try {
    delete process.env.SMS_TEST_OVERRIDE_TO;
    supabase.from = (() => {
      const query: any = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: { sequence_id: "sequence" }, error: null }) };
      return query;
    }) as typeof from;
    supabase.rpc = (() => { throw new Error("Mutation RPC must not run"); }) as typeof rpc;
    await assert.rejects(ltpTestRpc("backdate", "club", { candidate_id: "candidate", actor: "Fixture operator" }),
      (error: any) => error.status === 403);
  } finally {
    supabase.from = from; supabase.rpc = rpc;
    if (override === undefined) delete process.env.SMS_TEST_OVERRIDE_TO; else process.env.SMS_TEST_OVERRIDE_TO = override;
  }
});
