/**
 * GET/SELECT-only verification of the existing external Supabase.
 * Optional --classifier-parity executes ONLY in a disposable local fixture,
 * never DATABASE_URL or the external database's SQL/RPC endpoints.
 */
import { readFileSync } from "node:fs";
import { supabase } from "../lib/supabaseClient";
import { getDefaultClubSlug } from "../lib/clubResolver";
import { isLearnToPlayName } from "../lib/retentionContext";

async function all(build: () => any): Promise<any[]> {
  const rows: any[] = [];
  for (let n = 0; ; n += 1000) {
    const result = await build().range(n, n + 999);
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
}
async function optional(label: string, build: () => PromiseLike<any>) {
  const result = await build();
  if (result.error) { console.log(JSON.stringify({ check: label, unavailable: result.error.code })); return null; }
  return result.data;
}
async function main() {
  const club = await supabase.from("clubs").select("id").eq("slug", getDefaultClubSlug()).single();
  if (club.error || !club.data) throw new Error("Default club unavailable");
  const clubId = club.data.id;
  const coupons = await all(() => supabase.from("attendances").select("coupon_code")
    .eq("club_id", clubId).gte("booked_at", "2026-10-07T00:00:00Z").order("event_id").order("player_id"));
  console.log(JSON.stringify({ check: "coupons", booked_since: "2026-10-07T00:00:00Z", total: coupons.length,
    non_null_coupon_code: coupons.filter(row => row.coupon_code !== null).length,
    distinct_codes: [...new Set(coupons.filter(row => row.coupon_code !== null).map(row => row.coupon_code))].sort() }));
  for (const view of ["playbook_outcomes", "sms_optouts"]) {
    try {
      const rows = await all(() => supabase.from(view).select(view === "sms_optouts" ? "id,source,event_source,opted_out_at" : "sequence_id")
        .eq("club_id", clubId).order(view === "sms_optouts" ? "id" : "sequence_id"));
      console.log(JSON.stringify({ check: view, rows: rows.length,
        ...(view === "sms_optouts" ? { unattributed: rows.filter(row => row.source === "unattributed") } : {}) }));
    } catch (error: any) { console.log(JSON.stringify({ check: view, unavailable: error.code })); }
  }
  const baseline = await optional("ltp_baseline", () => supabase.from("ltp_baseline").select("*").eq("club_id", clubId));
  if (baseline) console.log(JSON.stringify({ check: "ltp_baseline", output: baseline }));
  const backfill = await optional("backfills", () => supabase.from("sms_optout_events").select("source").eq("club_id", clubId).eq("is_backfill", true));
  if (backfill) console.log(JSON.stringify({ check: "backfills", counts: Object.fromEntries(
    ["stop_reply", "carrier_21610", "manual"].map(source => [source, backfill.filter((row: any) => row.source === source).length])) }));
  if (process.argv.includes("--classifier-parity")) {
    const names = new Set((await all(() => supabase.from("attendances").select("program_name")
      .eq("club_id", clubId).order("event_id").order("player_id"))).map(row => row.program_name).filter((name): name is string => typeof name === "string"));
    const { operatorPostgresFixture } = await import("../lib/__tests__/fixtures/operatorPostgres");
    const fixture = operatorPostgresFixture();
    try {
      const source = readFileSync(new URL("../../migrations/022_retention_reports_and_optouts.sql", import.meta.url), "utf8");
      fixture.sql(source.slice(source.indexOf("CREATE OR REPLACE FUNCTION public.retention_report_is_ltp"),
        source.indexOf("CREATE OR REPLACE VIEW public.sms_optouts")));
      let divergences = 0;
      for (const name of names) {
        const sql = fixture.sql(`SELECT retention_report_is_ltp('${name.replaceAll("'", "''")}')`) === "t";
        if (sql !== isLearnToPlayName(name)) divergences++;
      }
      console.log(JSON.stringify({ check: "classifier_parity", distinct_stored_program_names: names.size, divergences }));
    } finally { fixture.close(); }
  }
}
main().catch(error => { console.error("Read-only verification failed:", error?.code ?? error?.name ?? "unknown"); process.exitCode = 1; });
