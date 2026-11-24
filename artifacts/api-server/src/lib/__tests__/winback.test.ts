import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWinbackText,
  evaluateWinbackLapse,
  isWinbackSessionUsable,
  validateWinbackText,
  winbackClockTime,
  winbackContactBlock,
  winbackWhenPhrase,
  WINBACK_PLAYBOOK_KEY,
  type WinbackVisit,
} from "../winbackRules";
import { composeWinbackDraft, runWinback, type WinbackDeps, type WinbackDraftRow, type WinbackPlayer } from "../winback";
import { addCalendarDays } from "../retentionDates";
import { validateRetentionTextBody } from "../retentionText";

/** Weekly player: visits every 7 days, last on `last`. */
const weekly = (last: string, count = 8, program = "Intermediate Open Play"): WinbackVisit[] =>
  Array.from({ length: count }, (_, i) => ({ date: addCalendarDays(last, -7 * i), program }));

test("a weekly regular is overdue at 14 days and stays eligible through day 30", () => {
  const visits = weekly("2026-11-01");
  assert.equal(evaluateWinbackLapse(visits, "2026-11-14"), null, "13 days: not yet");
  const lapse = evaluateWinbackLapse(visits, "2026-11-15");
  assert.ok(lapse);
  assert.equal(lapse.overdue_days, 14);
  assert.equal(lapse.median_gap_days, 7);
  assert.equal(lapse.days_since, 14);
  assert.equal(lapse.usual_program, "Intermediate Open Play");
  assert.equal(lapse.trigger_key, "lapse:2026-11-01");
  assert.ok(evaluateWinbackLapse(visits, "2026-12-01"), "day 30 still eligible");
  assert.equal(evaluateWinbackLapse(visits, "2026-12-02"), null, "day 31 is dormant, out of scope");
});

test("a twice-a-month player is overdue later, by their own rhythm", () => {
  const visits = Array.from({ length: 5 }, (_, i) => ({ date: addCalendarDays("2026-11-01", -12 * i), program: "Social" }));
  const lapse = evaluateWinbackLapse(visits, "2026-11-25");
  assert.ok(lapse);
  assert.equal(lapse.overdue_days, 24);
  assert.equal(evaluateWinbackLapse(visits, "2026-11-24"), null);
});

test("occasional players and slow rhythms are not regulars", () => {
  assert.equal(evaluateWinbackLapse(weekly("2026-11-01", 3), "2026-11-20"), null, "3 visits in 60 days");
  const slow = Array.from({ length: 6 }, (_, i) => ({ date: addCalendarDays("2026-11-01", -16 * i), program: "X" }));
  assert.equal(evaluateWinbackLapse(slow, "2026-11-30"), null, "overdue would be 32 days, past the lapsing window");
});

test("usual program is the most frequent in 60 days, ties to the most recent", () => {
  const visits: WinbackVisit[] = [
    { date: "2026-11-01", program: "B" }, { date: "2026-10-25", program: "A" },
    { date: "2026-10-18", program: "B" }, { date: "2026-10-11", program: "A" },
  ];
  assert.equal(evaluateWinbackLapse(visits, "2026-11-20")?.usual_program, "B");
});

test("when-phrase and clock time are New York time relative to the send date", () => {
  assert.equal(winbackClockTime("2026-11-24T23:00:00Z"), "6pm");
  assert.equal(winbackClockTime("2026-11-24T23:30:00Z"), "6:30pm");
  assert.equal(winbackWhenPhrase("2026-11-24T23:00:00Z", "2026-11-24"), "today at 6pm");
  assert.equal(winbackWhenPhrase("2026-11-25T23:00:00Z", "2026-11-24"), "tomorrow at 6pm");
  assert.equal(winbackWhenPhrase("2026-11-27T15:00:00Z", "2026-11-24"), "on Friday at 10am");
});

test("only sessions 2+ hours after the send and within 6 days can be named", () => {
  const send = new Date("2026-11-24T20:00:00Z"); // 3pm ET
  assert.equal(isWinbackSessionUsable("2026-11-24T21:00:00Z", send), false);
  assert.equal(isWinbackSessionUsable("2026-11-24T23:00:00Z", send), true);
  assert.equal(isWinbackSessionUsable("2026-11-30T23:00:00Z", send), true);
  assert.equal(isWinbackSessionUsable("2026-12-01T23:00:00Z", send), false);
});

