import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { supabase } from "../../lib/supabaseClient.js";
import messagesRouter from "../messages.js";

const originalFrom = (supabase as any).from;
const originalRpc = (supabase as any).rpc;
const originalNodeEnv = process.env.NODE_ENV;
const PLAYER_ID = "00000000-0000-4000-8000-000000000002";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000001";
const CLUB_ID = "00000000-0000-4000-8000-000000000003";
const state: {
  player: any;
  message: any;
  transitionError: { message: string } | null;
  transitionCalls: any[];
} = {
  player: {},
  message: {},
  transitionError: null,
  transitionCalls: [],
};

function queryFor(table: string) {
  let operation = "select";
  let values: any;
  const query: any = {
    select() { return query; },
    update(next: any) { operation = "update"; values = next; return query; },
    eq() { return query; },
    is() { return query; },
    in() { return query; },
    or() { return query; },
    limit() { return query; },
    maybeSingle() { return Promise.resolve(resolve()); },
    then(onFulfilled: any, onRejected: any) { return Promise.resolve(resolve()).then(onFulfilled, onRejected); },
  };

  function resolve() {
    if (table === "players" && operation === "select") return { data: state.player, error: null };
    if (table === "players" && operation === "update") {
      state.player = { ...state.player, ...values };
      return { data: state.player, error: null };
    }
    if (table === "messages" && operation === "select") return { data: state.message, error: null };
    if (table === "messages" && operation === "update") {
      state.message = { ...state.message, ...values };
      return { data: [state.message], error: null };
    }
    if (table === "conversations") return { data: [], error: null };
    return { data: null, error: null };
  }

  return query;
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => {
  (req as any).log = { info() {}, warn() {}, error() {} };
  next();
});
app.use("/api", messagesRouter);
let server: ReturnType<typeof app.listen> | undefined;
let baseUrl = "";

function reset() {
  state.player = {
    id: PLAYER_ID,
    name: "Test Player",
    phone: "+15551234567",
    club_id: CLUB_ID,
    opted_out: false,
    sms_opt_in: true,
  };
  state.message = {
    id: MESSAGE_ID,
    player_id: PLAYER_ID,
    conversation_id: null,
    twilio_message_sid: "SM-optout-test",
    status: "sent",
  };
  state.transitionError = null;
  state.transitionCalls = [];
}

before(async () => {
  process.env.NODE_ENV = "test";
  (supabase as any).from = (table: string) => queryFor(table);
  (supabase as any).rpc = async (name: string, args: any) => {
    if (name === "capture_sms_inbound") {
      state.player = { ...state.player, opted_out: true, sms_opt_in: false };
      state.transitionCalls.push({ p_status: "exited_opt_out" });
      return { data: {
        id: MESSAGE_ID, club_id: CLUB_ID, player_id: PLAYER_ID, match_reason: "matched", kind: "stop",
        processed_at: state.transitionError ? null : new Date().toISOString(),
        processing_error: state.transitionError?.message ?? null,
      }, error: null };
    }
    if (name === "retention_sequence_transition") {
      state.transitionCalls.push(args);
      if (state.transitionError) return { data: null, error: state.transitionError };
      return { data: { sequence_status: args.p_status }, error: null };
    }
    return { data: true, error: null };
  };
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (address && typeof address === "object") baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  }
  (supabase as any).from = originalFrom;
  (supabase as any).rpc = originalRpc;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

test("undelivered status callback with Twilio 21610 permanently opts out and exits LTP", async () => {
  reset();
  const response = await fetch(`${baseUrl}/api/messages/webhook/status`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      MessageSid: "SM-optout-test",
      MessageStatus: "undelivered",
      ErrorCode: "21610",
      ErrorMessage: "The message recipient has opted out",
    }),
  });

  assert.equal(response.status, 204);
  assert.equal(state.message.status, "undelivered");
  assert.equal(state.player.opted_out, true);
  assert.equal(state.player.sms_opt_in, false);
  assert.equal(state.transitionCalls[0]?.p_status, "exited_opt_out");
  assert.equal(state.transitionCalls[0]?.p_reason, "twilio_error_21610");
});

test("STOP reports transition failure after persisting the permanent player opt-out", async () => {
  reset();
  state.transitionError = { message: "sequence RPC unavailable" };
  const response = await fetch(`${baseUrl}/api/messages/webhook/inbound`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: state.player.phone, To: "+15557654321",
      MessageSid: "SM00000000000000000000000000000001", Body: "STOP" }),
  });

  assert.equal(response.status, 503);
  assert.equal(state.player.opted_out, true);
  assert.equal(state.player.sms_opt_in, false);
  assert.match(await response.text(), /STOP was saved.*retry required/);
  assert.equal(state.transitionCalls[0]?.p_status, "exited_opt_out");
});