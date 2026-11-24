import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const migration = readFileSync(new URL("../../../migrations/032_winback_flow.sql", import.meta.url), "utf8");
const dryRun = readFileSync(new URL("../../../verification/032_dry_run.sql", import.meta.url), "utf8");

// The production tables 032 touches, reduced to the columns and rules that matter:
// the partial unique index and the deferred superseded link come from 018.
const SCAFFOLD = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE TABLE public.players(id uuid PRIMARY KEY, club_id uuid NOT NULL);
CREATE TABLE public.retention_playbooks(
  key text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  promo_code text, offer_text text, next_program_names text[] NOT NULL DEFAULT '{}',
  message_guidance text NOT NULL DEFAULT '', holdout_pct numeric NOT NULL DEFAULT 0 CHECK (holdout_pct BETWEEN 0 AND 100),
  ltp_sequence_config jsonb, flow_kind text NOT NULL DEFAULT 'single' CHECK (flow_kind IN ('single','sequence')),
  trigger_program_label text, verified_promo_code text, verified_offer_phrase text, booking_url text);
CREATE TABLE public.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid NOT NULL,
  body text, direction text, sent_by text, status text, sent_at timestamptz DEFAULT now(), approved_at timestamptz);
CREATE TABLE public.retention_candidates(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), club_id uuid NOT NULL, player_id uuid NOT NULL,
  playbook_key text NOT NULL REFERENCES public.retention_playbooks(key), trigger_event_id text NOT NULL,
  context jsonb NOT NULL, status text NOT NULL DEFAULT 'drafted'
    CHECK (status IN ('drafted','approved','skipped','sent','needs_context','manual_edit')),
  message_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  step smallint NOT NULL DEFAULT 1, sequence_id uuid, sequence_status text NOT NULL DEFAULT 'active',
  prelaunch_superseded_by uuid);
