/**
 * PodPlay signup coupon codes live on the linked order/coupon resource.
 * Verified against a real EVENT_SIGNUP order; summary.couponDiscount may be 0
 * even when the order used a coupon. Never infer a code from discount amounts.
 */
export function createAttendanceCouponResolver(podplayBase, apiKey, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const orders = new Map();
  const coupons = new Map();
  async function read(path) {
    await sleep(400);
    let response = await fetchImpl(`${podplayBase}/apis/v2${path}`, { headers: { "x-api-key": apiKey } });
    if (response.status === 429) {
      await sleep(3000);
      response = await fetchImpl(`${podplayBase}/apis/v2${path}`, { headers: { "x-api-key": apiKey } });
    }
    // A lookup failure is not evidence that there was no coupon.
    if (!response.ok) throw new Error(`PodPlay coupon read ${path} returned ${response.status}`);
    return response.json();
  }
  const code = value => typeof value === "string" && value.trim() ? value.trim() : null;
  const cached = (cache, id, path) => {
    if (!cache.has(id)) cache.set(id, read(path));
    return cache.get(id);
  };
  return async function resolveCoupon(signup) {
    const legacy = code(signup.couponCode);
    if (legacy) return legacy;
    let coupon = signup.coupon;
    // The verified signup had coupon:null, order:{id}; the order had coupon:{id}.
    if (!coupon?.id && !coupon?.code && signup.order?.id) {
      const order = await cached(orders, signup.order.id, `/orders/${encodeURIComponent(signup.order.id)}`);
      if (!Object.hasOwn(order, "coupon")) throw new Error("PodPlay order omitted coupon evidence");
      coupon = order.coupon;
    }
    if (!coupon) return null;
    const expanded = code(coupon.code);
    if (expanded) return expanded;
    if (!coupon.id) throw new Error("PodPlay coupon reference has no id or code");
    const resource = await cached(coupons, coupon.id, `/coupons/${encodeURIComponent(coupon.id)}`);
    const resolved = code(resource.code);
    if (!resolved) throw new Error("PodPlay coupon resource has no code");
    return resolved;
  };
}