test("templates pass the house text rules and the approval validator", () => {
  const session = { name: "Intermediate Open Play", start_time: "2026-11-25T23:00:00Z", signup_url: "https://pbclub.podplay.app/community/events/e1" };
  for (let i = 0; i < 40; i++) {
    for (const withSession of [true, false]) {
      const built = buildWinbackText({
        firstName: "Sam", session: withSession ? session : null, sendDate: "2026-11-24",
        bookingUrl: "https://pbclub.podplay.app", seed: `p${i}`,
      });
      const context = { player_first_name: "Sam", next_program: withSession ? session : null, booking_url: "https://pbclub.podplay.app" };
      assert.deepEqual(validateWinbackText(built.body, context), [], built.body);
      assert.doesNotMatch(built.body, /[!–—]/);
      assert.ok(built.body.length <= 320);
    }
  }
});

test("validator rejects promos, other links, dashes, exclamation points and a wrong opener", () => {
  const ctx = { player_first_name: "Sam", next_program: null, booking_url: "https://pbclub.podplay.app" };
  const ok = "Hi Sam, it's PB Club. Here's the schedule: https://pbclub.podplay.app";
  assert.deepEqual(validateWinbackText(ok, ctx), []);
  assert.ok(validateWinbackText(ok.replace("schedule", "schedule and 20% off"), ctx).length);
  assert.ok(validateWinbackText(`${ok} https://evil.example`, ctx).length);
  assert.ok(validateWinbackText(ok.replace(".", "!"), ctx).length);
  assert.ok(validateWinbackText(ok.replace("schedule", "schedule — yes"), ctx).length);
  assert.ok(validateWinbackText(ok.replace("Hi Sam", "Hey Sam"), ctx).length);
  assert.ok(validateWinbackText("Hi Sam, it's PB Club. Come play.", ctx).length, "must carry a link");
});

test("approval uses the win-back validator for the win-back playbook", () => {
  const context: any = {
    player_first_name: "Sam", next_program: null, booking_url: "https://pbclub.podplay.app",
    trigger: { event_id: "lapse:2026-11-01", name: "x", date: "2026-11-01" }, diagnostics: {},
  };
  const playbook: any = { key: WINBACK_PLAYBOOK_KEY, name: "w", enabled: true, promo_code: null, offer_text: null, next_program_names: [], message_guidance: null, holdout_pct: 20 };
  const body = "Hi Sam, it's PB Club. Here's the schedule: https://pbclub.podplay.app";
  assert.equal(validateRetentionTextBody(body, context, playbook), body);
  assert.throws(() => validateRetentionTextBody(`${body} Use code SAVE10.`, context, playbook));
});