ALTER TABLE public.retention_candidates ADD CONSTRAINT retention_prelaunch_superseded_fk
  FOREIGN KEY(prelaunch_superseded_by) REFERENCES public.retention_candidates(id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX retention_candidates_player_playbook_step_unique
  ON public.retention_candidates(player_id,playbook_key,step) WHERE prelaunch_superseded_by IS NULL;
INSERT INTO public.retention_playbooks(key,name,flow_kind,trigger_program_label,verified_promo_code,verified_offer_phrase,booking_url)
  VALUES('ltp_followup','Learn to Play follow-up','sequence','Learn to Play','LTPNEXT25','25% off','https://pbclub.podplay.app');
INSERT INTO public.players VALUES
  ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1'),
  ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000c1');
CREATE FUNCTION pg_temp.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT FAILED: %', msg; END IF; END $f$;
`;

const ASSERTIONS = `
\\set club '00000000-0000-4000-8000-0000000000c1'
\\set p1 '00000000-0000-4000-8000-000000000001'
\\set p2 '00000000-0000-4000-8000-000000000002'
CREATE FUNCTION pg_temp.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT FAILED: %', msg; END IF; END $f$;
SELECT pg_temp.ok(public.retention_winback_ready(), 'ready after install');
SELECT pg_temp.ok((SELECT flow_kind='single' AND holdout_pct=20 AND promo_code IS NULL AND enabled
  FROM public.retention_playbooks WHERE key='winback_regular'), 'playbook row');
SELECT pg_temp.ok((SELECT flow_kind FROM public.retention_playbooks WHERE key='ltp_followup')='sequence', 'LTP untouched');

-- First cycle: a draft with its pending message.
CREATE TEMP TABLE r AS SELECT public.retention_winback_create_candidate(:'club',:'p1','lapse:2026-11-01',
  '{"player_first_name":"Sam"}','drafted','Hi Sam, it''s PB Club. Here: https://pbclub.podplay.app') AS id;
SELECT pg_temp.ok((SELECT id IS NOT NULL FROM r), 'first draft created');
SELECT pg_temp.ok((SELECT m.status='pending' AND m.sent_at IS NULL AND m.approved_at IS NULL
  FROM public.retention_candidates c JOIN public.messages m ON m.id=c.message_id WHERE c.id=(SELECT id FROM r)), 'pending unsent message');

-- Within 90 days: refused (NULL), nothing added.
SELECT pg_temp.ok(public.retention_winback_create_candidate(:'club',:'p1','lapse:2026-11-20',
  '{"reason":"holdout"}','skipped') IS NULL, 'second cycle inside 90 days refused');
SELECT pg_temp.ok((SELECT count(*) FROM public.retention_candidates WHERE player_id=:'p1')=1, 'still one row');

-- 91 days later: new cycle; the old row is kept and linked to the new one.
UPDATE public.retention_candidates SET created_at=now()-interval '91 days', status='sent' WHERE id=(SELECT id FROM r);
CREATE TEMP TABLE r2 AS SELECT public.retention_winback_create_candidate(:'club',:'p1','lapse:2027-02-01',
  '{"reason":"holdout"}','skipped') AS id;
SELECT pg_temp.ok((SELECT id IS NOT NULL FROM r2), 'second cycle after 90 days');
SELECT pg_temp.ok((SELECT prelaunch_superseded_by=(SELECT id FROM r2) FROM public.retention_candidates WHERE id=(SELECT id FROM r)),
  'old row linked to new cycle');
SELECT pg_temp.ok((SELECT count(*) FROM public.retention_candidates WHERE player_id=:'p1' AND prelaunch_superseded_by IS NULL)=1,
  'one live row per player');
SELECT pg_temp.ok((SELECT message_id IS NULL AND status='skipped' FROM public.retention_candidates WHERE id=(SELECT id FROM r2)),
  'holdout row has no message');

-- An approved-but-unsent row is never superseded, however old.
UPDATE public.retention_candidates SET created_at=now()-interval '200 days', status='approved' WHERE id=(SELECT id FROM r2);
SELECT pg_temp.ok(public.retention_winback_create_candidate(:'club',:'p1','lapse:2027-06-01',
  '{"reason":"holdout"}','skipped') IS NULL, 'approved row blocks a new cycle');

-- Input guards.
DO $$ BEGIN
  BEGIN PERFORM public.retention_winback_create_candidate('00000000-0000-4000-8000-0000000000c9',
    '00000000-0000-4000-8000-000000000002','k','{}','skipped',NULL);
    RAISE EXCEPTION 'expected club guard';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Player does not belong%' THEN RAISE; END IF; END;
  BEGIN PERFORM public.retention_winback_create_candidate('00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-000000000002','k','{}','drafted','');
    RAISE EXCEPTION 'expected body guard';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Draft body is required%' THEN RAISE; END IF; END;
  BEGIN PERFORM public.retention_winback_create_candidate('00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-000000000002','k','{}','approved',NULL);
    RAISE EXCEPTION 'expected status guard';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Unsupported win-back%' THEN RAISE; END IF; END;
END $$;

-- Only the service role may call the writer.
SELECT pg_temp.ok(NOT has_function_privilege('anon','public.retention_winback_create_candidate(uuid,uuid,text,jsonb,text,text,integer)','EXECUTE'), 'anon cannot write');
SELECT pg_temp.ok(has_function_privilege('service_role','public.retention_winback_create_candidate(uuid,uuid,text,jsonb,text,text,integer)','EXECUTE'), 'service role can write');
`;

test("migration 032: win-back writer, 90-day cycles, dry run saves nothing", (t) => {
  if (spawnSync("initdb", ["--version"]).status !== 0) {
    t.skip("initdb is not on PATH");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "wb-"));
  const data = join(root, "data");
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${command}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  let started = false;
  try {
    run("initdb", ["-D", data, "-U", "fixture_owner", "-A", "trust", "-E", "UTF8", "--no-locale"]);
    run("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-o", `-k ${root} -p 55447 -c listen_addresses=''`, "-w", "start"]);
    started = true;
    const psql = (db: string, path: string, allowFail = false) => {
      const result = spawnSync("psql", ["-h", root, "-p", "55447", "-U", "fixture_owner", "-d", db, "-v", "ON_ERROR_STOP=1", "-f", path],
        { encoding: "utf8", timeout: 30_000 });
      if (!allowFail) assert.equal(result.status, 0, `${path}\n${result.stdout}\n${result.stderr}`);
      return result;
    };
    const file = (name: string, source: string) => { const path = join(root, name); writeFileSync(path, source); return path; };
    // Files reach the Supabase editor through a browser clipboard (LF -> CR+LF).
    const pasted = (name: string, source: string) => file(name, source.replaceAll("\n", "\r\n"));

    // Dry run on a fresh database: passes, and leaves nothing behind.
    run("createdb", ["-h", root, "-p", "55447", "-U", "fixture_owner", "dry"]);
    psql("dry", file("scaffold.sql", SCAFFOLD));
    const body = migration.slice(migration.indexOf("BEGIN;\n"), migration.indexOf("\nCOMMIT;\n") + 1);
    assert.ok(dryRun.includes(body), "verification/032_dry_run.sql must embed migration 032 verbatim; regenerate it");
    assert.doesNotMatch(dryRun, /\bCOMMIT\b/, "the dry run must never commit");
    const dry = psql("dry", pasted("dry.sql", dryRun), true);
    assert.match(dry.stderr, /DRY RUN PASSED\. Nothing was saved/, dry.stderr);
    const check = spawnSync("psql", ["-h", root, "-p", "55447", "-U", "fixture_owner", "-d", "dry", "-tAc",
      "SELECT count(*) FROM public.retention_playbooks WHERE key='winback_regular'"], { encoding: "utf8" });
    assert.equal(check.stdout.trim(), "0", "dry run saved nothing");

    // Real install (twice: re-runs are safe), then behavior.
    run("createdb", ["-h", root, "-p", "55447", "-U", "fixture_owner", "real"]);
    psql("real", file("scaffold2.sql", SCAFFOLD));
    psql("real", pasted("032.sql", migration));
    psql("real", pasted("032-again.sql", migration));
    psql("real", file("assert.sql", ASSERTIONS));
  } finally {
    if (started) spawnSync("pg_ctl", ["-D", data, "-m", "fast", "stop"]);
    rmSync(root, { recursive: true, force: true });
  }
});
