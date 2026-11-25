import test from "node:test";
import assert from "node:assert/strict";
import { composeReplyAlert, forwardPlayerReplies, replyFlowLabel, type ReplyForwardDeps } from "../replyForwarding";

test("alert text: first name + last initial, flow, quoted reply, dashboard link", () => {
  assert.equal(
    composeReplyAlert({ playerName: "Karen Smith", flow: "win-back", body: "Is there room\nSaturday too?", dashboardUrl: "https://x/dashboard/c/pb-club/messages" }),
    'Reply from Karen S. (win-back): "Is there room Saturday too?" Answer it in the dashboard: https://x/dashboard/c/pb-club/messages',
  );
  assert.match(composeReplyAlert({ playerName: null, flow: null, body: "hi", dashboardUrl: null }), /^Reply from a player: "hi" Answer it in the dashboard Messages page\.$/);
  const long = composeReplyAlert({ playerName: "Sam", flow: null, body: "x".repeat(400), dashboardUrl: null });
  assert.ok(long.includes(`"${"x".repeat(300)}..."`));
  assert.equal(replyFlowLabel("ltp_followup"), "Learn to Play");
  assert.equal(replyFlowLabel("winback_regular"), "win-back");
  assert.equal(replyFlowLabel(null), null);
});

function deps(over: Partial<ReplyForwardDeps> = {}) {
  const alerts: [string, string][] = [];
  const marked: string[] = [];
  let since = "";
  const d: ReplyForwardDeps = {
    enabled: () => true,
    now: () => new Date("2026-11-25T20:00:00Z"),
    loadPending: async (s) => { since = s; return [
      { id: "r1", player_id: "p1", body: "Thanks, see you Saturday", received_at: "2026-11-25T19:30:00Z" },
      { id: "r2", player_id: "p2", body: "Who is this?", received_at: "2026-11-25T19:40:00Z" },
    ]; },
    loadPlayerName: async (id) => (id === "p1" ? "Vella Jones" : "Taylor"),
    loadLastFlow: async (id) => (id === "p1" ? "winback_regular" : null),
    dashboardUrl: () => "https://app/dashboard/c/pb-club/messages",
    alert: async (key, text) => { alerts.push([key, text]); return true; },
    markAttempted: async (id) => { marked.push(id); },
    ...over,
  };
  return { d, alerts, marked, since: () => since };
}

test("forwards each reply once under its own alert key and marks it", async () => {
  const h = deps();
  assert.equal(await forwardPlayerReplies(h.d), 2);
  assert.deepEqual(h.alerts.map(([k]) => k), ["player_reply:r1", "player_reply:r2"]);
  assert.match(h.alerts[0][1], /^Reply from Vella J\. \(win-back\): "Thanks, see you Saturday"/);
  assert.deepEqual(h.marked, ["r1", "r2"]);
  assert.equal(h.since(), "2026-11-25T14:00:00.000Z", "only replies from the last 6 hours");
});

test("an alert that was not submitted is not marked, so the next minute retries it", async () => {
  const h = deps({ alert: async () => false });
  assert.equal(await forwardPlayerReplies(h.d), 0);
  assert.deepEqual(h.marked, []);
});

test("REPLY_FORWARDING=false turns it off", async () => {
  const h = deps({ enabled: () => false });
  assert.equal(await forwardPlayerReplies(h.d), 0);
  assert.equal(h.alerts.length, 0);
});
