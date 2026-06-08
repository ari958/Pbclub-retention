/**
 * curriculumDetectors.test.ts
 *
 * Plain assertion tests — no test runner required.
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/lib/__tests__/curriculumDetectors.test.ts
 */

import { detectStall, detectRetreat, type TimelineEntry } from "../curriculumDetectors.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

// Build a simple ascending timeline (one entry per rung, one per day back from now).
function makeEntries(
  ranks: number[],
  daysAgoOffsets: number[]
): TimelineEntry[] {
  return ranks.map((rank, i) => ({
    attended_at: daysAgo(daysAgoOffsets[i]),
    level:       `Level${rank}`,
    rank,
    event_id:    null,
  }));
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

// ─── Test suites ──────────────────────────────────────────────────────────────

console.log("\n── detectStall ──────────────────────────────────────");

test("empty timeline → no stall", () => {
  const s = detectStall([]);
  assert(!s.stalled, "stalled should be false on empty timeline");
  assert(s.rank === 0, "rank should be 0");
});

test("single entry → no stall (below minSessions)", () => {
  const s = detectStall(makeEntries([3], [10]));
  assert(!s.stalled, "single entry cannot trigger stall");
});

test("healthy climber — ascending ranks, recent entries → no stall", () => {
  // Player advances 1→2→3→4→5 over last 30 days
  const timeline = makeEntries([1, 2, 3, 4, 5], [30, 25, 20, 15, 5]);
  const s = detectStall(timeline, { minSessions: 4, windowDays: 60 });
  assert(!s.stalled, "a climbing player should not be stalled");
});

test("classic stall — 6 sessions at rank 4, first session 90 days ago", () => {
  const sessionsAtPeak = makeEntries(
    [4, 4, 4, 4, 4, 4],
    [90, 75, 60, 45, 30, 15]
  );
  const timeline = [
    ...makeEntries([1, 2, 3], [150, 130, 110]),
    ...sessionsAtPeak,
  ];
  const s = detectStall(timeline, { minSessions: 4, windowDays: 60 });
  assert(s.stalled, "player with 6 sessions at rank 4 for 90 days should be stalled");
  assert(s.rank === 4, "stall rank should be 4");
  assert(s.sessionsAtRank === 6, "sessionsAtRank should be 6");
  assert(s.daysAtRank >= 60, "daysAtRank should be ≥ 60");
  assert(s.lastAdvanceAt !== null, "lastAdvanceAt should be set");
});

test("not yet stalled — enough sessions but first session only 30 days ago", () => {
  const timeline = makeEntries([4, 4, 4, 4, 4], [30, 22, 14, 7, 2]);
  const s = detectStall(timeline, { minSessions: 4, windowDays: 60 });
  assert(!s.stalled, "30 days is below windowDays=60, should not stall");
});

test("stall opts respected — custom minSessions and windowDays", () => {
  const timeline = makeEntries([3, 3], [100, 50]);
  const s = detectStall(timeline, { minSessions: 2, windowDays: 90 });
  assert(s.stalled, "custom opts: 2 sessions at rank 3 for 100 days should stall");
  assert(s.sessionsAtRank === 2, "sessionsAtRank should be 2");
});

console.log("\n── detectRetreat ────────────────────────────────────");

test("empty timeline → no retreat", () => {
  const r = detectRetreat([]);
  assert(!r.retreated, "empty timeline should not retreat");
});

test("single entry → no retreat", () => {
  const r = detectRetreat(makeEntries([3], [10]));
  assert(!r.retreated, "single entry cannot retreat");
});

test("healthy climber — always ascending → no retreat", () => {
  const timeline = makeEntries([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
  const r = detectRetreat(timeline);
  assert(!r.retreated, "ascending player should not retreat");
});

test("classic retreat — peaked at 4, now at 2 for 4 sessions", () => {
  const timeline = [
    ...makeEntries([1, 2, 3, 4, 4, 4], [120, 100, 90, 70, 55, 40]),
    ...makeEntries([2, 2, 2, 2],        [35, 25, 15, 5]),
  ];
  const r = detectRetreat(timeline, { minSessionsSinceRetreat: 2 });
  assert(r.retreated, "classic retreat: peaked at 4, now 4 sessions at rank 2");
  assert(r.peakRank === 4, "peakRank should be 4");
  assert(r.currentRank === 2, "currentRank should be 2");
  assert(r.sessionsSinceRetreat === 4, "sessionsSinceRetreat should be 4");
  assert(r.retreatedAt !== null, "retreatedAt should be set");
});

test("dabble-up-then-back — one session at rank 5, returns to rank 3 → no retreat", () => {
  // Player is at rank 3, tries rank 5 once, comes back — NOT a real retreat.
  const timeline = [
    ...makeEntries([3, 3, 3], [90, 70, 50]),
    ...makeEntries([5],       [40]),         // single dabble at peak
    ...makeEntries([3, 3, 3], [30, 20, 10]), // back to rank 3
  ];
  const r = detectRetreat(timeline, { minSessionsSinceRetreat: 2 });
  assert(!r.retreated, "single dabble-up should not trigger retreat");
});

test("retreat fires only after minSessionsSinceRetreat threshold", () => {
  const timeline = [
    ...makeEntries([3, 3], [80, 60]),   // 2 sessions at peak (passes dabble guard)
    ...makeEntries([1],    [10]),        // 1 session since retreat
  ];
  const r = detectRetreat(timeline, { minSessionsSinceRetreat: 2 });
  assert(!r.retreated, "only 1 session since retreat, threshold is 2 — should not fire");

  const timeline2 = [
    ...makeEntries([3, 3], [80, 60]),
    ...makeEntries([1, 1], [10, 5]),    // 2 sessions since retreat
  ];
  const r2 = detectRetreat(timeline2, { minSessionsSinceRetreat: 2 });
  assert(r2.retreated, "2 sessions since retreat meets threshold — should fire");
});

test("all-same-rung timeline → neither stall nor retreat if below session count", () => {
  const timeline = makeEntries([3, 3, 3], [30, 20, 10]);
  const s = detectStall(timeline, { minSessions: 4, windowDays: 60 });
  assert(!s.stalled, "3 sessions < minSessions=4, no stall");
  const r = detectRetreat(timeline);
  assert(!r.retreated, "no peak/current difference, no retreat");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ────────────────`);
if (failed > 0) process.exit(1);
