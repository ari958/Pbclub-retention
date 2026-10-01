import assert from "node:assert/strict";
import { test } from "node:test";
import { supabase } from "../../lib/supabaseClient.js";
import messagesRouter from "../messages.js";

const originalRetentionMode = process.env.RETENTION_ONLY_MODE;
const originalSupabaseFrom = (supabase as any).from;

const MESSAGE_ID = "00000000-0000-4000-8000-000000000021";
const PLAYER_ID = "00000000-0000-4000-8000-000000000022";
const CLUB_ID = "00000000-0000-4000-8000-000000000023";

test("manual /messages/send refuses a retention candidate without approval before any message update", async () => {
  process.env.RETENTION_ONLY_MODE = "true";
  const updates: any[] = [];

  (supabase as any).from = (table: string) => {
    let operation = "select";
    let values: any;
    const query: any = {
      select() { return query; },
      update(next: any) { operation = "update"; values = next; updates.push({ table, values }); return query; },
      eq() { return query; },
      maybeSingle() { return Promise.resolve(resolve()); },
      single() { return Promise.resolve(resolve()); },
    };

    function resolve() {
      if (table === "clubs") return { data: { id: CLUB_ID }, error: null };
      if (table === "messages") {
        return {
          data: {
            id: MESSAGE_ID,
            body: "Reviewed message",
            signup_url: null,
            status: "pending",
            conversation_id: null,
            player_id: PLAYER_ID,
            approved_at: "2026-01-01T12:00:00.000Z",
            approved_by: "operator",
            approved_body: "Reviewed message",
            dispatch_claimed_at: null,
            dispatch_token: null,
          },
          error: null,
        };
      }
      if (table === "players") {
        return {
          data: {
            id: PLAYER_ID,
            name: "Player",
            phone: "+15551234567",
            opted_out: false,
            sms_opt_in: true,
            consent_source: "web_form",
            sms_consented_at: "2026-01-01T12:00:00.000Z",
            last_outbound_at: null,
            club_id: CLUB_ID,
          },
          error: null,
        };
      }
      if (table === "retention_candidates") return { data: null, error: null };
      return { data: null, error: null };
    }

    return query;
  };

  try {
    const layer = (messagesRouter as any).stack.find((item: any) => item.route?.path === "/messages/send");
    assert.ok(layer, "manual send route is registered");
    const [clubMiddleware, sendHandler] = layer.route.stack.map((item: any) => item.handle);
    const req: any = {
      method: "POST",
      query: { clubId: CLUB_ID },
      params: {},
      body: { message_id: MESSAGE_ID },
      log: { info() {}, warn() {}, error() {} },
    };
    const res: any = {
      statusCode: 200,
      body: undefined,
      setHeader() {},
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
    };

    await new Promise<void>((resolve, reject) => {
      Promise.resolve(clubMiddleware(req, res, (error?: unknown) => error ? reject(error) : resolve())).catch(reject);
    });
    await sendHandler(req, res);

    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /requires an approved retention candidate/);
    assert.deepEqual(updates, []);
  } finally {
    (supabase as any).from = originalSupabaseFrom;
    if (originalRetentionMode === undefined) delete process.env.RETENTION_ONLY_MODE;
    else process.env.RETENTION_ONLY_MODE = originalRetentionMode;
  }
});