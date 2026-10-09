/** Read-only replay of the last completed sync's attendance cohort; no sync is run. */
import { writeFileSync } from "node:fs";
import { supabase } from "../lib/supabaseClient";
import { getDefaultClubSlug } from "../lib/clubResolver";
import { ATTENDANCE_SIGNUP_STATUSES } from "../lib/signupStatus.js";
async function read(q: any): Promise<any> { const { data, error } = await q; if (error) throw new Error(error.code); return data; }
async function main() {
  const club = await read(supabase.from("clubs").select("id,platform_subdomain,platform_api_key").eq("slug", getDefaultClubSlug()).single());
  const job = await read(supabase.from("jobs").select("started_at,finished_at,stats").eq("id", "sync_events").single());
  const cutoff = new Date(Date.parse(job.started_at) - 14 * 86400_000).toISOString();
  const rows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await read(supabase.from("attendances").select("player_id,event_id,attended_at,program_name,coupon_code")
      .eq("club_id", club.id).gte("attended_at", cutoff).lt("attended_at", job.started_at)
      .order("event_id").order("player_id").range(offset, offset + 999));
    rows.push(...page); if (page.length < 1000) break;
  }
  console.log(JSON.stringify({ baseline_started_at: job.started_at, stats: job.stats, stored_cohort_rows: rows.length }));
  const players = await read(supabase.from("players").select("id,external_id").eq("club_id", club.id).in("id", [...new Set(rows.map(r => r.player_id))]));
  const external = new Map(players.map((p: any) => [p.id, p.external_id]));
  let auditCalls = 0;
  async function get(path: string): Promise<any> {
    await new Promise(resolve => setTimeout(resolve, 400));
    auditCalls++;
    const response = await fetch(`https://${club.platform_subdomain}.podplay.app/apis/v2${path}`,
      { headers: { "x-api-key": club.platform_api_key } });
    if (!response.ok) throw new Error(`Read-only replay unavailable: ${response.status}`);
    return response.json();
  }
  // Event counts include empty sessions; final attendance rows can also be
  // fewer than upserts because of the legacy program/start-time uniqueness.
  const events: string[] = [];
  for (let page = 1; ; page++) {
    const payload = await get(`/events?startTime=${encodeURIComponent(cutoff)}&startTimeTo=${encodeURIComponent(job.started_at)}&page=${page}&ipp=100`);
    if (!Array.isArray(payload.items)) throw new Error("Invalid event payload");
    for (const event of payload.items) {
      const time = Date.parse(event.startTime);
      if (time >= Date.parse(cutoff) && time < Date.parse(job.started_at)) events.push(event.id);
    }
    if (payload.items.length < 100) break;
    if (page >= 100) throw new Error("Event pagination incomplete");
  }
  if (events.length !== job.stats.eventsPast) throw new Error("Current event cohort differs from the baseline");
  const orders = new Set<string>(), coupons = new Set<string>();
  let matched = 0, checkedEvents = 0;
  for (const event of events) {
    const signups: any[] = [];
    for (let page = 1; ; page++) {
      const data = await get(`/events/${encodeURIComponent(event)}/signups?page=${page}&ipp=100`);
      if (!Array.isArray(data.items)) throw new Error("Invalid signup payload");
      signups.push(...data.items);
      if (data.items.length < 100) break;
      if (page >= 100) throw new Error("Signup pagination incomplete");
    }
    const playerExternalIds = new Set(external.values());
    for (const signup of signups) {
      if (!playerExternalIds.has(signup.owner?.id) || !ATTENDANCE_SIGNUP_STATUSES.has((signup.status ?? "").toUpperCase())) continue;
      matched++;
      if (signup.couponCode?.trim()) continue;
      if (signup.coupon?.code?.trim()) continue;
      if (signup.coupon?.id) coupons.add(signup.coupon.id);
      else if (signup.order?.id) orders.add(signup.order.id);
    }
    if (++checkedEvents % 30 === 0) console.log(JSON.stringify({ checkedEvents, matched, distinctOrders: orders.size }));
  }
  if (matched !== job.stats.signupsMatched) throw new Error("Current matched signup count differs from the baseline");
  let checkedOrders = 0;
  for (const id of orders) {
    const order = await get(`/orders/${encodeURIComponent(id)}`);
    if (!Object.hasOwn(order, "coupon")) throw new Error("Missing coupon evidence");
    if (order.coupon?.id && !order.coupon?.code?.trim()) coupons.add(order.coupon.id);
    if (++checkedOrders % 100 === 0) console.log(JSON.stringify({ checkedOrders }));
  }
  const result = {
    baseline_started_at: job.started_at, baseline_finished_at: job.finished_at, matched_rows: matched, events: events.length,
    comparison: "Read-only replay using current raw signup/order data for the stored baseline cohort; not historical HTTP telemetry",
    before_unoptimized_resolver: { order_calls: orders.size, coupon_calls: coupons.size, total: orders.size + coupons.size },
    after_existing_row_replay: { order_calls: 0, coupon_calls: 0, total: 0 },
    readonly_measurement_calls: auditCalls,
  };
  writeFileSync("/tmp/attendance-coupon-cost.json", JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error("Read-only cost measurement failed:", error.message); process.exitCode = 1; });
