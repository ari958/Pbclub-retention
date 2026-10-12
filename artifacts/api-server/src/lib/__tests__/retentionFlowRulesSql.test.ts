import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { optOutWebhookPostgres } from "./fixtures/optOutWebhookPostgres";

const load = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8");
const migration031 = load("031_retention_flow_rules.sql");

/** One top-level statement of 031, by the amended function's name. */
function amendment(functionName: string): string {
  const start = migration031.indexOf(`SELECT pg_temp.retention_flow_amend('${functionName}',`);
  assert.notEqual(start, -1, `031 amends ${functionName}`);
  const end = migration031.indexOf("\n]);", start);
  assert.notEqual(end, -1);
  return migration031.slice(start, end + "\n]);".length);
}

function definition(functionName: string): string {
  const match = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION (?:public|pg_temp)\\.${functionName}\\([\\s\\S]*?\\$\\$;`).exec(migration031);
  assert.ok(match, `031 defines ${functionName}`);
  return match[0];
}

test("migration 031 keeps the LTP writer byte-for-byte in behavior and lets a second sequence flow use the same RPCs", () => {
  const root = mkdtempSync(join(tmpdir(), "retention-flow-rules-sql-"));
  const data = join(root, "data");
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${command}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  let started = false;
  try {
    run("initdb", ["-D", data, "-U", "fixture_owner", "-A", "trust", "-E", "UTF8", "--no-locale"]);
    run("pg_ctl", ["-D", data, "-l", join(root, "server.log"),
      "-o", `-k ${root} -p 55443 -c listen_addresses=''`, "-w", "start"]);
    started = true;
    const psql = (path: string) => run("psql", ["-h", root, "-p", "55443", "-U", "fixture_owner", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-f", path]);
    const sqlFile = (name: string, source: string) => {
      const path = join(root, name);
      writeFileSync(path, source);
      return psql(path);
    };
    psql(new URL("./sql/ltpTestTools.fixture.sql", import.meta.url).pathname);

    // Real 013 functions, plus the 015-style test clone of the writer and the
    // 028 inbound capture, so 031 has every function it insists on amending.
    const sequence = load("013_retention_ltp_sequence.sql");
    const functions = new Map([...sequence.matchAll(
      /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\$\$;/g,
    )].map((match) => [match[1], match[0]]));
    const writer = functions.get("retention_sequence_save_batch")!;
    assert.ok(writer);
    const inbound = /CREATE OR REPLACE FUNCTION public\.capture_sms_inbound\([\s\S]*?\nEND \$\$;/.exec(load("028_inbound_conversation_order.sql"))?.[0];
    assert.ok(inbound, "028 defines the six-argument inbound capture");
    sqlFile("scaffold.sql", `
      CREATE TABLE public.sms_inbound_receipts(id uuid,club_id uuid,player_id uuid,twilio_message_sid text,
        from_phone text,to_phone text,body text,kind text,match_reason text,twilio_optout_type text,
        processed_at timestamptz,processing_error text,received_at timestamptz,message_id uuid);
      ALTER TABLE public.retention_candidates ALTER COLUMN step SET DEFAULT 1; -- as in production (013)
      ALTER TABLE public.retention_candidates ADD CONSTRAINT retention_candidates_status_check
        CHECK (status IN ('drafted','approved','skipped','sent','needs_context','manual_edit'));
      ALTER TABLE public.retention_candidates ADD CONSTRAINT retention_candidates_ltp_sequence_identity_check CHECK (
        (playbook_key='ltp_followup' AND sequence_id IS NOT NULL)
        OR (playbook_key<>'ltp_followup' AND step=1 AND sequence_id IS NULL AND sequence_status='active'
            AND exited_at IS NULL AND exit_reason IS NULL AND booked_event_id IS NULL));
      ALTER TABLE public.retention_playbooks ADD CONSTRAINT retention_playbooks_ltp_sequence_gap_check
        CHECK (key<>'ltp_followup' OR jsonb_typeof(ltp_sequence_config->'step2_gap_days')='number');
      ALTER TABLE public.retention_sequences ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.retention_capacity_event_locks ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.retention_capacity_reservations ENABLE ROW LEVEL SECURITY;
      CREATE UNIQUE INDEX retention_candidates_player_playbook_step_unique
        ON public.retention_candidates(player_id,playbook_key,step);
      CREATE UNIQUE INDEX retention_candidates_sequence_step_unique
        ON public.retention_candidates(sequence_id,step) WHERE sequence_id IS NOT NULL;
      ${[...functions.values()].join("\n")}
      ${writer.replace("public.retention_sequence_save_batch(", "public.retention_sequence_save_batch_test(")}
      ${inbound}
      CREATE TRIGGER players_ltp_retention_optout AFTER UPDATE OF opted_out ON public.players
        FOR EACH ROW WHEN (NEW.opted_out IS TRUE AND OLD.opted_out IS DISTINCT FROM TRUE)
        EXECUTE FUNCTION public.retention_sequence_player_optout_changed();
    `);
    psql(new URL("../../../migrations/018_prelaunch_reset_replacements.sql", import.meta.url).pathname);

    // The LTP playbook row must exist before 031 so the migration seeds its
    // rules; the reset assertion script normally inserts it itself.
    const resetAssertions = readFileSync(new URL("./sql/prelaunchReset.assert.sql", import.meta.url), "utf8");
    const playbookInsert = /INSERT INTO public\.retention_playbooks VALUES \('ltp_followup'[\s\S]*?\}\}'\);\n/.exec(resetAssertions)?.[0];
    assert.ok(playbookInsert, "reset assertions seed the LTP playbook");
    sqlFile("playbook.sql", playbookInsert);

    // The production dry run executes all of 031, reports, and saves nothing.
    const dryRunPath = new URL("../../../verification/031_dry_run.sql", import.meta.url).pathname;
    const dryRunSource = readFileSync(dryRunPath, "utf8");
    const migrationBody = migration031.slice(migration031.indexOf("BEGIN;\n"), migration031.indexOf("\nCOMMIT;\n") + 1);
    assert.ok(dryRunSource.includes(migrationBody), "verification/031_dry_run.sql must embed migration 031 verbatim; regenerate it");
    assert.doesNotMatch(dryRunSource, /\bCOMMIT\b/, "the dry run must never commit");
    const dryRun = spawnSync("psql", ["-h", root, "-p", "55443", "-U", "fixture_owner", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-f", dryRunPath], { encoding: "utf8", timeout: 30_000 });
    assert.notEqual(dryRun.status, 0, "the dry run ends in its deliberate error");
    assert.match(dryRun.stderr, /DRY RUN PASSED\. Nothing was saved/);
    assert.match(dryRun.stderr, /ltp_followup = sequence \/ Learn to Play \/ LTPNEXT25 \/ 25% off \/ https:\/\/pbclub\.podplay\.app/);
    const query = (sql: string) => run("psql", ["-h", root, "-p", "55443", "-U", "fixture_owner", "-d", "postgres",
      "-At", "-v", "ON_ERROR_STOP=1", "-c", sql]).stdout.trim();
    assert.equal(query("SELECT count(*) FROM information_schema.columns WHERE table_name='retention_playbooks' AND column_name='flow_kind'"), "0",
      "the dry run left no new column behind");
    assert.equal(query("SELECT strpos(pg_get_functiondef('public.retention_sequence_save_batch(uuid,jsonb)'::regprocedure), '''ltp_followup''')>0"), "t",
      "the dry run left every function body unamended");

    // The read-only source check reports every 031 substitution; on the
    // installed 013/018/028 functions each one must match.
    const sourceCheckPath = new URL("../../../verification/031_source_check.sql", import.meta.url).pathname;
    const sourceCheck = readFileSync(sourceCheckPath, "utf8");
    const substitutions = migration031.slice(
      migration031.indexOf("END $$;\n", migration031.indexOf("CREATE FUNCTION pg_temp.retention_flow_amend(")) + "END $$;\n".length,
      migration031.indexOf("DROP FUNCTION pg_temp.retention_flow_amend("),
    ).replaceAll("pg_temp.retention_flow_amend(", "pg_temp.retention_flow_check(");
    assert.ok(sourceCheck.includes(substitutions), "verification/031_source_check.sql must copy 031's substitution list verbatim; regenerate it");
    assert.doesNotMatch(sourceCheck, /\bCOMMIT\b|\bALTER TABLE\b|\bINSERT INTO public\.|\bUPDATE public\./, "the source check must stay read-only");
    const checkRows = (expected: RegExp) => {
      const out = run("psql", ["-h", root, "-p", "55443", "-U", "fixture_owner", "-d", "postgres",
        "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-f", sourceCheckPath]).stdout.trim().split("\n")
        .filter((line) => line.includes("|"));
      assert.ok(out.length >= 19, `source check reports every substitution (${out.length} rows)`);
      for (const line of out) assert.match(line.split("|")[2], expected, line);
    };
    checkRows(/^ok: (will amend|optional function absent)$/);

    const change = new URL("../../../migrations/031_retention_flow_rules.sql", import.meta.url).pathname;
    const first = psql(change);
    assert.match(first.stdout, /\bt\b/, "readiness verification prints true");
    const definitions = () => query(`SELECT string_agg(pg_get_functiondef(p.oid), E'\n----\n' ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`);
    const afterFirstInstall = definitions();
    psql(change); // Reinstallation is idempotent, including every function amendment.
    assert.equal(definitions(), afterFirstInstall, "a second install leaves every function byte-for-byte unchanged");
    checkRows(/^ok: (already amended|optional function absent)$/);

    const reset = sqlFile("reset.assert.sql", resetAssertions.replace(playbookInsert, ""));
    assert.match(reset.stderr, /all original candidate fields unchanged/);
    assert.match(reset.stderr, /second generation cannot duplicate replacement/);
    assert.match(reset.stderr, /later sequence transition preserves archived candidate fields/);

    const outcome = psql(new URL("./sql/retentionFlowRules.assert.sql", import.meta.url).pathname);
    for (const label of [
      "sequence schema is ready after 031",
      "ltp_followup carries the rules the functions used to hard-code",
      "no literal LTP rule left in retention_sequence_save_batch",
      "no literal LTP rule left in retention_sequence_save_batch_test",
      "no literal LTP rule left in capture_sms_inbound",
      "018 amendment survives 031",
      "legacy writer refuses a sequence playbook by kind",
      "identity trigger blocks sequence state on a single-draft playbook",
      "second flow step 1 drafted",
      "second flow rejects the LTP coupon by its own rule",
      "mixed-playbook batch refused",
      "opt-out trigger exits the second flow",
    ]) {
      assert.match(outcome.stderr, new RegExp(`PASS: ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), label);
    }
  } finally {
    if (started) spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inbound STOP exits every sequence flow the player is in, not only Learn to Play", () => {
  const db = optOutWebhookPostgres();
  try {
    db.sql(`
      CREATE TABLE public.retention_playbooks(key text PRIMARY KEY,flow_kind text NOT NULL DEFAULT 'single');
      INSERT INTO public.retention_playbooks VALUES ('ltp_followup','sequence'),('winback_followup','sequence'),('legacy_single','single');
      ${definition("retention_playbook_is_sequence")}
      ${definition("retention_flow_amend")}
      ${amendment("retention_sequence_transition")}
      ${amendment("capture_sms_inbound")}
      INSERT INTO players(id,club_id,name,phone) VALUES
        ('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-000000000001','Pat','+15550000202');
      INSERT INTO retention_sequences(id,club_id,player_id,playbook_key,sequence_status) VALUES
        ('00000000-0000-4000-8000-000000000211','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000202','ltp_followup','active'),
        ('00000000-0000-4000-8000-000000000212','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000202','winback_followup','active'),
        ('00000000-0000-4000-8000-000000000213','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000202','legacy_single','active');
    `);
    const result = db.sql(`SELECT public.capture_sms_inbound('pb-club','+15550000202','+12015281834',
      'SM00000000000000000000000000000202','STOP',NULL)`);
    assert.match(result, /"kind": ?"stop"/);
    assert.equal(db.sql("SELECT coalesce(processing_error,'none') FROM sms_inbound_receipts"), "none", "sequence processing succeeded");
    const statuses = db.sql(`SELECT playbook_key||'='||sequence_status FROM retention_sequences
      WHERE player_id='00000000-0000-4000-8000-000000000202' ORDER BY playbook_key`);
    assert.deepEqual(statuses.split("\n"), [
      "legacy_single=active",
      "ltp_followup=exited_opt_out",
      "winback_followup=exited_opt_out",
    ]);
  } finally {
    db.close();
  }
});