test("contact limits: 7-day cooldown and at most 2 texts in 30 days", () => {
  const now = new Date("2026-11-24T08:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  assert.equal(winbackContactBlock({ sent_at: [] }, now), null);
  assert.equal(winbackContactBlock({ sent_at: [daysAgo(3)] }, now), "texted_in_last_7_days");
  assert.equal(winbackContactBlock({ sent_at: [daysAgo(10)] }, now), null);
  assert.equal(winbackContactBlock({ sent_at: [daysAgo(10), daysAgo(20)] }, now), "two_texts_in_last_30_days");
});

test("a session name with a price falls back to the generic text", () => {
  const draft = composeWinbackDraft({
    player: { id: "p1", name: "Sam Lee", phone: "+1", opted_out: false, external_id: "x" },
    lapse: evaluateWinbackLapse(weekly("2026-11-01"), "2026-11-16")!,
    facts: { already_booked: false, diagnostics: {}, session: {
      event_id: "e1", name: "$20 Morning Open Play", start_time: "2026-11-18T14:00:00Z",
      signup_url: "https://pbclub.podplay.app/community/events/e1", spots_remaining: 3,
    } },
    now: new Date("2026-11-16T08:00:00Z"),
    bookingUrl: "https://pbclub.podplay.app",
  });
  assert.equal((draft.context as any).winback.template, "generic");
  assert.equal(draft.context.next_program, null);
  assert.match(draft.body, /https:\/\/pbclub\.podplay\.app$/);
});

// ---- runWinback with fake deps ----------------------------------------------

const NOW = new Date("2026-11-16T08:00:00Z"); // 3am ET; send date 2026-11-16
function harness(over: Partial<WinbackDeps> = {}, players?: Record<string, Partial<WinbackPlayer>>) {
  const created: any[] = [];
  const regenerated: any[] = [];
  const visits = new Map<string, WinbackVisit[]>();
  const ids = Object.keys(players ?? { p1: {} });
  for (const id of ids) visits.set(id, weekly("2026-11-01"));
  visits.set("fresh", [{ date: "2026-11-15", program: "X" }]);
  const deps: WinbackDeps = {
    now: () => NOW,
    ready: async () => true,
    loadPlaybook: async () => ({ key: WINBACK_PLAYBOOK_KEY, name: "w", enabled: true, holdout_pct: 0, booking_url: "https://pbclub.podplay.app" }),
    loadVisits: async () => visits,
    loadPlayers: async (_c, list) => new Map(list.map((id) => [id, {
      id, name: "Sam Lee", phone: "+15551234567", opted_out: false, external_id: `ext-${id}`, ...(players?.[id] ?? {}),
    }])),
    loadRecentWinback: async () => new Set(),
    loadRecentLtp: async () => new Set(),
    loadSentTexts: async () => new Map(),
    liveFacts: async () => ({ already_booked: false, session: {
      event_id: "e1", name: "Intermediate Open Play", start_time: "2026-11-17T23:00:00Z",
      signup_url: "https://pbclub.podplay.app/community/events/e1", spots_remaining: 4,
    }, diagnostics: {} }),
    createCandidate: async (args) => { created.push(args); return `c${created.length}`; },
    loadOpenDrafts: async () => [],
    loadMessageBody: async () => "old body",
    regenerate: async (args) => { regenerated.push(args); },
    ...over,
  };
  return { deps, created, regenerated };
}

test("drafts a session text for an overdue regular", async () => {
  const { deps, created } = harness();
  const result = await runWinback("club", deps);
  assert.equal(result.status, "ran");
  assert.equal(result.drafted, 1);
  assert.equal(created[0].status, "drafted");
  assert.equal(created[0].triggerKey, "lapse:2026-11-01");
  assert.match(created[0].body, /^Hi Sam, it's PB Club\. .*Intermediate Open Play.* tomorrow at 6pm/);
  assert.equal(created[0].context.send_date_et, "2026-11-16");
});

test("refuses to run on stale attendance data", async () => {
  const { deps, created } = harness({ loadVisits: async () => new Map([["p1", weekly("2026-10-16")]]) });
  const result = await runWinback("club", deps);
  assert.equal(result.status, "stale_data");
  assert.equal(result.data_through, "2026-10-16");
  assert.equal(created.length, 0);
});

test("does nothing when the playbook is off or migration 032 is missing", async () => {
  assert.equal((await runWinback("club", harness({ ready: async () => false }).deps)).status, "not_installed");
  const off = harness({ loadPlaybook: async () => ({ key: WINBACK_PLAYBOOK_KEY, name: "w", enabled: false, holdout_pct: 0, booking_url: null }) });
  assert.equal((await runWinback("club", off.deps)).status, "disabled");
  assert.equal(off.created.length, 0);
});

test("skips booked, opted-out, recently texted, in-LTP and PodPlay-failure players without a row", async () => {
  const players = { booked: {}, optout: { opted_out: true }, nophone: { phone: " " }, texted: {}, ltp: {}, recent: {}, podfail: {} };
  const { deps, created } = harness({
    loadSentTexts: async () => new Map([["texted", [new Date(NOW.getTime() - 2 * 86_400_000).toISOString()]]]),
    loadRecentLtp: async () => new Set(["ltp"]),
    loadRecentWinback: async () => new Set(["recent"]),
    liveFacts: async (_c, player) => {
      if (player.id === "podfail") throw new Error("PodPlay down");
      return { already_booked: player.id === "booked", session: null, diagnostics: {} };
    },
  }, players);
  const result = await runWinback("club", deps);
  assert.equal(created.length, 0);
  assert.deepEqual(result.skipped_by_reason, {
    already_booked: 1, opted_out: 1, no_phone: 1, texted_in_last_7_days: 1,
    in_learn_to_play_followup: 1, winback_in_last_90_days: 1, podplay_check_failed: 1,
  });
});

test("holdout players get a skipped row and no text", async () => {
  const { deps, created } = harness({
    loadPlaybook: async () => ({ key: WINBACK_PLAYBOOK_KEY, name: "w", enabled: true, holdout_pct: 100, booking_url: null }),
  });
  const result = await runWinback("club", deps);
  assert.equal(result.holdout, 1);
  assert.equal(created[0].status, "skipped");
  assert.equal(created[0].body, null);
  assert.equal(created[0].context.reason, "holdout");
});

test("about 20% of players land in the holdout", async () => {
  const players = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`p${i}`, {}]));
  const { deps } = harness({
    loadPlaybook: async () => ({ key: WINBACK_PLAYBOOK_KEY, name: "w", enabled: true, holdout_pct: 20, booking_url: null }),
  }, players);
  const result = await runWinback("club", deps);
  assert.equal(result.holdout + result.drafted, 400);
  assert.ok(result.holdout > 50 && result.holdout < 110, `holdout=${result.holdout}`);
});

