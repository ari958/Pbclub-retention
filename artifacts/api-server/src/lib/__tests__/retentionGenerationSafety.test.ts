import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migration = readFileSync(
  fileURLToPath(new URL("../../../migrations/011_retention_context_regeneration.sql", import.meta.url)),
  "utf8",
);
const engine = readFileSync(new URL("../retentionEngine.ts", import.meta.url), "utf8");
const text = readFileSync(new URL("../retentionText.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../../routes/retention.ts", import.meta.url), "utf8");

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
  assert.ok(declaration, `${functionName} declaration exists`);
  return declaration.split(",")
    .map((parameter) => parameter.trim().replace(/^p_\w+\s+/i, "").replace(/\s+DEFAULT[\s\S]*$/i, ""))
    .join(",");
}

function assertAllSignatureReferencesMatch(functionName: string) {
  const declared = canonicalSignature(declaredSignature(functionName));
  const patterns = [
    new RegExp(`to_regprocedure\\('public\\.${functionName}\\(([^)]*)\\)'\\)`, "gi"),
    new RegExp(`(?:REVOKE ALL ON FUNCTION|GRANT EXECUTE ON FUNCTION) public\\.${functionName}\\(([^)]*)\\)`, "gi"),
  ];
  const references = patterns.flatMap((pattern) => [...migration.matchAll(pattern)].map((match) => match[1]));
  assert.ok(references.length >= 3, `${functionName} has readiness/revoke/grant signatures`);
  for (const reference of references) {
    assert.equal(canonicalSignature(reference), declared, `${functionName} reference matches its declaration`);
  }
}

test("additive migration persists blocked states without constructing pending fake text", () => {
  assert.match(migration, /ADD CONSTRAINT retention_candidates_status_check[\s\S]*needs_context[\s\S]*manual_edit/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.retention_create_candidate/);
  assert.match(migration, /IF p_status='drafted' THEN[\s\S]*INSERT INTO messages/);
  assert.match(migration, /p_status<>'drafted' AND length\(btrim\(COALESCE\(p_body,''\)\)\)>0/);
  assert.match(migration, /Blocked candidates cannot have pending message text/);
  assert.match(migration, /p_status<>'drafted' AND length\(btrim\(COALESCE\(p_context->>'reason',''\)\)\)=0/);
});

test("regeneration is atomic, compare-and-swap guarded, and preserves candidate/message identity", () => {
  const functionSql = migration.split("CREATE OR REPLACE FUNCTION public.retention_regenerate_draft")[1]
    .split("CREATE OR REPLACE FUNCTION public.retention_manual_edit_candidate")[0];
  assert.match(functionSql, /FOR UPDATE/);
  assert.match(functionSql, /c\.context IS DISTINCT FROM p_expected_context/);
  assert.match(functionSql, /c\.updated_at IS DISTINCT FROM p_expected_updated_at/);
  assert.match(functionSql, /m\.body IS DISTINCT FROM p_expected_body/);
  assert.match(functionSql, /m\.approved_at IS NOT NULL/);
  assert.match(functionSql, /m\.dispatch_claimed_at IS NOT NULL/);
  assert.match(functionSql, /m\.scheduled_send_at IS NOT NULL/);
  assert.match(functionSql, /c\.status<>'drafted'/);
  assert.doesNotMatch(functionSql, /SET[^;]*message_id\s*=/i);
  assert.match(functionSql, /UPDATE messages SET body=CASE WHEN p_new_status='drafted' THEN btrim\(p_new_body\) ELSE '' END/);
  assert.match(functionSql, /UPDATE retention_candidates SET context=p_new_context,status=p_new_status,updated_at=now\(\)/);
});

