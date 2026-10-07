import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("template club migration preserves legacy fields, other-club ownership, and safely reruns", () => {
  const root = mkdtempSync(join(tmpdir(), "template-club-sql-"));
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
      "-o", `-k ${root} -p 55441 -c listen_addresses=''`, "-w", "start"]);
    started = true;
    const sql = (path: string) => run("psql", ["-h", root, "-p", "55441", "-U", "fixture_owner", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-f", path]);
    let counter = 0;
    const command = (source: string) => {
      const path = join(root, `fixture-${counter++}.sql`);
      writeFileSync(path, source);
      return sql(path);
    };
    command(`
      CREATE TABLE public.clubs(id uuid PRIMARY KEY,slug text UNIQUE);
      INSERT INTO public.clubs VALUES
        ('00000000-0000-4000-8000-000000000001','pb-club'),
        ('00000000-0000-4000-8000-000000000002','test-club');
      CREATE TABLE public.message_templates(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,body text,use_case_tags text[],
        is_builtin boolean,created_at timestamptz,updated_at timestamptz
      );
      INSERT INTO public.message_templates(name,body,use_case_tags,is_builtin,created_at,updated_at)
        SELECT 'Original '||n,'Original body '||n,ARRAY['ltp'],true,'2025-01-01','2025-02-01'
        FROM generate_series(1,4) n;
      CREATE TABLE public.original_templates AS SELECT * FROM public.message_templates;
    `);
    const migration = new URL("../../../migrations/019_message_template_club_ownership.sql", import.meta.url).pathname;
    sql(migration);
    command(`
      DO $$ BEGIN
        IF (SELECT count(*) FROM message_templates
          WHERE club_id='00000000-0000-4000-8000-000000000001')<>4 THEN RAISE EXCEPTION 'Wrong club or count'; END IF;
        IF EXISTS(SELECT 1 FROM message_templates t FULL JOIN original_templates o ON t.id=o.id
          WHERE (to_jsonb(t)-'club_id') IS DISTINCT FROM to_jsonb(o))
          THEN RAISE EXCEPTION 'Legacy fields changed'; END IF;
      END $$;
      INSERT INTO message_templates(name,body,club_id)
        VALUES('Other club','Do not reassign','00000000-0000-4000-8000-000000000002');
    `);
    sql(migration);
    command(`
      DO $$ BEGIN
        IF (SELECT count(*) FROM message_templates)<>5 THEN RAISE EXCEPTION 'Rerun duplicated data'; END IF;
        IF (SELECT club_id FROM message_templates WHERE name='Other club')
          IS DISTINCT FROM '00000000-0000-4000-8000-000000000002'::uuid
          THEN RAISE EXCEPTION 'Other club reassigned'; END IF;
      END $$;
      -- Exercise rollback when an unexpected trigger rewrites timestamps.
      CREATE FUNCTION touch_template() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.updated_at:=now(); RETURN NEW; END $$;
      CREATE TRIGGER touch_template BEFORE UPDATE ON message_templates
        FOR EACH ROW EXECUTE FUNCTION touch_template();
      INSERT INTO message_templates(name,body,updated_at) VALUES('Unassigned','Preserve time','2020-01-01');
    `);
    const denied = spawnSync("psql", ["-h", root, "-p", "55441", "-U", "fixture_owner", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-f", migration], { encoding: "utf8", timeout: 30_000 });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Template fields or existing ownership changed unexpectedly/);
    command(`
      DO $$ BEGIN
        IF (SELECT club_id FROM message_templates WHERE name='Unassigned') IS NOT NULL
          OR (SELECT updated_at FROM message_templates WHERE name='Unassigned')<>'2020-01-01'::timestamptz
          THEN RAISE EXCEPTION 'Failed migration did not roll back'; END IF;
      END $$;
      DROP TRIGGER touch_template ON message_templates;
      UPDATE clubs SET slug='no-pb-club' WHERE slug='pb-club';
    `);
    const missingOwner = spawnSync("psql", ["-h", root, "-p", "55441", "-U", "fixture_owner", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-f", migration], { encoding: "utf8", timeout: 30_000 });
    assert.notEqual(missingOwner.status, 0);
    assert.match(missingOwner.stderr, /Exactly one pb-club must exist/);
  } finally {
    if (started) spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
  }
});
