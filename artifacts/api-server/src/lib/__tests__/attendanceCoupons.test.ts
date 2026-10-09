import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttendanceCouponResolver, resolveInsertedAttendanceCoupon } from "../attendanceCoupons.js";

test("coupon resolver follows real signup→order→coupon shape despite zero summary discount and caches", async () => {
  const calls: string[] = [];
  const resolve = createAttendanceCouponResolver("https://fixture.podplay.app", "fixture", {
    sleep: async () => {},
    fetchImpl: async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify(String(url).includes("/orders/") ? { coupon: { id: "coupon1" } } : { code: "AJF50%OP" }));
    },
  });
  const signup = { coupon: null, order: { id: "order1" }, summary: { couponDiscount: 0 } };
  assert.equal(await resolve(signup), "AJF50%OP");
  assert.equal(await resolve(signup), "AJF50%OP");
  assert.equal(calls.length, 2);
  assert.deepEqual(resolve.getStats(), { orderCalls: 1, couponCalls: 1 });
  assert.equal(await resolve({ couponCode: "LEGACY" }), "LEGACY");
  assert.equal(await resolve({ coupon: null }), null);
});

test("existing attendance rows never look up orders and retain null/non-null codes; new orders share coupon cache", async () => {
  const calls: string[] = [];
  const resolve = createAttendanceCouponResolver("https://fixture.podplay.app", "fixture", {
    sleep: async () => {},
    fetchImpl: async url => {
      calls.push(url);
      return new Response(JSON.stringify(url.includes("/orders/") ? { coupon: { id: "shared" } } : { code: "CODE" }));
    },
  });
  const existing = new Map<string, string | null>([["old-null", null], ["old-code", "KEEP"]]);
  const signup = { order: { id: "one" } };
  assert.equal(await resolveInsertedAttendanceCoupon(resolve, signup, "old-null", existing), null);
  assert.equal(await resolveInsertedAttendanceCoupon(resolve, signup, "old-code", existing), "KEEP");
  assert.equal(calls.length, 0);
  assert.equal(await resolveInsertedAttendanceCoupon(resolve, signup, "new-one", existing), "CODE");
  assert.equal(await resolveInsertedAttendanceCoupon(resolve, { order: { id: "two" } }, "new-two", existing), "CODE");
  assert.deepEqual(resolve.getStats(), { orderCalls: 2, couponCalls: 1 });
  assert.equal(await resolveInsertedAttendanceCoupon(resolve, {}, "new-no-order", existing), null);
});

test("coupon reads fail explicitly rather than replacing stored codes with null", async () => {
  const resolve = createAttendanceCouponResolver("https://fixture.podplay.app", "fixture", {
    sleep: async () => {}, fetchImpl: async () => new Response("", { status: 503 }),
  });
  await assert.rejects(resolve({ order: { id: "order" } }), /503/);
  const malformed = createAttendanceCouponResolver("https://fixture.podplay.app", "fixture", {
    sleep: async () => {}, fetchImpl: async () => new Response("{}"),
  });
  await assert.rejects(malformed({ order: { id: "order" } }), /omitted coupon evidence/);
});
