import assert from "node:assert/strict";
import { supabase } from "../supabaseClient.js";
import { buildRetentionContext, RetentionContextError } from "../retentionContext.js";
import { RetentionPodplayBatchClient } from "../retentionPodplayBatch.js";

function jsonResponse(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

async function test429RetryAfterAndTelemetry(): Promise<void> {
  const waits: number[] = [];
  let calls = 0;
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "2" } })
        : jsonResponse({ items: [] });
    },
  });

  const response = await client.fetch("https://club.podplay.app/apis/v2/events?page=1");
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(client.telemetry.total_calls, 2);
  assert.equal(client.telemetry.listing_calls, 2);
  assert.equal(client.telemetry.rate_limit_count, 1);
  assert.deepEqual(client.telemetry.retries.map(({ wait_ms, status }) => ({ wait_ms, status })), [
    { wait_ms: 2000, status: 429 },
  ]);
  assert.deepEqual(waits, [2000]);
  assert.equal(client.telemetry.statuses[0].status, 429);
  assert.equal(client.telemetry.statuses[1].status, 200);
}

async function testRetryAfterHttpDate(): Promise<void> {
  const waits: number[] = [];
  let calls = 0;
  const retryDate = new Date(Date.now() + 5_000).toUTCString();
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response("", { status: 429, headers: { "retry-after": retryDate } })
        : jsonResponse({ items: [] });
    },
  });

  await client.fetch("https://club.podplay.app/apis/v2/events/trigger-event");
  assert.equal(client.telemetry.trigger_calls, 2);
  assert.equal(waits.length, 1);
  assert(waits[0] > 3_500 && waits[0] <= 5_000, "honors an HTTP-date Retry-After value");
}

async function test429ExhaustionUsesExponentialBackoff(): Promise<void> {
  const waits: number[] = [];
  let calls = 0;
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      calls++;
      return new Response("still rate limited", { status: 429 });
    },
  });

  const response = await client.fetch("https://club.podplay.app/apis/v2/events/event-1/signups?page=1");
  assert.equal(response.status, 429);
  assert.equal(calls, 4, "makes one initial attempt and no more than three retries");
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.deepEqual(client.telemetry.retries.map((retry) => retry.retry_number), [1, 2, 3]);
  assert.equal(client.telemetry.rate_limit_count, 4);
  assert.equal(client.telemetry.signup_calls, 4);
  assert.equal(client.telemetry.total_calls, 4);
}

async function testRetryAfterGetsFreshPerAttemptTimeout(): Promise<void> {
  const waits: number[] = [];
  const timeoutControllers: AbortController[] = [];
  const attemptSignals: AbortSignal[] = [];
  const callerController = new AbortController();
  let calls = 0;
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      if (milliseconds === 60_000) timeoutControllers[0]?.abort();
    },
    timeoutSignalFactory: (timeoutMs) => {
      assert.equal(timeoutMs, 12_000);
      const controller = new AbortController();
      timeoutControllers.push(controller);
      return controller.signal;
    },
    fetchImpl: async (_input, init) => {
      calls++;
      assert(!("requestTimeoutMs" in (init ?? {})), "does not pass the custom timeout option to fetch");
      assert(init?.signal, "provides a fresh attempt signal");
      assert.equal(init.signal.aborted, false, "the retry is not given the prior attempt's expired timeout");
      attemptSignals.push(init.signal);
      return calls === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "60" } })
        : jsonResponse({ items: [] });
    },
  });

  await client.fetch("https://club.podplay.app/apis/v2/events?page=1", {
    requestTimeoutMs: 12_000,
    signal: callerController.signal,
  });
  assert.equal(calls, 2, "a long Retry-After does not exhaust the first attempt's timeout");
  assert.equal(timeoutControllers.length, 2, "creates a timeout signal for each HTTP attempt");
  assert.notEqual(attemptSignals[0], attemptSignals[1], "each attempt receives its own combined signal");
  assert.deepEqual(waits, [60_000]);
  callerController.abort();
  assert.equal(attemptSignals[1].aborted, true, "preserves the caller's cancellation signal");
}

async function testRequestSerializationAndSpacing(): Promise<void> {
  const waits: number[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 400,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => {
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return jsonResponse({ items: [] });
    },
  });

  await Promise.all([
    client.fetch("https://club.podplay.app/apis/v2/events/event-1/signups?page=1"),
    client.fetch("https://club.podplay.app/apis/v2/events/event-2/signups?page=1"),
    client.fetch("https://club.podplay.app/apis/v2/coupons?page=1"),
  ]);
  assert.equal(maximumInFlight, 1, "serializes concurrent endpoint calls");
  assert.equal(client.telemetry.signup_calls, 2);
  assert.equal(client.telemetry.coupon_calls, 1);
  assert(waits.filter((milliseconds) => milliseconds >= 350).length >= 2, "spaces HTTP calls by at least 350ms");
}

