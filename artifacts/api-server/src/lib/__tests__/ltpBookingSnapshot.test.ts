import assert from "node:assert/strict";
import test from "node:test";
import { buildLtpBookingSnapshot, requireFreshLtpSnapshot } from "../ltpBookingSnapshot";
import { RetentionPodplayBatchClient } from "../retentionPodplayBatch";
import { checkLtpBookingSince } from "../ltpSequenceLifecycle";
import { supabase } from "../supabaseClient";
import { VirtualClock } from "./virtualClock";

const clubId = "fixture-club";
const base = "https://offline.podplay.app";
const options = (fetchImpl: (input: any) => Promise<Response>) => ({
  client: new RetentionPodplayBatchClient({ minimumSpacingMs: 0, maxConcurrentRequests: 6, fetchImpl }),
  clubCache: new Map([[clubId, Promise.resolve({ base, apiKey: "offline-key", timezone: "America/New_York" })]]),
});
const event = (id: string) => ({
  id, name: "Any program", startTime: new Date(Date.now() + 400 * 86_400_000).toISOString(), status: "PUBLISHED",
});

test("snapshot covers all event and signup pages, including distant bookings and INVALID signups", async () => {
  const calls: string[] = [];
  const snapshot = await buildLtpBookingSnapshot(clubId, options(async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/events")) {
      return Response.json({
        items: [event(url.searchParams.get("page") === "1" ? "first" : "second")],
        hasMore: url.searchParams.get("page") === "1", _pagination: { ipp: 500 },
      });
    }
    return Response.json({
      items: url.searchParams.get("page") === "1"
        ? [{ status: "CANCELED", owner: { id: "ignored" } }]
        : [{ status: "INVALID", owner: { id: "pod-player" } }],
      hasMore: url.searchParams.get("page") === "1",
    });
  }));
  assert.equal(snapshot.eventCount, 2);
  assert.equal(snapshot.bookings.get("pod-player")?.length, 2);
  assert.equal(snapshot.bookings.has("ignored"), false);
  assert.equal(calls.length, 6);
  requireFreshLtpSnapshot(snapshot, clubId);
  assert.throws(() => requireFreshLtpSnapshot({ ...snapshot, capturedAt: Date.now() - 300_000 }, clubId));
  assert.throws(() => requireFreshLtpSnapshot(snapshot, "wrong-club"));
});

test("snapshot fails closed on missing signup ownership and failed provider reads", async () => {
  for (const bad of [Response.json({ items: [{ status: "CONFIRMED" }] }), new Response("", { status: 503 })]) {
    await assert.rejects(buildLtpBookingSnapshot(clubId, options(async (input) =>
      new URL(String(input)).pathname.endsWith("/events") ? Response.json({ items: [event("e")] }) : bad.clone(),
    )));
  }
});

test("snapshot is reused for players but attendance history is read freshly on every check", async () => {
  let calls = 0;
  const opts = options(async (input) => {
    calls++;
    return new URL(String(input)).pathname.endsWith("/events")
      ? Response.json({ items: [event("e")] })
      : Response.json({ items: [{ status: "CONFIRMED", owner: { id: "pod-player" } }] });
  });
  const snapshot = await buildLtpBookingSnapshot(clubId, opts);
  const original = supabase.from;
  let attendanceReads = 0;
  (supabase as any).from = (table: string) => {
    const q: any = {
      select: () => q, eq: () => q, gt: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: { club_id: clubId, external_id: "pod-player" }, error: null }),
      then: (yes: any, no: any) => {
        attendanceReads++;
        return Promise.resolve({ data: [], error: null }).then(yes, no);
      },
    };
    assert.ok(["players", "attendances"].includes(table));
    return q;
  };
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal((await checkLtpBookingSince(clubId, "player", "2026-01-01T00:00:00Z",
        { ...opts, bookingSnapshot: snapshot }))?.booked_event_id, "e");
    }
    assert.equal(calls, 2);
    assert.equal(attendanceReads, 4);
    await assert.rejects(checkLtpBookingSince(clubId, "player", "2026-01-01T00:00:00Z",
      { ...opts, bookingSnapshot: { ...snapshot, capturedAt: Date.now() - 300_001 } }), /not fresh/);
  } finally {
    (supabase as any).from = original;
  }
});

test("bounded concurrency overlaps network work instead of serializing responses", async () => {
  let active = 0;
  let maximum = 0;
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0, maxConcurrentRequests: 3,
    fetchImpl: async () => {
      active++;
      maximum = Math.max(active, maximum);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return Response.json({ items: [] });
    },
  });
  await Promise.all(Array.from({ length: 12 }, () => client.fetch(base + "/events")));
  assert.equal(maximum, 3);
});

test("rolling-minute budget caps bursts and 429 backoff pauses other queued starts", async () => {
  const originalNow = Date.now;
  const clock = new VirtualClock();
  const starts: number[] = [];
  Date.now = () => clock.now;
  try {
    let attempt = 0;
    const client = new RetentionPodplayBatchClient({
      minimumSpacingMs: 0, maxConcurrentRequests: 2, maxRequestsPerMinute: 3,
      sleep: clock.sleep,
      fetchImpl: async () => {
        starts.push(clock.now);
        await clock.sleep(50);
        return ++attempt === 1
          ? new Response("", { status: 429, headers: { "retry-after": "2" } })
          : Response.json({ items: [] });
      },
    });
    await Promise.all(Array.from({ length: 7 }, () => client.fetch(base + "/events")));
    assert.equal(client.telemetry.rate_limit_count, 1);
    assert.equal(starts.length, 8, "retry attempts consume the same rolling budget");
    for (const at of starts) {
      assert.ok(starts.filter((s) => s >= at && s < at + 60_000).length <= 3);
    }
    assert.ok(starts[2] >= starts[0] + 2050, "queued starts respect the shared Retry-After cooldown");
  } finally {
    Date.now = originalNow;
  }
});