import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";

const migration = new URL("../../../migrations/030_operator_test_messages.sql", import.meta.url).pathname;

test("migration 030 is additive, reapplicable, private and constrained (real PostgreSQL)", () => {
  const { sql, connection, close } = operatorPostgresFixture();
  try {
    const apply = () => {
      const result = spawnSync("psql", [...connection, "-f", migration], { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
    };
    apply();
    apply(); // Reapplication must remain safe.
    const club = "00000000-0000-4000-8000-000000000001";
    assert.equal(sql(`SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='operator_test_messages'`), "11");
    assert.equal(sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.operator_test_messages'::regclass"), "t");
    for (const role of ["anon", "authenticated"]) {
      assert.equal(sql(`SELECT has_table_privilege('${role}','public.operator_test_messages','SELECT')
        OR has_table_privilege('${role}','public.operator_test_messages','INSERT')`), "f", `${role} must have no access`);
    }
    for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
      assert.equal(sql(`SELECT has_table_privilege('service_role','public.operator_test_messages','${privilege}')`), "t");
    }
    // Production had default privileges granting service_role ALL; the migration must take DELETE/TRUNCATE back.
    sql("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role");
    sql("DROP TABLE public.operator_test_messages"); apply();
    for (const privilege of ["DELETE", "TRUNCATE"]) {
      assert.equal(sql(`SELECT has_table_privilege('service_role','public.operator_test_messages','${privilege}')`), "f", privilege);
    }
    // Supabase's service_role has BYPASSRLS; like 017/020/029, this table relies
    // on it (RLS on, no policies), so mirror that before writing as service_role.
    sql("ALTER ROLE service_role BYPASSRLS");
    sql(`SET ROLE service_role;
      INSERT INTO public.operator_test_messages(id,club_id,actor) VALUES('00000000-0000-4000-8000-0000000000a1','${club}','operator:fixture');
      UPDATE public.operator_test_messages SET status='sent', twilio_message_sid='SMfixture', delivery_status='undelivered'
        WHERE id='00000000-0000-4000-8000-0000000000a1';
      RESET ROLE;`);
    assert.equal(sql("SELECT status||'/'||delivery_status FROM public.operator_test_messages"), "sent/undelivered");
    const rejects = (statement: string, pattern: RegExp) =>
      assert.throws(() => sql(statement), pattern, statement);
    rejects(`INSERT INTO public.operator_test_messages(id,club_id,actor,status)
      VALUES(gen_random_uuid(),'${club}','operator:fixture','undelivered')`, /check constraint/);
    rejects(`INSERT INTO public.operator_test_messages(id,club_id,actor) VALUES(gen_random_uuid(),'${club}','  ')`, /check constraint/);
    rejects(`INSERT INTO public.operator_test_messages(id,club_id,actor)
      VALUES(gen_random_uuid(),'00000000-0000-4000-8000-00000000ffff','operator:fixture')`, /foreign key/);
    rejects(`INSERT INTO public.operator_test_messages(id,club_id,actor,twilio_message_sid)
      VALUES(gen_random_uuid(),'${club}','operator:fixture','SMfixture')`, /unique/);
    // Untouched: the fixture's existing tables keep their shape.
    assert.equal(sql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='clubs'`), "3");
  } finally {
    close();
  }
});