test("manual edit is a separate validated path and only accepts blocked candidate statuses", () => {
  assert.match(migration, /c\.status NOT IN \('needs_context','manual_edit'\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.retention_manual_edit_candidate/);
  assert.match(routes, /validateRetentionTextBody\(parsed\.data\.body, candidate\.context, playbook as RetentionPlaybook\)/);
  assert.match(routes, /retention_manual_edit_candidate/);
  assert.match(routes, /candidate\.status === "needs_context" \|\| candidate\.status === "manual_edit"/);
  assert.match(engine, /generated_preview: generatedPreview/);
  assert.match(migration, /IF p_status<>'drafted' AND length\(btrim\(COALESCE\(p_body,''\)\)\)>0/);
});

test("schema readiness fails closed on absent new RPCs/status constraint and route checks readiness", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.retention_schema_ready\(\)/);
  assert.match(migration, /retention_candidates_status_check/);
  assert.match(routes, /supabase\.rpc\("retention_schema_ready"\)/);
  assert.match(routes, /router\.post\("\/retention\/candidates\/:id\/approve"[\s\S]*?requireRetentionSchemaReady\(\)/);
  assert.match(routes, /router\.post\("\/retention\/playbooks\/:key\/approve"[\s\S]*?requireRetentionSchemaReady\(\)/);
});

test("single and bulk approvals require the stored generated ET date to match their schedule", () => {
  // Single approval lives in the shared approveCandidate (used by the routes and the auto-approver).
  const approval = readFileSync(new URL("../retentionCandidateApproval.ts", import.meta.url), "utf8");
  assert.match(approval, /retentionSendDateMatchesSchedule\(context\.send_date_et, schedule\)/);
  assert.match(approval, /The intended ET send date changed\. Regenerate and review this candidate before approving\./);
  assert.match(routes, /retentionSendDateMatchesSchedule\(row\.context\?\.send_date_et, bulkSchedule\)/);
  assert.match(routes, /The intended ET send date changed\. Regenerate and review candidates before approving\./);
});

test("readiness, revoke, and grant signatures exactly match each new RPC declaration", () => {
  for (const name of [
    "retention_create_candidate",
    "retention_regenerate_draft",
    "retention_manual_edit_candidate",
  ]) {
    assertAllSignatureReferencesMatch(name);
  }
});

test("engine carries context diagnostics, reason/errors, supported lookback, and staleness into stored candidates", () => {
  assert.match(engine, /candidate\.reason === "no_next_program" \|\| candidate\.reason === "context_lookup_failed"/);
  assert.match(engine, /reason: failure\.reason/);
  assert.match(engine, /errors: failure\.errors/);
  assert.match(engine, /diagnostics: failure\.diagnostics/);
  assert.match(engine, /stale: lookbackDays > DEFAULT_RETENTION_LOOKBACK_DAYS/);
  assert.match(engine, /lookback_days: lookbackDays/);
  assert.match(engine, /retentionDatePhrase\(trigger\.date, intendedSendAt\)/);
  assert.match(engine, /send_date_et: toEtDate\(intendedSendAt\)/);
  assert.match(engine, /retention_create_candidate/);
  assert.match(engine, /function hasLaterNonLtpAttendance[\s\S]*hasNonLtpAttendanceAfterTrigger/);
  assert.match(engine, /alreadyReturned: hasLaterNonLtpAttendance\(flow, byPlayer\.get\(candidate\.playerId\) \?\? \[\], verified\.date\)/);
  assert.match(engine, /already_returned/);
});

test("invalid generated text is retried twice and preview is kept outside pending message text", () => {
  assert.match(text, /attempt < 3/);
  assert.match(text, /generated_preview: generatedPreview/);
  assert.match(engine, /generated_preview: generatedPreview/);
  assert.match(engine, /body: status === "manual_edit" \? generatedPreview : body/);
  assert.match(migration, /Blocked candidates cannot have pending message text/);
});

test("default generation lookback is production three days and test windows are constrained", () => {
  assert.match(engine, /normalizeRetentionLookbackDays\(requestedLookbackDays\)/);
  assert.match(engine, /stats\.needs_context\+\+/);
  assert.match(engine, /stats\.manual_edit\+\+/);
  assert.match(routes, /needs_context: generated\.stats\.needs_context/);
  assert.match(routes, /manual_edit: generated\.stats\.manual_edit/);
  const dates = readFileSync(new URL("../retentionDates.ts", import.meta.url), "utf8");
  assert.match(dates, /DEFAULT_RETENTION_LOOKBACK_DAYS = 3/);
  assert.match(dates, /ALLOWED_RETENTION_LOOKBACK_DAYS = \[3, 7, 14, 30\]/);
});