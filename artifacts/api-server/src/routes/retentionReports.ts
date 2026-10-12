import { Router, type IRouter } from "express";
import { DEFAULT_RETENTION_FLOW_KEY, LTP_FOLLOWUP_FLOW } from "../lib/retentionFlows";
import { GetRetentionReportsQueryParams, GetRetentionReportsResponse } from "@workspace/api-zod";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";

const router: IRouter = Router();
const outcomeColumns = [
  "sequence_id", "player_id", "name", "playbook_key", "step1_sent_at", "step2_sent_at", "last_sent_at",
  "sequence_status", "exit_reason", "replied", "booked", "booked_event_id", "booked_program_name",
  "booking_created_at", "credited_step", "coupon_code_used", "days_to_book", "opted_out", "opted_out_at",
  "optout_after_step", "optout_message_id", "hours_to_optout",
  "step1_drafted", "step1_approved", "step1_sent", "step1_delivered", "step1_booked",
  "step2_drafted", "step2_approved", "step2_sent", "step2_delivered", "step2_booked",
  "outcome", "window_closes_at", "is_test",
].join(",");
const optoutColumns = "id,player_id,name,opted_out_at,source,event_source,twilio_optout_type,playbook_key,step,body,optout_message_id,is_test";

// Every builder must include the server-resolved club predicate. GET only:
// no provider calls, RPCs, player mutations, or browser Supabase credentials.
async function readAll(build: () => any): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await build().range(offset, offset + 999);
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
}

router.get("/retention/reports", requireClub, async (req, res) => {
  const parsed = GetRetentionReportsQueryParams.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid report filters" });
  const { clubId } = req as ClubScopedRequest;
  const period = parsed.data.period ?? "30d";
  const playbookKey = parsed.data.playbook_key ?? DEFAULT_RETENTION_FLOW_KEY;
  const cutoff = period === "all" ? null
    : new Date(Date.now() - (period === "90d" ? 90 : 30) * 86400_000).toISOString();
  try {
    const [keys, outcomes, optouts, baseline, testPlayers] = await Promise.all([
      readAll(() => supabase.from("playbook_outcomes").select("playbook_key,sequence_id,player_id")
        .eq("club_id", clubId).eq("is_test", false).order("sequence_id")),
      readAll(() => {
        let query = supabase.from("playbook_outcomes").select(outcomeColumns)
          .eq("club_id", clubId).eq("playbook_key", playbookKey).eq("is_test", false);
        if (cutoff) query = query.gte("step1_sent_at", cutoff);
        return query.order("step1_sent_at", { ascending: false, nullsFirst: false }).order("sequence_id");
      }),
      readAll(() => supabase.from("sms_optouts").select(optoutColumns).eq("club_id", clubId)
        .order("opted_out_at", { ascending: false, nullsFirst: false }).order("id")),
      // The baseline view is a Learn to Play report; other flows have none yet.
      playbookKey === LTP_FOLLOWUP_FLOW.key
        ? supabase.from("ltp_baseline").select("n_players,n_booked,rate").eq("club_id", clubId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      readAll(() => supabase.from("players").select("id").eq("club_id", clubId).eq("is_test", true).order("id")),
    ]);
    if (baseline.error) throw baseline.error;
    const testIds = new Set(testPlayers.map(row => row.id));
    res.json(GetRetentionReportsResponse.parse({
      playbook_keys: [...new Set(keys.filter(row => !testIds.has(row.player_id)).map(row => row.playbook_key))].sort(),
      outcomes: outcomes.filter(row => !testIds.has(row.player_id)),
      optouts, baseline: baseline.data, club_opt_out_total: optouts.filter(row => !row.is_test).length, period,
    }));
  } catch (error: any) {
    req.log.error({ code: error?.code, reason: error?.message }, "Retention reports read failed");
    const missing = ["PGRST205", "42P01", "42703"].includes(error?.code);
    res.status(missing ? 503 : 500).json({
      error: missing ? "Reports are unavailable until migrations 022, 023 and 027 are applied in Supabase SQL Editor."
        : "Could not read retention reports",
    });
  }
});

export default router;
