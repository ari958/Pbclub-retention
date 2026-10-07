import assert from "node:assert/strict";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";

test("real PostgreSQL singleton fencing, concurrent claims, one recovery, recurrence and legacy carry-forward", async () => {
  const { connection, sql, close } = operatorPostgresFixture();
  try {
    const a = "00000000-0000-4000-8000-000000000010";
    const b = "00000000-0000-4000-8000-000000000020";
    const holder = `'{"instance_id":"${a}","pid":1,"host":"fixture","started_at":"2026-01-01T00:00:00Z","run_background_jobs":"true"}'::jsonb`;
    sql(`DO $$ BEGIN
      IF NOT operator_acquire_job_lock('background-worker','${a}',120) THEN RAISE EXCEPTION 'No leader'; END IF;
      IF operator_acquire_job_lock('background-worker','${b}',120) THEN RAISE EXCEPTION 'Two leaders'; END IF;
      IF operator_acquire_job_lock('sms-queue','${b}',120) THEN RAISE EXCEPTION 'Legacy worker not fenced'; END IF;
      IF NOT operator_acquire_job_lock('sms-queue','${a}',120) THEN RAISE EXCEPTION 'Leader blocked'; END IF;
      IF operator_renew_job_lock('sms-queue','${b}',120) THEN RAISE EXCEPTION 'Foreign renewal'; END IF;
    END $$;`);
    const parallel = async (active: boolean) => {
      const command = `SELECT operator_observe_alert('queue_stale',${active},'Queue condition',${holder});`;
      await Promise.all(Array.from({length:6}, () => promisify(execFile)("psql",[...connection,"-c",command],{timeout:15_000})));
    };
    await parallel(true);
    await parallel(false);
    await parallel(false);
    await parallel(true);
    sql(`DO $$ BEGIN
      IF (SELECT count(*) FROM operator_alert_events WHERE phase='alert')<>2
        OR (SELECT count(*) FROM operator_alert_events WHERE phase='resolved')<>1
        THEN RAISE EXCEPTION 'Duplicate incident phase'; END IF;
      -- Legacy paused condition does not replay the old notification.
      IF operator_observe_alert('kill_switch:00000000-0000-4000-8000-000000000001',true,NULL,${holder}) IS NOT NULL
        THEN RAISE EXCEPTION 'Legacy pause replayed'; END IF;
      UPDATE clubs SET sms_kill_switch=false;
      -- Deliberately stale input; the RPC must read the actual database value.
      IF (operator_observe_alert('kill_switch:00000000-0000-4000-8000-000000000001',true,'Wrong text',${holder})->>'phase')<>'resolved'
        THEN RAISE EXCEPTION 'No kill-switch recovery'; END IF;
      IF operator_observe_alert('kill_switch:00000000-0000-4000-8000-000000000001',true,NULL,${holder}) IS NOT NULL
        THEN RAISE EXCEPTION 'Duplicate recovery'; END IF;
      UPDATE operator_job_locks SET expires_at=now()-interval '1 second' WHERE name='background-worker';
      IF operator_renew_job_lock('sms-queue','${a}',120) THEN RAISE EXCEPTION 'Expired global owner renewed'; END IF;
      IF NOT operator_acquire_job_lock('background-worker','${b}',120) THEN RAISE EXCEPTION 'No takeover'; END IF;
      IF operator_acquire_job_lock('nightly-chain','${a}',120) THEN RAISE EXCEPTION 'Old leader still running'; END IF;
    END $$;`);
    const refused = spawnSync("psql",[...connection,"-c",`SELECT operator_observe_alert('queue_stale',false,NULL,${holder})`],{encoding:"utf8"});
    assert.notEqual(refused.status,0);
    assert.match(refused.stderr,/not the active worker/);
    const anon = spawnSync("psql",[...connection,"-c","SET ROLE anon; SELECT * FROM operator_alert_events"],{encoding:"utf8"});
    assert.notEqual(anon.status,0);
    assert.match(anon.stderr,/permission denied/);
  } finally {
    close();
  }
});
