import assert from "node:assert/strict";
import { after, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import twilio from "twilio";
import { operatorRouter, requireOperator, requireSameOrigin } from "../operatorAuth";
import { validateTwilioWebhook } from "../twilioWebhook";
import { backgroundJobsEnabled, setBackgroundWorkerLeader } from "../backgroundPolicy";
import { withBackgroundLock } from "../backgroundLock";

const old = { password: process.env.OPERATOR_PASSWORD, url: process.env.PUBLIC_API_URL,
  twilio: process.env.TWILIO_AUTH_TOKEN, jobs: process.env.RUN_BACKGROUND_JOBS };
const password = "offline-operator-fixture-password";
process.env.OPERATOR_PASSWORD = password;
process.env.PUBLIC_API_URL = "https://operator.example";
process.env.TWILIO_AUTH_TOKEN = "offline-signature-fixture";
process.env.RUN_BACKGROUND_JOBS = "false";
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/api/operator", operatorRouter);
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
app.post("/api/messages/webhook/inbound", validateTwilioWebhook, (_req, res) => res.send("<Response/>"));
app.use(requireOperator, requireSameOrigin);
app.get("/dashboard/", (_req, res) => res.send("protected dashboard"));
app.get("/dashboard/assets/app.js", (_req, res) => res.send("protected asset"));
app.post("/api/approve", (req, res) => res.json(req.body));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init });
let cookie: string;

test("everything except health and login is gated, including JS assets", async () => {
  assert.equal((await request("/api/healthz")).status, 200);
  assert.equal((await request("/api/operator/login")).status, 200);
  for (const path of ["/dashboard/", "/dashboard/assets/app.js", "/api/approve"]) {
    assert.equal((await request(path)).status, 401);
  }
});
test("wrong password is refused; login sets secure httpOnly SameSite cookie", async () => {
  assert.equal((await request("/api/operator/login", { method: "POST",
    body: new URLSearchParams({ password: "wrong" }) })).status, 401);
  const response = await request("/api/operator/login", { method: "POST",
    body: new URLSearchParams({ password, label: "Offline operator" }) });
  assert.equal(response.status, 303);
  const setCookie = response.headers.get("set-cookie")!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(";")[0];
  assert.equal((await request("/dashboard/assets/app.js", { headers: { cookie } })).status, 200);
});
test("audit identity comes from the authenticated session, not a claimed approver", async () => {
  const response = await request("/api/approve", { method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ approved_by: "forged approver", expected_body: "reviewed body" }) });
  const body = await response.json() as { approved_by: string; expected_body: string; actor?: string };
  assert.match(body.approved_by, /^operator:[0-9a-f]{12} \(Offline operator\)$/);
  assert.equal(body.expected_body, "reviewed body");
  assert.equal(body.actor, undefined);
});
test("cross-origin mutation is blocked", async () => {
  assert.equal((await request("/api/approve", { method: "POST",
    headers: { cookie, Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
});
test("Twilio signature uses canonical PUBLIC_API_URL, including query string", async () => {
  const path = "/api/messages/webhook/inbound?test=1";
  const params = { From: "+15551234567", Body: "STOP" };
  const post = { method: "POST", body: new URLSearchParams(params) };
  assert.equal((await request(path, post)).status, 403);
  const signature = twilio.getExpectedTwilioSignature("offline-signature-fixture", `https://operator.example${path}`, params);
  assert.equal((await request(path, { ...post, headers: { "X-Twilio-Signature": signature } })).status, 200);
  const wrongHostSignature = twilio.getExpectedTwilioSignature("offline-signature-fixture", `${base}${path}`, params);
  assert.equal((await request(path, { ...post, headers: { "X-Twilio-Signature": wrongHostSignature } })).status, 403);
});
test("logout revokes the session, not just the browser cookie", async () => {
  assert.equal((await request("/api/operator/logout", { method: "POST", headers: { cookie } })).status, 303);
  assert.equal((await request("/dashboard/assets/app.js", { headers: { cookie } })).status, 401);
});
test("login is rate limited", async () => {
  let status = 0;
  for (let i = 0; i < 6; i++) status = (await request("/api/operator/login", {
    method: "POST", body: new URLSearchParams({ password: "wrong" }),
  })).status;
  assert.equal(status, 429);
});
test("RUN_BACKGROUND_JOBS is opt-in and requires exact true", () => {
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  for (const value of [undefined, "", "false", "TRUE", "1"]) {
    if (value === undefined) delete process.env.RUN_BACKGROUND_JOBS;
    else process.env.RUN_BACKGROUND_JOBS = value;
    assert.equal(backgroundJobsEnabled(), false);
  }
  process.env.RUN_BACKGROUND_JOBS = "true";
  const scheduler = process.env.SCHEDULER_ENABLED;
  try {
    setBackgroundWorkerLeader(true);
    delete process.env.SCHEDULER_ENABLED;
    assert.equal(backgroundJobsEnabled(), false, "production without the SCHEDULER_ENABLED kill switch stays off");
    process.env.SCHEDULER_ENABLED = "true";
    setBackgroundWorkerLeader(false);
    assert.equal(backgroundJobsEnabled(), false, "configured standby must not start jobs");
    setBackgroundWorkerLeader(true);
    assert.equal(backgroundJobsEnabled(), true);
    process.env.NODE_ENV = "development";
    assert.equal(backgroundJobsEnabled(), false);
  } finally {
    process.env.NODE_ENV = nodeEnv;
    if (scheduler === undefined) delete process.env.SCHEDULER_ENABLED;
    else process.env.SCHEDULER_ENABLED = scheduler;
    setBackgroundWorkerLeader(false);
    process.env.RUN_BACKGROUND_JOBS = "false";
  }
});
test("job lock refuses overlap, releases after errors, and fails closed on unavailable RPC", async () => {
  let held = false;
  const client: any = { rpc: async (name: string) => {
    if (name.includes("acquire")) {
      if (held) return { data: false, error: null };
      held = true;
    } else if (name.includes("release")) held = false;
    return { data: true, error: null };
  } };
  let unblock!: () => void;
  const wait = new Promise<void>((resolve) => { unblock = resolve; });
  const first = withBackgroundLock("queue", () => wait, client);
  await new Promise((resolve) => setImmediate(resolve));
  let ran = false;
  assert.equal((await withBackgroundLock("queue", async () => { ran = true; }, client)).acquired, false);
  assert.equal(ran, false);
  unblock();
  await first;
  await assert.rejects(withBackgroundLock("queue", async () => { throw new Error("fixture failure"); }, client));
  assert.equal(held, false);
  await assert.rejects(withBackgroundLock("queue", async () => { ran = true; },
    { rpc: async () => ({ data: null, error: { message: "missing migration" } }) } as any), /missing migration/);
});
after(() => {
  server.close();
  for (const [key, value] of Object.entries({ OPERATOR_PASSWORD: old.password, PUBLIC_API_URL: old.url,
    TWILIO_AUTH_TOKEN: old.twilio, RUN_BACKGROUND_JOBS: old.jobs })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
