import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  fileURLToPath(new URL("../../../migrations/013_retention_ltp_sequence.sql", import.meta.url)),
  "utf8",
);

function canonicalSignature(value: string): string {
  return value.toLowerCase()
    .replace(/\btimestamptz\b/g, "timestamp with time zone")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function declaredSignature(functionName: string): string {
  const declaration = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${functionName}\\(([\\s\\S]*?)\\)\\s+RETURNS`,
    "i",
  ).exec(migration)?.[1];
  if (declaration === undefined) assert.fail(`${functionName} is declared`);
  return canonicalSignature(declaration.split(",")
    .map((parameter) => parameter.trim().replace(/^p_\w+\s+/i, "").replace(/\s+DEFAULT[\s\S]*$/i, ""))
    .join(","));
}

function assertSignatureReferences(functionName: string, minimumReferences = 3): void {
  const declared = declaredSignature(functionName);
  const references = [
    ...[...migration.matchAll(new RegExp(`to_regprocedure\\('public\\.${functionName}\\(([^)]*)\\)'\\)`, "gi"))]
      .map((match) => match[1]),
    ...[...migration.matchAll(new RegExp(
      `(?:REVOKE ALL ON FUNCTION|GRANT EXECUTE ON FUNCTION) public\\.${functionName}\\(([^)]*)\\)`,
      "gi",
    ))].map((match) => match[1]),
  ];
  assert.ok(references.length >= minimumReferences, `${functionName} has readiness, revoke, and grant signatures`);
  for (const reference of references) {
    assert.equal(canonicalSignature(reference), declared, `${functionName} reference matches its declaration`);
  }
}

function functionBody(functionName: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}(`);
  assert.notEqual(start, -1, `${functionName} body exists`);
  const end = migration.indexOf("$$;", start);
  assert.notEqual(end, -1, `${functionName} body is terminated`);
  return migration.slice(start, end + "$$;".length);
}

test("migration is manual, additive, and backfills LTP identity without rewriting candidate/message review data", () => {
  assert.match(migration, /Run this file MANUALLY in the existing Supabase project/);
  assert.match(migration, /Never run it against Replit DATABASE_URL/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS step smallint NOT NULL DEFAULT 1/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS sequence_id uuid/);
  assert.match(migration, /UNIQUE \(club_id,player_id,playbook_key\)/);
  assert.match(migration, /SELECT DISTINCT ON \(c\.club_id,c\.player_id,c\.playbook_key\)[\s\S]*FROM public\.retention_candidates c[\s\S]*WHERE c\.playbook_key='ltp_followup'/);
  assert.match(migration, /UPDATE public\.retention_candidates c\s+SET sequence_id=s\.id/);
  assert.match(migration, /ON CONFLICT\(club_id,player_id,playbook_key\) DO NOTHING/);
  assert.match(migration, /retention_candidates_player_playbook_step_unique/);
  assert.match(migration, /retention_candidates_sequence_step_unique/);
  const identityConstraint = migration.indexOf("retention_candidates_ltp_sequence_identity_check");
  assert.notEqual(identityConstraint, -1);
  assert.ok(identityConstraint > migration.lastIndexOf("UPDATE public.retention_candidates c", identityConstraint));
  assert.match(migration, /INSERT INTO public\.retention_capacity_reservations\([\s\S]*?c\.status IN \('drafted','manual_edit','approved','sent'\)/);
  assert.doesNotMatch(migration, /UPDATE public\.retention_candidates[\s\S]{0,180}SET body\s*=/i);
  const backfillStart = migration.indexOf("UPDATE public.messages m SET retention_delivery_kind");
  const backfillEnd = migration.indexOf("-- Templates are editable facts", backfillStart);
  const historicalBackfill = migration.slice(backfillStart, backfillEnd);
  assert.doesNotMatch(historicalBackfill, /UPDATE public\.messages[\s\S]{0,220}SET (?:approved_at|approved_by|approved_body|scheduled_send_at|status)\s*=/i);
  assert.match(migration, /m\.simulated IS TRUE THEN 'simulated'/);
  assert.match(migration, /l\.is_test IS TRUE\s*\)\s*THEN 'test'/);
  assert.match(migration, /m\.sent_at IS NOT NULL AND m\.simulated IS FALSE/);
  assert.match(migration, /m\.delivery_status='delivered' AND m\.delivered_at IS NOT NULL/);
  assert.match(migration, /l\.is_test IS FALSE[\s\S]*l\.player_id=m\.player_id OR l\.intended_player_id=m\.player_id/);
  assert.match(migration, /step1_delivery_kind='real'/);
});

