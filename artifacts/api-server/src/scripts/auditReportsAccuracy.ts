/**
 * GET/SELECT-only audit. Never imports the app, schedulers, or sending helpers.
 * Credentials are used only by clients and are never logged or saved.
 */
import { readFileSync, writeFileSync } from "node:fs";
import twilio from "twilio";
import { supabase } from "../lib/supabaseClient";
import { getDefaultClubSlug } from "../lib/clubResolver";

async function rows(build: () => any): Promise<any[]> {
  const result: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await build().range(offset, offset + 999);
    if (error) throw new Error(`Read failed: ${error.code}`);
    result.push(...data);
    if (data.length < 1000) return result;
  }
}
const normalize = (value: string) => value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
async function main() {
  const { data: club, error } = await supabase.from("clubs")
    .select("id,platform_subdomain,platform_api_key").eq("slug", getDefaultClubSlug()).single();
  if (error || !club) throw new Error("Club unavailable");
  if (process.argv.includes("--sends")) {
    const sequences = await rows(() => supabase.from("retention_sequences").select("*")
      .eq("club_id", club.id).eq("playbook_key", "ltp_followup").order("id"));
    const audit = await rows(() => supabase.from("retention_ltp_test_audit").select("*")
      .eq("club_id", club.id).order("created_at"));
    const controls = await rows(() => supabase.from("retention_ltp_test_controls").select("*")
      .eq("club_id", club.id).order("sequence_id"));
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const output: any[] = [];
    for (const sequence of sequences) {
      const { data: player, error: pe } = await supabase.from("players").select("name,phone")
        .eq("club_id", club.id).eq("id", sequence.player_id).single();
      if (pe) throw new Error(`Player read failed: ${pe.code}`);
      for (const step of [1, 2]) {
        const sentAt = sequence[`step${step}_sent_at`];
        if (!sentAt) continue;
        const messageId = sequence[`step${step}_message_id`];
        const { data: message, error: me } = await supabase.from("messages").select("*").eq("id", messageId).single();
        if (me) throw new Error(`Message read failed: ${me.code}`);
        const ledger = await rows(() => supabase.from("contact_ledger").select("*")
          .eq("club_id", club.id).eq("message_id", messageId).order("id"));
        const { data: candidate, error: ce } = await supabase.from("retention_candidates")
          .select("*").eq("message_id", messageId).maybeSingle();
        if (ce) throw new Error(`Candidate read failed: ${ce.code}`);
        const provider = message.twilio_message_sid
          ? await client.messages(message.twilio_message_sid).fetch() : null;
        output.push({
          sequence_id: sequence.id, message_id: messageId, player: player!.name,
          player_phone: player!.phone, destination: provider?.to ?? null, step, sent_at: sentAt,
          provider_sent_at: provider?.dateSent?.toISOString() ?? null,
          provider_status: provider?.status ?? null,
          destination_is_test: provider && player!.phone ? normalize(provider.to) !== normalize(player!.phone) : null,
          message_delivery_kind: message.retention_delivery_kind,
          sequence_delivery_kind: sequence[`step${step}_delivery_kind`],
          ledger: ledger.map(row => ({ is_test: row.is_test, sent_at: row.sent_at })),
          step2_eligibility: step === 2 ? { candidate, control: controls.find(row => row.sequence_id === sequence.id),
            audit: audit.filter(row => row.candidate_id === controls.find(control => control.sequence_id === sequence.id)?.candidate_id) } : null,
        });
      }
    }
    writeFileSync("/tmp/reports-send-audit.json", JSON.stringify(output, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ corrected_texted: new Set(output.filter(row => !output.some(
      other => other.sequence_id === row.sequence_id && other.destination_is_test !== false)).map(row => row.sequence_id)).size }));
  }
  if (process.argv.includes("--coupons")) {
    const since = new Date(Date.now() - 90 * 86400_000).toISOString();
    const attendance = await rows(() => supabase.from("attendances").select("event_id,coupon_code,booked_at,attended_at")
      .eq("club_id", club.id).gte("attended_at", since).order("attended_at", { ascending: false }).order("event_id").order("player_id"));
    const eventIds = [...new Set([...attendance.filter(row => row.coupon_code), ...attendance].map(row => row.event_id))];
    console.log(JSON.stringify({ attendance_rows: attendance.length, known_coupon_rows: attendance.filter(row => row.coupon_code).length,
      events: eventIds.length, since }));
    function couponPaths(value: any, path = "$"): { path: string; value: any }[] {
      if (!value || typeof value !== "object") return [];
      return Object.entries(value).flatMap(([key, item]) => {
        const next = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
        const meaningful = typeof item === "number" ? item > 0 : typeof item === "string" ? item.trim().length > 0
          : typeof item === "object" && item !== null && Object.keys(item).length > 0;
        return [...(/coupon|promo/i.test(key) && meaningful ? [{ path: next, value: item }] : []),
          ...couponPaths(item, next)];
      });
    }
    let checked = 0, signupCount = 0;
    for (const eventId of eventIds) {
      const response = await fetch(`https://${club.platform_subdomain}.podplay.app/apis/v2/events/${eventId}/signups`,
        { headers: { "x-api-key": club.platform_api_key } });
      if (!response.ok) { console.log(JSON.stringify({ event: eventId, status: response.status, checked, signupCount })); return; }
      const raw: any = await response.json();
      checked++; signupCount += raw.items?.length ?? 0;
      const found = couponPaths(raw);
      if (found.length) {
        writeFileSync("/tmp/reports-coupon-raw.json", JSON.stringify({ eventId, raw }, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ eventId, checked, signupCount, paths: found }, null, 2)); return;
      }
      if (checked % 100 === 0) console.log(JSON.stringify({ checked, signupCount }));
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    console.log(JSON.stringify({ checked, signupCount, found: false, scope: "signup payloads for attended events in last 90 days" }));
  }
  if (process.argv.includes("--orders")) {
    const since = new Date(Date.now() - 90 * 86400_000).toISOString();
    let checked = 0;
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ createdStartDate: since, createdEndDate: new Date().toISOString(),
        page: String(page), ipp: "100", source: "EVENT_SIGNUP", expand: "coupon" });
      const response = await fetch(`https://${club.platform_subdomain}.podplay.app/apis/v2/orders?${params}`,
        { headers: { "x-api-key": club.platform_api_key } });
      if (!response.ok) { console.log(JSON.stringify({ orders_status: response.status, checked })); return; }
      const raw: any = await response.json();
      for (let index = 0; index < (raw.items?.length ?? 0); index++) {
        const order = raw.items[index]; checked++;
        if (order.coupon?.id || order.coupon?.code) {
          writeFileSync("/tmp/reports-coupon-order.json", JSON.stringify({ index, raw }, null, 2), { mode: 0o600 });
          console.log(JSON.stringify({ checked, order_id: order.id, createdDate: order.createdDate,
            source: order.source, event: order.event, user: order.user, coupon: order.coupon,
            path: `$.items[${index}].coupon`, links: order._links }));
          return;
        }
      }
      if (page % 10 === 0) console.log(JSON.stringify({ page, checked }));
      if ((raw.items?.length ?? 0) < 100) { console.log(JSON.stringify({ checked, found: false, scope: "EVENT_SIGNUP orders created in last 90 days" })); return; }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
  if (process.argv.includes("--coupon-detail")) {
    const saved = JSON.parse(readFileSync("/tmp/reports-coupon-order.json", "utf8"));
    const reference = saved.raw.items[saved.index];
    const get = async (path: string) => {
      const response = await fetch(`https://${club.platform_subdomain}.podplay.app/apis/v2${path}`,
        { headers: { "x-api-key": club.platform_api_key } });
      if (!response.ok) throw new Error(`Read failed: ${response.status}`);
      return response.json() as Promise<any>;
    };
    const order = await get(`/orders/${reference.id}`);
    const coupon = await get(`/coupons/${order.coupon.id}`);
    const signups = await get(`/events/${order.event.id}/signups`);
    const match = signups.items?.filter((signup: any) => signup.owner?.id === order.user.id);
    writeFileSync("/tmp/reports-coupon-detail.json", JSON.stringify({ order, coupon, signups }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ order: { id: order.id, createdDate: order.createdDate, coupon: order.coupon, status: order.status },
      coupon: { id: coupon.id, code: coupon.code },
      signups: match?.map((signup: any) => ({ id: signup.id, keys: Object.keys(signup), couponCode: signup.couponCode ?? null,
        coupon: signup.coupon, order: signup.order, summary: { couponDiscount: signup.summary?.couponDiscount,
          invitation_created_at: signup.summary?.invitation?.createdDate }, links: { order: signup._links?.order } })) }, null, 2));
  }
  if (process.argv.includes("--summary")) {
    const audit = JSON.parse(readFileSync("/tmp/reports-send-audit.json", "utf8")) as any[];
    const realIds = [...new Set(audit.filter(row => !audit.some(other =>
      other.sequence_id === row.sequence_id && other.destination_is_test !== false)).map(row => row.sequence_id))];
    const source = await rows(() => supabase.from("playbook_outcomes")
      .select("sequence_id,booked,coupon_code_used,step1_sent_at,step2_sent_at").eq("club_id", club.id).in("sequence_id", realIds).order("sequence_id"));
    const projected = source.map(row => {
      const closes = Math.max(Date.parse(row.step1_sent_at) + 7 * 86400_000, row.step2_sent_at ? Date.parse(row.step2_sent_at) : 0) + 14 * 86400_000;
      return { ...row, outcome: row.booked ? "booked" : Date.now() <= closes ? "in_window" : "no_booking" };
    });
    const coupons = await rows(() => supabase.from("attendances").select("coupon_code")
      .eq("club_id", club.id).gte("booked_at", "2026-10-01T00:00:00Z").order("event_id").order("player_id"));
    console.log(JSON.stringify({ projection_only_until_view_migration: true, texted: projected.length,
      in_window: projected.filter(row => row.outcome === "in_window").length,
      booked: projected.filter(row => row.outcome === "booked").length,
      closed: projected.filter(row => row.outcome !== "in_window").length,
      code_redemptions: projected.filter(row => row.coupon_code_used).length,
      backfill_verified: { total: coupons.length, non_null: coupons.filter(row => row.coupon_code).length,
        counts: Object.fromEntries([...new Set(coupons.filter(row => row.coupon_code).map(row => row.coupon_code))].map(code =>
          [code, coupons.filter(row => row.coupon_code === code).length])) } }, null, 2));
  }
}
main().catch(error => { console.error("Audit failed:", error.code ?? error.name,
  /^(Read|Player|Message|Candidate|Club)/.test(error.message ?? "") ? error.message : "No writes performed"); process.exitCode = 1; });
