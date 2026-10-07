// Isolated browser fixture. Never use this as a production entrypoint.
// Uses the real login/gating middleware and built dashboard, but never DB writes/providers.
export {};
process.env.NODE_ENV = "production";
process.env.RUN_BACKGROUND_JOBS = "false";
process.env.SMS_LIVE = "false";
process.env.SMS_TEST_OVERRIDE_TO = "+15551234567";
process.env.OPERATOR_PASSWORD = "offline-browser-fixture-password";
const { supabase } = await import("../lib/supabaseClient");
const club = { id: "c8976e15-e002-4619-bb4b-b1a70f5cd7ab", slug: "pb-club", name: "PB Club", sms_kill_switch: false, timezone: "America/New_York" };
(supabase as any).from = (table: string) => {
  let one = false;
  const query: any = new Proxy({}, { get(_target, key) {
    if (key === "insert" || key === "update" || key === "upsert" || key === "delete") {
      return () => { throw new Error("Writes forbidden in operator browser fixture"); };
    }
    const result = () => ({ data: table === "clubs" ? (one ? club : [club]) : one ? null : [], error: null, count: 0 });
    if (key === "maybeSingle" || key === "single") return async () => { one = true; return result(); };
    if (key === "then") return (yes: any, no: any) => Promise.resolve(result()).then(yes, no);
    return () => query;
  } });
  return query;
};
(supabase as any).rpc = async (name: string) => {
  if (name === "retention_sequence_ready") return { data: true, error: null };
  throw new Error(`RPC forbidden in operator browser fixture: ${name}`);
};
const { default: app } = await import("../app");
app.listen(8099, "0.0.0.0");
