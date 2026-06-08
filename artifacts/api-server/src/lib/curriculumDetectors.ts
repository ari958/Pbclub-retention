// curriculumDetectors.ts — pure detector functions over a rung timeline.
// No DB access. All functions handle degenerate inputs gracefully (no throws).

// ─── Types ────────────────────────────────────────────────────────────────────

export type TimelineEntry = {
  attended_at: string;
  level:       string;
  rank:        number;
  event_id:    string | null;
};

export interface StallSignal {
  stalled:        boolean;
  rank:           number;
  sessionsAtRank: number;
  daysAtRank:     number;
  lastAdvanceAt:  string | null;  // ISO — when the player first attended at this rank
}

export interface RetreatSignal {
  retreated:             boolean;
  peakRank:              number;
  currentRank:           number;
  retreatedAt:           string | null;  // ISO — first sub-peak session after the last peak
  sessionsSinceRetreat:  number;
}

// ─── Null signals ─────────────────────────────────────────────────────────────

const NO_STALL: StallSignal = {
  stalled: false, rank: 0, sessionsAtRank: 0, daysAtRank: 0, lastAdvanceAt: null,
};

const NO_RETREAT: RetreatSignal = {
  retreated: false, peakRank: 0, currentRank: 0, retreatedAt: null, sessionsSinceRetreat: 0,
};

// ─── detectStall ──────────────────────────────────────────────────────────────
//
// A player is stalled when they have accumulated ≥ minSessions attendances at
// their current highest-ever rank with no upward movement for ≥ windowDays.
//
// "Current highest-ever rank" = peak rank across the full timeline.
// "No upward movement" = they have never attended at a rank > peakRank, which
// is guaranteed by definition — stall measures time spent at the ceiling.
// lastAdvanceAt = the earliest (first) attendance at peakRank, i.e. when they
// arrived at this rung; daysAtRank is measured from that moment to now.

export function detectStall(
  timeline: TimelineEntry[],
  opts: { minSessions?: number; windowDays?: number } = {}
): StallSignal {
  const minSessions = opts.minSessions ?? 4;
  const windowDays  = opts.windowDays  ?? 60;

  if (timeline.length === 0) return NO_STALL;

  const peakRank      = Math.max(...timeline.map((e) => e.rank));
  const sessionsAtPeak = timeline.filter((e) => e.rank === peakRank);

  if (sessionsAtPeak.length < minSessions) return NO_STALL;

  // Earliest session at peak rank = when the player "arrived" at this rung.
  // Timeline is already ordered oldest→newest by buildPlayerRungTimeline.
  const firstAtPeak = sessionsAtPeak[0].attended_at;
  const daysAtRank  = Math.floor(
    (Date.now() - new Date(firstAtPeak).getTime()) / 86_400_000
  );

  if (daysAtRank < windowDays) return NO_STALL;

  return {
    stalled:        true,
    rank:           peakRank,
    sessionsAtRank: sessionsAtPeak.length,
    daysAtRank,
    lastAdvanceAt:  firstAtPeak,
  };
}

// ─── detectRetreat ────────────────────────────────────────────────────────────
//
// A player has retreated when:
//   1. Their historical peak rank exceeds their current (most-recent) rank.
//   2. They had ≥ 2 sessions at peak rank (≥2 filters out one-off dabble-ups).
//   3. They have accumulated ≥ minSessionsSinceRetreat sessions at a lower rank
//      since their last peak-rank attendance.
//
// Dabble-up: player attended a higher level exactly once (or twice if opts allows),
// then returned — NOT counted as a retreat.

export function detectRetreat(
  timeline: TimelineEntry[],
  opts: { minSessionsSinceRetreat?: number } = {}
): RetreatSignal {
  const minSessionsSinceRetreat = opts.minSessionsSinceRetreat ?? 2;

  if (timeline.length < 2) return NO_RETREAT;

  const peakRank   = Math.max(...timeline.map((e) => e.rank));
  const currentRank = timeline[timeline.length - 1].rank;

  // No retreat if currently at or above historical peak
  if (currentRank >= peakRank) return NO_RETREAT;

  // Find the last index where the player attended at peak rank
  let lastPeakIndex = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].rank === peakRank) {
      lastPeakIndex = i;
      break;
    }
  }
  if (lastPeakIndex === -1) return NO_RETREAT;

  const sessionsAtPeak        = timeline.filter((e) => e.rank === peakRank).length;
  const sessionsSinceRetreat  = timeline.length - 1 - lastPeakIndex;

  // Dabble guard: fewer than 2 sessions at peak = they were just trying it out
  if (sessionsAtPeak < 2) return NO_RETREAT;

  if (sessionsSinceRetreat < minSessionsSinceRetreat) return NO_RETREAT;

  // retreatedAt = first sub-peak session after the last peak attendance
  const retreatedAt =
    lastPeakIndex + 1 < timeline.length
      ? timeline[lastPeakIndex + 1].attended_at
      : null;

  return {
    retreated:            true,
    peakRank,
    currentRank,
    retreatedAt,
    sessionsSinceRetreat,
  };
}