test("LTP schema functions are service-role-only, readiness-gated, and have exact RPC type signatures", () => {
  for (const name of [
    "retention_sequence_save_batch",
    "retention_sequence_transition",
    "retention_sequence_session_changed",
    "retention_sequence_claim",
    "retention_sequence_record_send",
    "retention_sequence_due_step2",
    "retention_sequence_ready",
  ]) {
    assertSignatureReferences(name, name === "retention_sequence_ready" ? 2 : 3);
    const functionBlock = functionBody(name);
    assert.match(functionBlock, /SECURITY DEFINER SET search_path=public,pg_temp/);
    const revocation = new RegExp(
      `REVOKE ALL ON FUNCTION public\\.${name}\\([^;]*?FROM PUBLIC,anon,authenticated`,
      "is",
    );
    const grant = new RegExp(
      `GRANT EXECUTE ON FUNCTION public\\.${name}\\([^;]*?TO service_role`,
      "is",
    );
    assert.match(migration, revocation, `${name} revokes PUBLIC/anon/authenticated`);
    assert.match(migration, grant, `${name} grants the service role`);
  }
  assert.match(migration, /RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER[\s\S]*?CREATE OR REPLACE FUNCTION public\.retention_sequence_ready/);
  assert.match(migration, /to_regprocedure\('public\.retention_sequence_claim\(uuid,uuid,uuid,text,timestamptz,jsonb,timestamptz\)'\)/);
  assert.match(migration, /ALTER FUNCTION public\.retention_retry_context\([\s\S]*?RENAME TO retention_retry_context_legacy/);
  for (const legacyName of [
    "retention_create_candidate_legacy",
    "retention_create_draft_legacy",
    "retention_regenerate_draft_legacy",
    "retention_manual_edit_candidate_legacy",
    "retention_update_candidate_legacy",
    "retention_retry_context_legacy",
  ]) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${legacyName}[^;]*FROM PUBLIC,anon,authenticated,service_role`, "is"));
  }
  assert.match(migration, /ALTER TABLE public\.retention_sequences ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE public\.retention_capacity_reservations ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /p\.opted_out IS TRUE[\s\S]*?exited_opt_out/);
  assert.match(migration, /pl\.opted_out IS NOT TRUE/);
  for (const name of ["retention_sequence_save_batch", "retention_sequence_claim"]) {
    assert.match(functionBody(name), /v_player_opted_out IS TRUE/);
  }
  const optoutTrigger = functionBody("retention_sequence_player_optout_changed");
  assert.match(optoutTrigger, /SECURITY DEFINER SET search_path=public,pg_temp/);
  assert.match(optoutTrigger, /NEW\.opted_out IS TRUE/);
  assert.match(optoutTrigger, /retention_sequence_transition\([\s\S]*?'exited_opt_out'/);
  assert.match(migration, /CREATE TRIGGER players_ltp_retention_optout[\s\S]*?EXECUTE FUNCTION public\.retention_sequence_player_optout_changed/);
});

test("batch saves compare-and-swap reviewed state under ordered sequence, candidate, message, and event locks", () => {
  const batch = functionBody("retention_sequence_save_batch");
  assert.match(batch, /FOR UPDATE/);
  assert.match(batch, /ORDER BY s\.id/);
  assert.match(batch, /ORDER BY c\.id FOR UPDATE OF c/);
  assert.match(batch, /ORDER BY m\.id FOR UPDATE OF m/);
  assert.match(batch, /SELECT DISTINCT x->>'capacity_event_id'[\s\S]*ORDER BY x->>'capacity_event_id'/);
  assert.match(batch, /v_candidate\.context IS DISTINCT FROM v_item->'expected_context'/);
  assert.match(batch, /v_candidate\.updated_at IS DISTINCT FROM \(v_item->>'expected_updated_at'\)::timestamptz/);
  assert.match(batch, /v_candidate\.message_id IS DISTINCT FROM NULLIF\(v_item->>'expected_message_id',''\)::uuid/);
  assert.match(batch, /v_message\.body IS DISTINCT FROM \(v_item->>'expected_body'\)/);
  assert.match(batch, /v_message\.approved_at IS NOT NULL/);
  assert.match(batch, /v_message\.approved_by IS NOT NULL/);
  assert.match(batch, /v_message\.approved_body IS NOT NULL/);
  assert.match(batch, /v_message\.scheduled_send_at IS NOT NULL/);
  assert.match(batch, /v_message\.sent_at IS NOT NULL/);
  assert.match(batch, /v_message\.dispatch_claimed_at IS NOT NULL/);
  assert.match(batch, /DELETE FROM public\.retention_capacity_reservations cr[\s\S]*candidate_id IN\(SELECT \(x->>'id'\)::uuid/);
  assert.match(batch, /SELECT count\(\*\) INTO v_outside FROM public\.retention_capacity_reservations cr[\s\S]*cr\.event_id=v_event_id/);
  assert.match(batch, /IF v_outside>=v_open THEN\s+RAISE EXCEPTION 'capacity_exhausted/);
  assert.match(batch, /RAISE EXCEPTION 'capacity_exhausted:[\s\S]*cohort reservations exceed current capacity/);
  assert.match(batch, /RETURN v_saved/);
  assert.match(migration, /\nBEGIN;/);
  assert.match(migration, /^COMMIT;/m);
});

test("dispatch and step 2 require real recipient delivery, provider evidence, no test/simulation, and no later attendance", () => {
  const claim = functionBody("retention_sequence_claim");
  assert.match(claim, /c\.context IS DISTINCT FROM p_expected_context/);
  assert.match(claim, /c\.updated_at IS DISTINCT FROM p_expected_updated_at/);
  assert.match(claim, /m\.dispatch_claimed_at IS NOT NULL/);
  assert.match(claim, /c\.step=2 AND \([\s\S]*s\.step1_delivery_kind IS DISTINCT FROM 'real'/);
  assert.match(claim, /retention_ltp_has_attendance_since\(c\.player_id,s\.step1_sent_at\)/);

  const record = functionBody("retention_sequence_record_send");
  assert.match(record, /m\.status IS DISTINCT FROM 'sent'/);
  assert.match(record, /m\.simulated IS DISTINCT FROM TRUE/);
  assert.match(record, /is_test IS TRUE/);
  assert.match(record, /is_test IS FALSE/);
  assert.match(record, /m\.delivery_status IS DISTINCT FROM 'delivered'/);
  assert.match(record, /step1_delivery_kind=p_delivery_kind/);
  assert.match(record, /p_delivery_kind='real' AND sequence_status='active'[\s\S]*THEN 'completed'/);

  const due = functionBody("retention_sequence_due_step2");
  assert.match(due, /s\.sequence_status='active'/);
  assert.match(due, /s\.step1_delivery_kind='real'/);
  assert.match(due, /m\.retention_delivery_kind='real'/);
  assert.match(due, /now\(\)-s\.step1_sent_at>=make_interval/);
  assert.match(due, /NOT public\.retention_ltp_has_attendance_since/);
  assert.match(due, /NOT EXISTS\(SELECT 1 FROM public\.retention_candidates c2 WHERE c2\.sequence_id=s\.id AND c2\.step=2\)/);
  assert.match(functionBody("retention_sequence_transition"), /Only a real step-2 delivery can complete a sequence/);
});
