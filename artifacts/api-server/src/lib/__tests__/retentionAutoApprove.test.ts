import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_APPROVER,
  autoApproveConfigured,
  autoApproveDailyCap,
  autoApproveRetentionDrafts,
  autoSendTime,
  etWallClock,
  type AutoApproveDeps,
} from "../retentionAutoApprove";
import type { RetentionCandidate } from "../retentionTypes";

const draft = (id: string, messageId: string | null = `m-${id}`) =>
  ({ id, message_id: messageId, status: "drafted", playbook_key: "ltp_followup", context: { send_date_et: "2026-11-24" } }) as unknown as RetentionCandidate;

function deps(over: Partial<AutoApproveDeps> = {}) {
  const calls: { id: string; by: string; body: string; at: string }[] = [];
  const d: AutoApproveDeps = {
    enabled: () => true,
    dailyCap: () => 25,
    killSwitchOff: async () => true,
    countApprovedToday: async () => 0,
    loadDrafts: async () => [draft("a"), draft("b")],
    loadBody: async (id) => `body for ${id}`,
    approve: async (_club, c, by, body, at) => { calls.push({ id: c.id, by, body, at: at.toISOString() }); return {}; },
    sendTime: () => ({ hour: 15, minute: 0 }),
    now: () => new Date("2026-11-24T08:00:00Z"),
    ...over,
  };
  return { d, calls };
}

test("does nothing when disabled", async () => {
  const { d, calls } = deps({ enabled: () => false });
  const r = await autoApproveRetentionDrafts("club", "ltp_followup", d);
  assert.equal(r.status, "disabled");
  assert.equal(calls.length, 0);
});

test("does nothing when the kill switch is on", async () => {
  const { d, calls } = deps({ killSwitchOff: async () => false });
  const r = await autoApproveRetentionDrafts("club", "ltp_followup", d);
  assert.equal(r.status, "kill_switch_on");
  assert.equal(calls.length, 0);
});

test("approves drafts with the stored body as the auto-approver", async () => {
  const { d, calls } = deps();
  const r = await autoApproveRetentionDrafts("club", "ltp_followup", d);
  assert.deepEqual(r.approved, ["a", "b"]);
  assert.deepEqual(calls, [
    { id: "a", by: AUTO_APPROVER, body: "body for m-a", at: "2026-11-24T20:00:00.000Z" },
    { id: "b", by: AUTO_APPROVER, body: "body for m-b", at: "2026-11-24T20:00:00.000Z" },
  ]);
});

test("holds drafts over the daily cap, counting earlier approvals today", async () => {
  const { d, calls } = deps({
    dailyCap: () => 3,
    countApprovedToday: async () => 2,
    loadDrafts: async () => [draft("a"), draft("b"), draft("c")],
  });
  const r = await autoApproveRetentionDrafts("club", "ltp_followup", d);
  assert.deepEqual(r.approved, ["a"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(r.held.map((h) => h.candidate_id), ["b", "c"]);
  assert.match(r.held[0].reason, /cap of 3/);
});

test("a draft that fails a check is held and does not use up the cap", async () => {
  const { d } = deps({
    dailyCap: () => 1,
    loadDrafts: async () => [draft("bad"), draft("good"), draft("none", null)],
    approve: async (_c, cand) => { if (cand.id === "bad") throw new Error("text rule failed"); return {}; },
  });
  const r = await autoApproveRetentionDrafts("club", "ltp_followup", d);
  assert.deepEqual(r.approved, ["good"]);
  assert.deepEqual(r.held, [
    { candidate_id: "bad", reason: "text rule failed" },
    { candidate_id: "none", reason: "Daily auto-approve cap of 1 reached" },
  ]);
});

test("empty bodies and missing messages are held", async () => {
  const { d, calls } = deps({
    loadDrafts: async () => [draft("x", null), draft("y")],
    loadBody: async () => "  ",
  });
  const r = await autoApproveRetentionDrafts("club", "ltp_followup", d);
  assert.equal(calls.length, 0);
  assert.equal(r.held.length, 2);
});

test("config parsing", () => {
  assert.equal(autoApproveConfigured({} as NodeJS.ProcessEnv), false);
  assert.equal(autoApproveConfigured({ RETENTION_AUTO_APPROVE: "true" } as NodeJS.ProcessEnv), true);
  assert.equal(autoApproveConfigured({ RETENTION_AUTO_APPROVE: "1" } as NodeJS.ProcessEnv), false);
  assert.equal(autoApproveDailyCap({} as NodeJS.ProcessEnv), 25);
  assert.equal(autoApproveDailyCap({ RETENTION_AUTO_APPROVE_DAILY_CAP: "10" } as NodeJS.ProcessEnv), 10);
  assert.equal(autoApproveDailyCap({ RETENTION_AUTO_APPROVE_DAILY_CAP: "abc" } as NodeJS.ProcessEnv), 25);
});

test("schedules for 3pm ET across daylight saving", () => {
  assert.equal(etWallClock("2026-11-24", 15, 0).toISOString(), "2026-11-24T20:00:00.000Z");
  assert.equal(etWallClock("2026-07-01", 15, 0).toISOString(), "2026-07-01T19:00:00.000Z");
  assert.deepEqual(autoSendTime({} as NodeJS.ProcessEnv), { hour: 15, minute: 0 });
  assert.deepEqual(autoSendTime({ RETENTION_AUTO_SEND_TIME: "10:30" } as NodeJS.ProcessEnv), { hour: 10, minute: 30 });
  assert.deepEqual(autoSendTime({ RETENTION_AUTO_SEND_TIME: "21:00" } as NodeJS.ProcessEnv), { hour: 15, minute: 0 });
});

test("holds a draft when 3pm on its send date has already passed", async () => {
  const { d, calls } = deps({ now: () => new Date("2026-11-24T21:00:00Z") });
  const r = await autoApproveRetentionDrafts("club", "ltp_followup", d);
  assert.equal(calls.length, 0);
  assert.match(r.held[0].reason, /15:00 ET send time on 2026-11-24 has passed/);
});
