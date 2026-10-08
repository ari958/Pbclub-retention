/**
 * Default: read-only dry run. --apply updates ONLY existing coupon_code values.
 * No sync job, player changes, winback attribution, sends, or approvals.
 */
import { supabase } from "../lib/supabaseClient";
import { getDefaultClubSlug } from "../lib/clubResolver";
import { createAttendanceCouponResolver } from "../lib/attendanceCoupons.js";
import { ATTENDANCE_SIGNUP_STATUSES } from "../lib/signupStatus.js";

const since = "2026-10-01T00:00:00Z";
const priorities: Record<string, number> = { CHECKED_IN: 2, CONFIRMED: 2, INVALID: 1 };
async function main() {
  const apply = process.argv.includes("--apply");
  const { data: club, error } = await supabase.from("clubs")
    .select("id,platform_subdomain,platform_api_key").eq("slug", getDefaultClubSlug()).single();
  if (error || !club) throw new Error("Club unavailable");
  const rows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await supabase.from("attendances").select("player_id,event_id,coupon_code,booked_at")
      .eq("club_id", club.id).gte("booked_at", since).order("event_id").order("player_id").range(offset, offset + 999);
    if (result.error) throw new Error(`Attendance read failed: ${result.error.code}`);
    rows.push(...result.data);
    if (result.data.length < 1000) break;
  }
  const resolve = createAttendanceCouponResolver(`https://${club.platform_subdomain}.podplay.app`, club.platform_api_key);
  const playerMap = new Map<string, string>();
  for (const playerId of new Set(rows.map(row => row.player_id))) {
    const { data, error: pe } = await supabase.from("players").select("external_id").eq("club_id", club.id).eq("id", playerId).single();
    if (pe || !data) throw new Error("Player read failed");
    playerMap.set(playerId, data.external_id);
  }
  // Resolve the complete patch set before making any writes.
  const patches: any[] = [];
  let checked = 0, unmatched = 0;
  for (const eventId of new Set(rows.map(row => row.event_id))) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const response = await fetch(`https://${club.platform_subdomain}.podplay.app/apis/v2/events/${eventId}/signups`,
      { headers: { "x-api-key": club.platform_api_key } });
    if (!response.ok) throw new Error(`Signup read failed: ${response.status}`);
    const payload = await response.json() as any;
    for (const row of rows.filter(item => item.event_id === eventId)) {
      const matches = (payload.items ?? []).filter((signup: any) =>
        signup.owner?.id === playerMap.get(row.player_id) && ATTENDANCE_SIGNUP_STATUSES.has((signup.status ?? "").toUpperCase()));
      matches.sort((a: any, b: any) => (priorities[b.status] ?? 0) - (priorities[a.status] ?? 0));
      if (!matches.length) { unmatched++; continue; }
      const coupon = await resolve(matches[0]);
      checked++;
      if (coupon !== row.coupon_code) patches.push({ ...row, resolved_code: coupon });
    }
  }
  let changed = 0;
  if (apply) for (const patch of patches) {
    let query = supabase.from("attendances").update({ coupon_code: patch.resolved_code })
      .eq("club_id", club.id).eq("player_id", patch.player_id).eq("event_id", patch.event_id).eq("booked_at", patch.booked_at);
    query = patch.coupon_code === null ? query.is("coupon_code", null) : query.eq("coupon_code", patch.coupon_code);
    const { data, error: ue } = await query.select("event_id,coupon_code");
    if (ue || data?.length !== 1) throw new Error(`Coupon patch failed or changed concurrently; ${changed} already applied`);
    changed++;
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry_run", since, total: rows.length, checked, unmatched, changed,
    proposed: patches.map(patch => ({ event_id: patch.event_id, player_id: patch.player_id,
      previous: patch.coupon_code, coupon_code: patch.resolved_code })) }, null, 2));
}
main().catch(error => { console.error("Coupon backfill stopped:", error.message); process.exitCode = 1; });
