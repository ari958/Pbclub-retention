import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { APPROVAL_KEY_HEADER, approvalKeyRouteAllowed, checkApprovalKey, parseSendTimeEt } from "../approvalKey";

const KEY = "k".repeat(40);
const req = (method: string, path: string, header?: string) => ({
  method, path, get: (name: string) => (name.toLowerCase() === APPROVAL_KEY_HEADER ? header : undefined),
}) as any;
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("only list, approve and skip are reachable with the key", () => {
  assert.equal(approvalKeyRouteAllowed("GET", "/api/retention/approvals"), true);
  assert.equal(approvalKeyRouteAllowed("POST", `/api/retention/candidates/${ID}/approve`), true);
  assert.equal(approvalKeyRouteAllowed("POST", `/api/retention/candidates/${ID}/skip`), true);
  for (const [method, path] of [
    ["POST", "/api/retention/kill-switch"], ["POST", "/api/retention/playbooks/ltp_followup/approve"],
    ["POST", `/api/retention/candidates/${ID}/edit`], ["GET", "/api/players"], ["POST", "/api/messages/send"],
    ["GET", `/api/retention/candidates/${ID}/approve`], ["POST", "/api/retention/candidates/x/approve"],
    ["POST", "/dashboard/api/retention/approvals"], ["POST", "/api/retention/winback/run"],
  ]) assert.equal(approvalKeyRouteAllowed(method, path), false, `${method} ${path}`);
});

test("key checks: absent, disabled, invalid, wrong route, ok", () => {
  assert.equal(checkApprovalKey(req("GET", "/api/retention/approvals"), KEY), "absent");
  assert.equal(checkApprovalKey(req("GET", "/api/retention/approvals", KEY), undefined), "disabled");
  assert.equal(checkApprovalKey(req("GET", "/api/retention/approvals", "short"), "short"), "disabled", "keys under 32 chars are refused");
  assert.equal(checkApprovalKey(req("GET", "/api/retention/approvals", `${KEY}x`), KEY), "invalid");
  assert.equal(checkApprovalKey(req("POST", "/api/retention/kill-switch", KEY), KEY), "route_not_allowed");
  assert.equal(checkApprovalKey(req("GET", "/api/retention/approvals", KEY), KEY), "ok");
});

test("send time must be HH:MM inside 8:30am-7:30pm", () => {
  assert.deepEqual(parseSendTimeEt("14:00"), { hour: 14, minute: 0 });
  assert.deepEqual(parseSendTimeEt("8:30"), { hour: 8, minute: 30 });
  for (const bad of ["7:59", "19:31", "2pm", "14:75", "", "24:00"]) assert.equal(parseSendTimeEt(bad), null, bad);
});

test("the app refuses wrong keys and other routes before any handler runs", async () => {
  process.env.RETENTION_APPROVAL_KEY = KEY;
  const { default: app } = await import("../../app");
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, path: string, key?: string) => fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json", ...(key ? { [APPROVAL_KEY_HEADER]: key } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.equal((await call("GET", "/api/retention/approvals", "wrong-key-wrong-key-wrong-key-xx")).status, 401);
    assert.equal((await call("POST", "/api/retention/kill-switch", KEY)).status, 403);
    assert.equal((await call("GET", "/api/players", KEY)).status, 403);
    assert.equal((await call("GET", "/api/retention/approvals")).status, 401, "no key and no login");
  } finally {
    server.close();
    delete process.env.RETENTION_APPROVAL_KEY;
  }
});