async function testSharedListingAndSuccessfulSignupCache(): Promise<void> {
  const now = Date.now();
  const event = {
    id: "shared-event",
    name: "Beginner Clinic",
    startTime: new Date(now + 86_400_000).toISOString(),
    status: "PUBLISHED",
    totalTeams: 8,
  };
  const eventsCache = new Map<string, Promise<any[]>>();
  const signupsCache = new Map<string, Promise<string[]>>();
  const clubId = "shared-cache-test";
  const clubCache = new Map([[
    clubId,
    Promise.resolve({ base: "https://club.podplay.app", apiKey: "not-recorded", timezone: "America/New_York" }),
  ]]);
  const couponCache = new Map([[
    `${clubId}:PROMO`,
    Promise.resolve({ valid: true, warning: null, checked_at: new Date().toISOString() }),
  ]]);
  const urls: string[] = [];
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async () => {},
    fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/apis/v2/events?")) return jsonResponse({ items: [event] });
      if (url.includes("/signups?")) return jsonResponse({ items: [] });
      throw new Error(`Unexpected test request: ${url}`);
    },
  });
  const args = (playerId: string) => ({
    clubId,
    player: { id: playerId, name: "Test Player", external_id: `external-${playerId}` },
    playbook: {
      key: "generic",
      name: "Generic follow-up",
      enabled: true,
      promo_code: "PROMO",
      offer_text: "A verified offer",
      next_program_names: ["Beginner Clinic"],
      message_guidance: null,
      holdout_pct: 0,
    },
    trigger: { event_id: "trigger", name: "Trigger", date: "2026-10-01" },
    classmatesExternalIds: [],
    socialEventsCache: eventsCache,
    socialSignupsCache: signupsCache,
    clubCache,
    couponCache,
    batchClient: client,
  });

  await Promise.all([
    buildRetentionContext(args("player-1")),
    buildRetentionContext(args("player-2")),
  ]);
  assert.equal(client.telemetry.listing_calls, 1, "shares one 14-day event-listing request across candidates");
  assert.equal(client.telemetry.signup_calls, 1, "shares successful signup snapshots across candidates");
  assert.equal(urls.filter((url) => url.includes("/apis/v2/events?")).length, 1);
  assert(new URL(urls[0]).searchParams.get("ipp") === "500", "uses a listing page size large enough for the current event set");
}

async function testExhausted429FailsContextLookup(): Promise<void> {
  const clubId = "rate-limited-context-test";
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async () => {},
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
  });
  let thrown: unknown;
  try {
    await buildRetentionContext({
      clubId,
      player: { id: "player", name: "Test Player", external_id: "external-player" },
      playbook: {
        key: "generic",
        name: "Generic",
        enabled: true,
        promo_code: null,
        offer_text: null,
        next_program_names: [],
        message_guidance: null,
        holdout_pct: 0,
      },
      trigger: { event_id: "trigger", name: "Trigger", date: "2026-10-01" },
      classmatesExternalIds: [],
      socialEventsCache: new Map(),
      socialSignupsCache: new Map(),
      clubCache: new Map([[
        clubId,
        Promise.resolve({ base: "https://club.podplay.app", apiKey: "not-recorded", timezone: "America/New_York" }),
      ]]),
      couponCache: new Map(),
      batchClient: client,
    });
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof RetentionContextError, "does not turn an exhausted 429 into an empty event listing");
  assert.equal(thrown.reason, "context_lookup_failed");
  assert.equal(client.telemetry.listing_calls, 4);
}

const verifiedLtpCoupon = {
  code: "LTPNEXT25",
  discountType: "PERCENT_OFF",
  value: 25,
  active: true,
  eligibleType: "EVENT_CLASS",
  eligibleTypes: ["EVENT_CLASS", "EVENT_EVENT"],
  eligibleEventIds: [],
};

