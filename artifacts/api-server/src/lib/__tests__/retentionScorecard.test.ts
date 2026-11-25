import test from "node:test";
import assert from "node:assert/strict";
import { computeScorecard, twoProportionP, type ScorecardCandidate, type ScorecardInputs, type ScorecardMessage } from "../retentionScorecard";
import { approvalKeyRouteAllowed } from "../approvalKey";

const health = { kill_switch: false, sms_live: true, last_nightly: { status: "done", finished_at: "2026-12-20T08:09:00Z" } };

function base(over: Partial<ScorecardInputs> = {}): ScorecardInputs {
  return {
    today: "2026-12-31", periodDays: 7, visits: new Map([["anchor", [{ date: "2026-12-30", program: "Open Play" }]]]),
    candidates: [], messages: new Map(), inboundByPlayer: new Map(), optouts: [], testPlayerIds: new Set(), health, ...over,
  };
}

test("win-back: texted vs holdout return rates count only players with a full window", () => {
  const candidates: ScorecardCandidate[] = [];
  const messages = new Map<string, ScorecardMessage>();
  const visits = new Map<string, { date: string; program: string | null }[]>([["anchor", [{ date: "2026-12-30", program: "x" }]]]);
  // 10 texted on Nov 1: 6 came back within 14 days.
  for (let i = 0; i < 10; i++) {
    candidates.push({ id: `t${i}`, player_id: `t${i}`, playbook_key: "winback_regular", step: 1, status: "sent", created_at: "2026-11-01T08:00:00Z", context: {}, message_id: `m${i}` });
    messages.set(`m${i}`, { id: `m${i}`, sent_at: "2026-11-01T19:00:00Z", delivery_status: "delivered", error_code: null, simulated: false, retention_delivery_kind: "real", approved_by: "chat-approval" });
    if (i < 6) visits.set(`t${i}`, [{ date: "2026-11-08", program: "Open Play" }]);
  }
  // 5 held out on Nov 1: 1 came back. One more held out yesterday: not mature, not counted.
  for (let i = 0; i < 5; i++) {
    candidates.push({ id: `h${i}`, player_id: `h${i}`, playbook_key: "winback_regular", step: 1, status: "skipped", created_at: "2026-11-01T08:00:00Z", context: { reason: "holdout" }, message_id: null });
    if (i === 0) visits.set(`h${i}`, [{ date: "2026-11-10", program: "Open Play" }]);
  }
  candidates.push({ id: "h9", player_id: "h9", playbook_key: "winback_regular", step: 1, status: "skipped", created_at: "2026-12-30T08:00:00Z", context: { reason: "holdout" }, message_id: null });
  const card = computeScorecard(base({ candidates, messages, visits }));
  assert.deepEqual(card.winback.came_back.texted.d14, { mature: 10, returned: 6, rate: 60 });
  assert.deepEqual(card.winback.came_back.holdout_no_text.d14, { mature: 5, returned: 1, rate: 20 });
  assert.equal(card.winback.held_out_no_text.all_time, 6);
  assert.match(card.winback.came_back.verdict_14d, /^Too early to tell/);
  assert.equal(card.data_through, "2026-12-30");
});

test("Learn to Play: texted players vs the pre-texting baseline, counting only non-LTP sessions", () => {
  const visits = new Map<string, { date: string; program: string | null }[]>([
    ["anchor", [{ date: "2026-12-30", program: "x" }]],
    // Baseline: two first-timers at Learn to Play in September; one plays open play within 14 days.
    ["b1", [{ date: "2026-09-01", program: "Learn to Play Clinic" }, { date: "2026-09-08", program: "Open Play" }]],
    ["b2", [{ date: "2026-09-02", program: "Learn to Play Clinic" }, { date: "2026-09-05", program: "Learn to Play Clinic" }]],
    // Not baseline: first visit was not Learn to Play.
    ["b3", [{ date: "2026-09-03", program: "Open Play" }]],
    // Texted: came back to Learn to Play only (does not count), and one to a clinic.
    ["l1", [{ date: "2026-11-01", program: "Learn to Play" }, { date: "2026-11-05", program: "Learn to Play" }]],
    ["l2", [{ date: "2026-11-01", program: "Learn to Play" }, { date: "2026-11-06", program: "Beginner Clinic" }]],
  ]);
  const candidates: ScorecardCandidate[] = ["l1", "l2"].map((p) => ({
    id: p, player_id: p, playbook_key: "ltp_followup", step: 1, status: "sent", created_at: "2026-11-02T08:00:00Z", context: {}, message_id: `m-${p}`,
  }));
  const messages = new Map<string, ScorecardMessage>(["l1", "l2"].map((p) => [`m-${p}`, {
    id: `m-${p}`, sent_at: "2026-11-02T20:00:00Z", delivery_status: "delivered", error_code: null, simulated: false, retention_delivery_kind: "real", approved_by: "auto-approver",
  }]));
  const card = computeScorecard(base({ visits, candidates, messages }));
  assert.deepEqual(card.learn_to_play.played_again.texted.d14, { mature: 2, returned: 1, rate: 50 });
  assert.deepEqual(card.learn_to_play.played_again.before_texting_baseline.d14, { mature: 2, returned: 1, rate: 50 });
});

test("test players, simulated and test-override sends are excluded", () => {
  const candidates: ScorecardCandidate[] = [
    { id: "a", player_id: "tester", playbook_key: "winback_regular", step: 1, status: "sent", created_at: "2026-12-28T08:00:00Z", context: {}, message_id: "ma" },
    { id: "b", player_id: "p", playbook_key: "winback_regular", step: 1, status: "sent", created_at: "2026-12-28T08:00:00Z", context: {}, message_id: "mb" },
    { id: "c", player_id: "q", playbook_key: "winback_regular", step: 1, status: "sent", created_at: "2026-12-28T08:00:00Z", context: {}, message_id: "mc" },
  ];
  const msg = (id: string, kind: string, delivery = "delivered"): [string, ScorecardMessage] => [id, {
    id, sent_at: "2026-12-28T19:00:00Z", delivery_status: delivery, error_code: delivery === "failed" ? "30034" : null,
    simulated: kind === "simulated", retention_delivery_kind: kind, approved_by: null,
  }];
  const card = computeScorecard(base({
    candidates, testPlayerIds: new Set(["tester"]),
    messages: new Map([msg("ma", "real"), msg("mb", "simulated"), msg("mc", "real", "failed")]),
  }));
  assert.equal(card.winback.period.sent, 1);
  assert.equal(card.winback.period.failed, 1);
  assert.deepEqual(card.winback.period.failed_error_codes, ["30034"]);
});

test("verdict says likely real only with enough players and a clear gap", () => {
  assert.ok((twoProportionP(60, 100, 30, 100) ?? 1) < 0.001);
  assert.ok((twoProportionP(10, 20, 9, 20) ?? 0) > 0.5);
  assert.equal(twoProportionP(1, 0, 1, 1), null);
});

test("the approval key may read the scorecard, nothing else new", () => {
  assert.equal(approvalKeyRouteAllowed("GET", "/api/retention/scorecard"), true);
  assert.equal(approvalKeyRouteAllowed("POST", "/api/retention/scorecard"), false);
  assert.equal(approvalKeyRouteAllowed("GET", "/api/retention/reports"), false);
});
