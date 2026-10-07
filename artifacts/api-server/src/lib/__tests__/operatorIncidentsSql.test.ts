import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

test("real PostgreSQL singleton fencing, concurrent claims, one recovery, recurrence and legacy carry-forward", async () => {
  const root = mkdtempSync(join(tmpdir(), "operator-incidents-"));
  const data = join(root, "data");
  const run = (cmd: string, args: string[]) => {
    const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
    return result;
  };
  const connection = ["-h",root,"-p","55442","-U","fixture_owner","-d","postgres","-v","ON_ERROR_STOP=1"];
  let started = false;
  try {
    run("initdb", ["-D",data,"-U","fixture_owner","-A","trust","--no-locale","-E","UTF8"]);
    run("pg_ctl", ["-D",data,"-l",join(root,"postgres.log"),"-o",`-k ${root} -p 55442 -c listen_addresses=''`,"-w","start"]);
    started = true;
    const sql = (source: string) => run("psql", [...connection,"-c",source]);
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE clubs(id uuid PRIMARY KEY,slug text,sms_kill_switch boolean);
      INSERT INTO clubs VALUES('00000000-0000-4000-8000-000000000001','pb-club',true);`);
    for (const file of ["017_operator_runtime.sql","020_operator_alert_incidents.sql","020_operator_alert_incidents.sql"]) {
      if (file.startsWith("017")) {
        run("psql",[...connection,"-f",new URL("../../../migrations/"+file,import.meta.url).pathname]);
        sql("INSERT INTO operator_runtime(name,result) VALUES('kill-switch','paused')");
      } else run("psql",[...connection,"-f",new URL("../../../migrations/"+file,import.meta.url).pathname]);
    }
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
    if (started) spawnSync("pg_ctl",["-D",data,"-m","immediate","-w","stop"]);
    rmSync(root,{recursive:true,force:true});
  }
});