async function withFakeCouponClubRead<T>(test: () => Promise<T>): Promise<T> {
  const originalFrom = (supabase as any).from;
  (supabase as any).from = (table: string) => {
    assert.equal(table, "clubs");
    return {
      select: (columns: string) => {
        assert.equal(columns, "platform_api_key, platform_subdomain, timezone");
        return {
          eq: (column: string, clubId: string) => {
            assert.equal(column, "id");
            assert.equal(clubId, "coupon-context-test");
            return {
              maybeSingle: async () => ({
                data: {
                  platform_api_key: "offline-test-key",
                  platform_subdomain: "offline-test",
                  timezone: "UTC",
                },
                error: null,
              }),
            };
          },
        };
      },
    };
  };
  try {
    return await test();
  } finally {
    (supabase as any).from = originalFrom;
  }
}

function makeNoProgramCouponArgs(client: RetentionPodplayBatchClient) {
  const clubId = "coupon-context-test";
  return {
    clubId,
    player: { id: "coupon-player", name: "Test Player", external_id: "external-coupon-player" },
    playbook: {
      key: "ltp_followup",
      name: "Learn to Play follow-up",
      enabled: true,
      promo_code: null,
      offer_text: null,
      next_program_names: ["Beginner Clinic"],
      message_guidance: null,
      holdout_pct: 0,
    },
    trigger: { event_id: "trigger", name: "Learn to Play Clinic", date: "2026-10-01" },
    classmatesExternalIds: [],
    socialEventsCache: new Map<string, Promise<any[]>>(),
    socialSignupsCache: new Map<string, Promise<string[]>>(),
    clubCache: new Map([[
      clubId,
      Promise.resolve({ base: "https://offline-test.podplay.app", apiKey: "offline-test-key", timezone: "UTC" }),
    ]]),
    couponCache: new Map(),
    batchClient: client,
  };
}

async function testCoupon429ExhaustionFailsClosed(): Promise<void> {
  let actualCouponCalls = 0;
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async () => {},
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/apis/v2/events") return jsonResponse({ items: [] });
      if (url.pathname === "/apis/v2/coupons") {
        actualCouponCalls++;
        return new Response("rate limited", { status: 429 });
      }
      throw new Error(`Unexpected PodPlay request: ${url.pathname}`);
    },
  });

  await withFakeCouponClubRead(async () => {
    let thrown: unknown;
    try {
      await buildRetentionContext(makeNoProgramCouponArgs(client));
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof RetentionContextError);
    assert.equal(thrown.reason, "context_lookup_failed");
    assert.equal(actualCouponCalls, 4);
    assert.equal(client.telemetry.coupon_calls, 4, "counts all initial-plus-retry coupon HTTP attempts");
    assert.equal(client.telemetry.rate_limit_count, 4);
    assert.equal(client.telemetry.retries.length, 3);
    assert.equal((thrown.diagnostics as any).coupon_lookup.status, "error");
    assert((thrown.diagnostics as any).coupon_lookup.errors.length > 0);
  });
}

async function testSuccessfulCouponFallbackIsCountedAndUsable(): Promise<void> {
  let actualCouponCalls = 0;
  const client = new RetentionPodplayBatchClient({
    minimumSpacingMs: 0,
    sleep: async () => {},
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/apis/v2/events") return jsonResponse({ items: [] });
      if (url.pathname === "/apis/v2/coupons") {
        actualCouponCalls++;
        return jsonResponse({ items: [verifiedLtpCoupon] });
      }
      throw new Error(`Unexpected PodPlay request: ${url.pathname}`);
    },
  });

  await withFakeCouponClubRead(async () => {
    const context = await buildRetentionContext(makeNoProgramCouponArgs(client));
    assert.equal(context.variant, "no_program");
    assert.deepEqual(context.promo, {
      code: "LTPNEXT25",
      offer_text: "25% off your next program",
    });
    assert.equal(actualCouponCalls, 1);
    assert.equal(client.telemetry.coupon_calls, 1, "counts the single live coupon lookup");
    assert.equal(client.telemetry.rate_limit_count, 0);
    assert.equal(client.telemetry.retries.length, 0);
  });
}

async function run(): Promise<void> {
  await test429RetryAfterAndTelemetry();
  await testRetryAfterHttpDate();
  await test429ExhaustionUsesExponentialBackoff();
  await testRetryAfterGetsFreshPerAttemptTimeout();
  await testRequestSerializationAndSpacing();
  await testSharedListingAndSuccessfulSignupCache();
  await testExhausted429FailsContextLookup();
  await testCoupon429ExhaustionFailsClosed();
  await testSuccessfulCouponFallbackIsCountedAndUsable();
  console.log("Retention PodPlay batch tests passed");
}

void run().catch((error) => {
  process.nextTick(() => { throw error; });
});