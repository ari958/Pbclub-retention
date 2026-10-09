/** GET/SELECT only; never imports the application, scheduler, or dispatch helpers. */
import { readFileSync, writeFileSync } from "node:fs";
import twilio from "twilio";
import { supabase } from "../lib/supabaseClient";
import { getDefaultClubSlug } from "../lib/clubResolver";
import { buildLtpBookingSnapshot, createQueueBookingOptions } from "../lib/ltpBookingSnapshot";

async function read(query: any) {
  const { data, error } = await query;
  if (error) throw new Error(`Read failed: ${error.code}`);
  return data;
}
async function main() {
  const club = await read(supabase.from("clubs").select("id").eq("slug", getDefaultClubSlug()).single());
  if (process.argv.includes("--jobs")) {
    const jobs = await read(supabase.from("jobs").select("*").limit(100));
    writeFileSync("/tmp/ltp-recovery-jobs.json", JSON.stringify(jobs, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(jobs.map((j: any) => ({ keys: Object.keys(j), id: j.id,
      type: j.type, status: j.status, started_at: j.started_at, completed_at: j.completed_at, result: j.result }))));
    return;
  }
  if (process.argv.includes("--stored-detail")) {
    const stored = JSON.parse(readFileSync("/tmp/ltp-recovery-stored.json", "utf8"));
    const log = readFileSync(process.argv[process.argv.indexOf("--stored-detail") + 1], "utf8");
    const liveRows = log.split("\n").filter(line => line.startsWith('{"player":')).map(line => JSON.parse(line));
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    for (const row of stored.players) {
      const evidence = liveRows.find((entry: any) => entry.player === row.player.name);
      if (!evidence) throw new Error("Missing completed live booking evidence");
      row.upcoming_bookings = evidence.upcoming_bookings;
      row.booked = row.attendance_bookings.length > 0 || row.upcoming_bookings.length > 0;
      row.destinations = [];
      for (const message of row.messages.filter((m: any) => m.status === "sent" && m.sent_at)) {
        if (!message.twilio_message_sid) throw new Error("Sent message missing provider reference");
        const provider = await client.messages(message.twilio_message_sid).fetch();
        row.destinations.push({ message_id: message.id, twilio_message_sid: message.twilio_message_sid, to: provider.to });
      }
      row.proposed_after_sequence = row.booked ? row.sequence : {
        ...row.sequence, sequence_status: "active", exited_at: null, exit_reason: null, booked_event_id: null,
        step1_sent_at: null, step1_message_id: null, step1_delivery_kind: null, step2_sent_at: null, step2_message_id: null,
        updated_at: "<recovery transaction timestamp>",
      };
      row.proposed_after_candidates = row.booked ? row.candidates : [];
      console.log(JSON.stringify({ player: row.player.name, destinations: row.destinations }));
    }
    writeFileSync("/tmp/ltp-recovery-audit.json", JSON.stringify(stored, null, 2), { mode: 0o600 });
    return;
  }
  const audit = await read(supabase.from("playbook_outcomes_audit").select("sequence_id,outcome,is_test,step1_sent_at")
    .eq("club_id", club.id).eq("playbook_key", "ltp_followup"));
  const live = await read(supabase.from("playbook_outcomes").select("sequence_id").eq("club_id", club.id).eq("playbook_key", "ltp_followup"));
  console.log(JSON.stringify({ audit_counts: Object.fromEntries([...new Set(audit.map((r: any) => r.outcome))]
    .map(outcome => [outcome, audit.filter((r: any) => r.outcome === outcome).length])), live_count: live.length }));
  const players = await read(supabase.from("players").select("id,name,external_id,last_outbound_at")
    .eq("club_id", club.id).in("name", ["Ethan Forde", "Meaghan Wright", "Ke Shi", "Joe Stephenson"]));
  if (players.length !== 4) throw new Error("Expected exactly four players");
  const results = [];
  for (const player of players) {
    const sequence = await read(supabase.from("retention_sequences").select("*").eq("club_id", club.id)
      .eq("player_id", player.id).eq("playbook_key", "ltp_followup").single());
    const candidates = await read(supabase.from("retention_candidates").select("*").eq("club_id", club.id).eq("sequence_id", sequence.id));
    const trigger = await read(supabase.from("attendances").select("*").eq("club_id", club.id)
      .eq("player_id", player.id).eq("event_id", sequence.trigger_event_id));
    const ltpDate = trigger[0]?.attended_at ?? candidates.find((r: any) => r.step === 1)?.context?.trigger?.date;
    if (!ltpDate || !Number.isFinite(Date.parse(ltpDate))) throw new Error(`LTP date unavailable for ${player.name}`);
    const attendances = await read(supabase.from("attendances").select("*").eq("club_id", club.id)
      .eq("player_id", player.id).neq("event_id", sequence.trigger_event_id).gt("attended_at", ltpDate));
    const ids = [...new Set([...candidates.map((r: any) => r.message_id), sequence.step1_message_id, sequence.step2_message_id].filter(Boolean))];
    const messages = ids.length ? await read(supabase.from("messages").select("*").in("id", ids)) : [];
    const ledger = ids.length ? await read(supabase.from("contact_ledger").select("*").eq("club_id", club.id).in("message_id", ids)) : [];
    results.push({ player, ltp_date: ltpDate, sequence, candidates, messages, ledger, attendance_bookings: attendances });
  }
  // Save the stored evidence before live reads; no secrets are included.
  writeFileSync("/tmp/ltp-recovery-stored.json", JSON.stringify({ club_id: club.id, audit, live_count: live.length, players: results }, null, 2), { mode: 0o600 });
  console.log("Stored evidence captured; reading live upcoming signups");
  const snapshot = await buildLtpBookingSnapshot(club.id, createQueueBookingOptions());
  for (const row of results) {
    const upcoming = (snapshot.bookings.get(row.player.external_id) ?? []).filter(b => b.startTime > Date.parse(row.ltp_date));
    Object.assign(row, { upcoming_bookings: upcoming, booked: row.attendance_bookings.length > 0 || upcoming.length > 0 });
    console.log(JSON.stringify({ player: row.player.name, ltp_date: row.ltp_date,
      attendance_bookings: row.attendance_bookings.map((a: any) => ({ event_id: a.event_id, attended_at: a.attended_at, booked_at: a.booked_at, program_name: a.program_name })),
      upcoming_bookings: upcoming, ledger_rows: row.ledger.length, test_ledger_rows: row.ledger.filter((l: any) => l.is_test).length }));
  }
  writeFileSync("/tmp/ltp-recovery-audit.json", JSON.stringify({ captured_at: new Date().toISOString(),
    club_id: club.id, audit, live_count: live.length, upcoming_event_count: snapshot.eventCount, players: results }, null, 2), { mode: 0o600 });
  const jobs = await read(supabase.from("jobs").select("*").limit(100));
  writeFileSync("/tmp/ltp-recovery-jobs.json", JSON.stringify(jobs, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ completed: true, upcoming_events: snapshot.eventCount }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
