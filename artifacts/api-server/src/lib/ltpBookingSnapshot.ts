import { RetentionPodplayBatchClient } from "./retentionPodplayBatch";
import { loadLiveClubCached, type RetentionLiveClub } from "./retentionContext";
import { fetchEventSignups, loadLtpUpcomingEvents, type LtpBookingBatchOptions } from "./ltpSequenceLifecycle";

export const LTP_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;
export const LTP_SNAPSHOT_CONCURRENCY = 6;

export interface LtpBookingSnapshot {
  clubId: string;
  /** Age is measured from the oldest read, not the end of the build. */
  capturedAt: number;
  completedAt: number;
  eventCount: number;
  bookings: Map<string, Array<{ eventId: string; startTime: number }>>;
}

export function requireFreshLtpSnapshot(snapshot: LtpBookingSnapshot, clubId: string): void {
  const age = Date.now() - snapshot.capturedAt;
  if (snapshot.clubId !== clubId || age < 0 || age >= LTP_SNAPSHOT_MAX_AGE_MS) {
    throw new Error("LTP booking snapshot is missing, belongs to another club, or is at least five minutes old");
  }
}

/** One rate-limited client is shared by all clubs and messages of a tick. */
export function createQueueBookingOptions(): LtpBookingBatchOptions {
  return {
    client: new RetentionPodplayBatchClient({
      minimumSpacingMs: 0, maxConcurrentRequests: LTP_SNAPSHOT_CONCURRENCY, maxRequestsPerMinute: 285,
    }),
    clubCache: new Map<string, Promise<RetentionLiveClub>>(),
    eventsCache: new Map(),
    signupsCache: new Map(),
  };
}

export async function buildLtpBookingSnapshot(
  clubId: string,
  options: LtpBookingBatchOptions,
): Promise<LtpBookingSnapshot> {
  const capturedAt = Date.now();
  const live = await loadLiveClubCached(clubId, options.clubCache ?? new Map());
  const events = await loadLtpUpcomingEvents(clubId, live, options);
  const bookings: LtpBookingSnapshot["bookings"] = new Map();
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(LTP_SNAPSHOT_CONCURRENCY, events.length) }, async () => {
    try {
      while (!failed && next < events.length) {
        const event = events[next++];
        const signups = await fetchEventSignups(clubId, live, event.id, options);
        for (const signup of signups) {
          if (!signup || typeof signup.status !== "string") throw new Error("Invalid signup in LTP booking snapshot");
          const status = signup.status.trim().toUpperCase();
          if (["CANCELED", "CANCELLED", "DRAFT"].includes(status)) continue;
          if (typeof signup.owner?.id !== "string" || !signup.owner.id.trim()) {
            throw new Error("An active signup is missing its owner identity; booking snapshot is incomplete");
          }
          const playerBookings = bookings.get(signup.owner.id) ?? [];
          playerBookings.push({ eventId: event.id, startTime: Date.parse(event.startTime) });
          bookings.set(signup.owner.id, playerBookings);
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  }));
  const snapshot = { clubId, capturedAt, completedAt: Date.now(), eventCount: events.length, bookings };
  requireFreshLtpSnapshot(snapshot, clubId);
  return snapshot;
}