test("refreshes yesterday's waiting draft, and retires it when the player booked or came back", async () => {
  const draftRow = (id: string, player: string): WinbackDraftRow => ({
    id, player_id: player, trigger_event_id: "lapse:2026-11-01", message_id: `m-${id}`,
    created_at: "2026-11-15T08:00:00Z", updated_at: "2026-11-15T08:00:00Z",
    context: { send_date_et: "2026-11-15", player_first_name: "Sam", winback: { last_visit: "2026-11-01", usual_program: "Intermediate Open Play" } } as any,
  });
  const visits = new Map<string, WinbackVisit[]>([
    ["waiting", weekly("2026-11-01")], ["booked", weekly("2026-11-01")],
    ["back", [...weekly("2026-11-01"), { date: "2026-11-15", program: "X" }]],
  ]);
  const { deps, regenerated, created } = harness({
    loadVisits: async () => visits,
    loadOpenDrafts: async () => [draftRow("d1", "waiting"), draftRow("d2", "booked"), draftRow("d3", "back")],
    loadRecentWinback: async () => new Set(["waiting", "booked", "back"]),
    liveFacts: async (_c, player) => ({ already_booked: player.id === "booked", session: null, diagnostics: {} }),
  }, { waiting: {}, booked: {}, back: {} });
  const result = await runWinback("club", deps);
  assert.equal(result.refreshed, 1);
  const byId = Object.fromEntries(regenerated.map((r) => [r.row.id, r]));
  assert.equal(byId.d1.status, "drafted");
  assert.equal(byId.d1.newContext.send_date_et, "2026-11-16");
  assert.equal(byId.d1.expectedBody, "old body");
  assert.equal(byId.d2.status, "skipped");
  assert.equal(byId.d2.newContext.reason, "booked");
  assert.equal(byId.d3.status, "skipped");
  assert.equal(byId.d3.newContext.reason, "returned");
  assert.equal(created.length, 0);
});

test("a draft nobody approved for a week is retired", async () => {
  const old: WinbackDraftRow = {
    id: "d9", player_id: "p1", trigger_event_id: "lapse:2026-11-01", message_id: "m9",
    created_at: "2026-11-05T08:00:00Z", updated_at: "2026-11-15T08:00:00Z",
    context: { send_date_et: "2026-11-15", player_first_name: "Sam", winback: { last_visit: "2026-11-01" } } as any,
  };
  const { deps, regenerated } = harness({ loadOpenDrafts: async () => [old], loadRecentWinback: async () => new Set(["p1"]) });
  await runWinback("club", deps);
  assert.equal(regenerated[0].status, "skipped");
  assert.equal(regenerated[0].newContext.reason, "expired");
});
