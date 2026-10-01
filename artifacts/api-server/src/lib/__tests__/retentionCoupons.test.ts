import assert from "node:assert/strict";
import { supabase } from "../supabaseClient.js";
import { validateRetentionCoupon } from "../retentionCoupons.js";

const liveLtpCouponShape = {
  code: "LTPNEXT25",
  discountType: "PERCENT_OFF",
  value: 25,
  active: true,
  status: null,
  startDate: null,
  endDate: null,
  eligibleType: "EVENT_CLASS",
  eligibleTypes: ["EVENT_CLASS", "EVENT_EVENT"],
  eligibleEventIds: [],
};

const originalFrom = (supabase as any).from;
const originalFetch = globalThis.fetch;
let couponResponse: any;
let fetchError: Error | null = null;

(supabase as any).from = (table: string) => {
  assert.equal(table, "clubs");
  return {
    select: (columns: string) => {
      assert.equal(columns, "platform_api_key, platform_subdomain, timezone");
      return {
        eq: (column: string, clubId: string) => {
          assert.equal(column, "id");
          assert.equal(clubId, "test-club");
          return {
            maybeSingle: async () => ({
              data: {
                platform_api_key: "test-api-key",
                platform_subdomain: "coupon-test",
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

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(String(input), "https://coupon-test.podplay.app/apis/v2/coupons?page=1&ipp=100");
  assert.equal((init?.headers as Record<string, string>)["x-api-key"], "test-api-key");
  if (fetchError) throw fetchError;
  return new Response(JSON.stringify({ items: [couponResponse] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

function dateOffset(days: number): string {
  const date = new Date(`${today}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function validate(coupon: any, code = "LTPNEXT25") {
  couponResponse = coupon;
  return validateRetentionCoupon("test-club", code);
}

try {
  const authentic = await validate({ ...liveLtpCouponShape });
  assert.equal(authentic.valid, true, "the live LTPNEXT25 percentage and generic event scope verify");
  assert.equal(authentic.warning, null);

  const wrongValue = await validate({ ...liveLtpCouponShape, value: 20 });
  assert.equal(wrongValue.valid, false, "a different percentage is not accepted");
  assert.match(wrongValue.warning ?? "", /not verified as a 25% discount/);

  const wrongType = await validate({ ...liveLtpCouponShape, discountType: "AMOUNT_OFF" });
  assert.equal(wrongType.valid, false, "a fixed-amount coupon is not accepted as a percentage");
  assert.match(wrongType.warning ?? "", /verified percentage discount/);

  const missingValue = { ...liveLtpCouponShape } as Record<string, unknown>;
  delete missingValue.value;
  const absentBenefit = await validate(missingValue);
  assert.equal(absentBenefit.valid, false, "missing benefit data fails closed");
  assert.match(absentBenefit.warning ?? "", /not verified as a 25% discount/);

  const missingScope = { ...liveLtpCouponShape } as Record<string, unknown>;
  delete missingScope.eligibleTypes;
  const absentApplicability = await validate(missingScope);
  assert.equal(absentApplicability.valid, false, "missing program applicability fails closed");
  assert.match(absentApplicability.warning ?? "", /applicability is not verified/);

  const eventRestricted = await validate({ ...liveLtpCouponShape, eligibleEventIds: ["specific-event"] });
  assert.equal(eventRestricted.valid, false, "an event-specific restriction is incompatible with a generic booking offer");
  assert.match(eventRestricted.warning ?? "", /applicability is not verified/);

  const unrelatedScope = await validate({
    ...liveLtpCouponShape,
    eligibleType: "MEMBERSHIP",
    eligibleTypes: ["MEMBERSHIP"],
  });
  assert.equal(unrelatedScope.valid, false, "non-program applicability is rejected");
  assert.match(unrelatedScope.warning ?? "", /applicability is not verified/);

  const datedCoupon = {
    ...liveLtpCouponShape,
    startDate: dateOffset(-1),
    endDate: dateOffset(1),
  };
  assert.equal((await validate(datedCoupon)).valid, true, "an active coupon within its inclusive date range verifies");

  const inactive = await validate({ ...liveLtpCouponShape, active: false });
  assert.equal(inactive.valid, false, "inactive coupons remain invalid");
  assert.match(inactive.warning ?? "", /inactive or outside its valid date range/);

  const notStarted = await validate({ ...liveLtpCouponShape, startDate: dateOffset(1) });
  assert.equal(notStarted.valid, false, "a coupon starting in the future is invalid");
  const expired = await validate({ ...liveLtpCouponShape, endDate: dateOffset(-1) });
  assert.equal(expired.valid, false, "an expired coupon is invalid");

  const ordinaryCoupon = await validate({ code: "ORDINARY10", active: true }, "ORDINARY10");
  assert.equal(ordinaryCoupon.valid, true, "non-LTP coupons retain active/date-only validation semantics");
  assert.equal(ordinaryCoupon.warning, null);

  fetchError = new Error("network unavailable");
  const unavailable = await validate({ ...liveLtpCouponShape });
  assert.equal(unavailable.valid, false, "network errors fail closed");
  assert.match(unavailable.warning ?? "", /Could not verify coupon LTPNEXT25: network unavailable/);
} finally {
  (supabase as any).from = originalFrom;
  globalThis.fetch = originalFetch;
}

console.log("Retention coupon tests passed");