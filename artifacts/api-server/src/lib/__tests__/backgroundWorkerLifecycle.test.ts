import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";

type Message = {
  type: string; instance_id?: string; pid?: number; enabled?: boolean;
  level?: string; message?: string; renewal?: boolean; acquisition?: boolean;
};
type Worker = {
  process: ChildProcess; messages: Message[]; stderr: string;
  exited: boolean; code: number | null; signal: NodeJS.Signals | null;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string, workers: Worker[], deadline = 5_000) {
  const end = Date.now() + deadline;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(30);
  }
  assert.fail(`${description} timed out: ${JSON.stringify(workers.map(worker => ({
    pid: worker.process.pid, exited: worker.exited, code: worker.code,
    signal: worker.signal, stderr: worker.stderr, messages: worker.messages,
  })))}`);
}

test("isolated production worker lifecycle through crashes, failed heartbeats and overlapping releases",
  { timeout: 120_000 }, async t => {
    const fixture = operatorPostgresFixture();
    const { sql } = fixture;
    const workers: Worker[] = [];
    const bundle = join(fixture.root, "worker.cjs");
    try {
      sql(`CREATE TABLE fixture_starts(owner uuid PRIMARY KEY,pid integer,release text);
        CREATE TABLE fixture_work(id bigserial PRIMARY KEY,owner uuid,pid integer,release text);
        CREATE TABLE fixture_sms(event_id uuid PRIMARY KEY,owner uuid,pid integer);
        CREATE TABLE fixture_faults(pid integer,kind text,mode text,PRIMARY KEY(pid,kind));`);
      const fake = new URL("./fixtures/workerDatabase.ts", import.meta.url).pathname;
      const output = await build({
        entryPoints: [new URL("./fixtures/lifecycleWorker.ts", import.meta.url).pathname],
        outfile: bundle, bundle: true, platform: "node", format: "cjs", metafile: true,
        plugins: [{
          name: "offline-worker-only",
          setup(builder) {
            builder.onResolve({ filter: /^\.\/(supabaseClient|logger)$/ }, () => ({ path: fake }));
          },
        }],
        // Only scale production's fixed wait/renew/abort deadlines. Keep the
        // real startup loop, policy, identity, fencing SQL and process.exit.
        banner: { js: `const realInterval = global.setInterval;
          const realTimeout = global.setTimeout;
          global.setInterval = (fn, ms, ...args) => realInterval(fn, ms === 30000 ? 300 : ms, ...args);
          global.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 30000 ? 150 : ms, ...args);
          const realAbortTimeout = AbortSignal.timeout.bind(AbortSignal);
          AbortSignal.timeout = ms => realAbortTimeout(ms === 10000 ? 2000 : ms);` },
      });
      // Compile-time guard in addition to a scrubbed child environment: neither
      // Supabase, Twilio, production clients nor real schedulers may be bundled.
      for (const input of Object.keys(output.metafile!.inputs)) {
        assert.doesNotMatch(input, /node_modules|supabaseClient|\/logger\.ts|queuePoller|feedbackPoller|twilio/i);
      }
      const launch = (release: string, legacyOwner?: string): Worker => {
        const child = spawn(process.execPath, [bundle], {
          // Allowlist, not a copy of process.env: no shared credentials or URLs.
          env: {
            PATH: process.env.PATH, NODE_ENV: "production", RUN_BACKGROUND_JOBS: "true",
            SMS_LIVE: "false", WORKER_FIXTURE_SOCKET: fixture.root, FIXTURE_RELEASE: release,
            ...(legacyOwner ? { FIXTURE_LEGACY: "true", FIXTURE_LEGACY_OWNER: legacyOwner } : {}),
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        const worker: Worker = { process: child, messages: [], stderr: "", exited: false, code: null, signal: null };
        child.on("message", message => worker.messages.push(message as Message));
        child.stderr!.on("data", data => { worker.stderr += String(data); });
        child.on("error", error => { worker.stderr += `Child process error: ${String(error)}\n`; });
        child.on("exit", (code, signal) => { worker.exited = true; worker.code = code; worker.signal = signal; });
        workers.push(worker);
        return worker;
      };
      const stop = async (worker: Worker) => {
        if (!worker.exited) worker.process.kill("SIGKILL");
        await until(() => worker.exited, "worker exit", [worker]);
      };
      const reset = async () => {
        await Promise.all(workers.map(stop));
        workers.length = 0;
        sql(`TRUNCATE fixture_starts,fixture_work,fixture_sms,fixture_faults,
          operator_job_locks,operator_worker_instances,operator_worker_runs,
          operator_alert_events,operator_alert_incidents RESTART IDENTITY`);
      };
      const starts = () => Number(sql("SELECT count(*) FROM fixture_starts"));
      const ping = async (worker: Worker) => {
        assert.ok(!worker.exited && worker.process.connected,
          `API probe requires a live worker: ${worker.stderr}`);
        await new Promise<void>((resolve, reject) => {
          worker.process.send("ping", error => {
            if (error) reject(new Error(`API probe failed for pid=${worker.process.pid}: ${error}; ${worker.stderr}`));
            else resolve();
          });
        });
      };
      const identity = (worker: Worker) => worker.messages.find(message => message.type === "ready")!.instance_id!;
      const owner = () => sql("SELECT owner FROM operator_job_locks WHERE name='background-worker'");
      const electedPair = async () => {
        const pair = [launch("old-release"), launch("upgraded-release")];
        await until(() => pair.every(worker => worker.messages.some(message => message.type === "ready"))
          && starts() === 1, "one elected process", pair);
        const leader = pair.find(worker => identity(worker) === owner())!;
        const standby = pair.find(worker => worker !== leader)!;
        assert.ok(leader);
        await until(() => standby.messages.some(message => message.type === "log"
          && message.message?.includes("standby")), "API-only standby", pair);
        await Promise.all([ping(leader), ping(standby)]);
        await until(() => pair.every(worker => worker.messages.some(message => message.type === "api")),
          "both processes remain API responsive", pair);
        assert.equal(leader.messages.find(message => message.type === "api")!.enabled, true);
        assert.equal(standby.messages.find(message => message.type === "api")!.enabled, false);
        await sleep(650); // Multiple renewals and failed standby acquisitions.
        assert.equal(starts(), 1);
        assert.equal(sql(`SELECT state FROM operator_worker_instances WHERE instance_id='${identity(standby)}'`), "standby");
        assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${standby.process.pid}`), "0");
        assert.equal(sql("SELECT count(*) FROM fixture_sms"), "1");
        assert.equal(leader.exited, false, leader.stderr);
        assert.equal(standby.exited, false, standby.stderr);
        return { leader, standby, pair };
      };
      const takeoverAfterExit = async (leader: Worker, standby: Worker) => {
        assert.equal(leader.exited, true, "must observe OS exit before expiring the lease");
        const oldWork = sql(`SELECT count(*) FROM fixture_work WHERE pid=${leader.process.pid}`);
        assert.equal(starts(), 1, "replacement must not start before old worker exits");
        assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${standby.process.pid}`), "0");
        // Death leaves the lease intact; emulate passage of its 120s TTL only
        // after OS exit, not by prematurely stealing an alive owner's lease.
        sql(`UPDATE operator_job_locks SET expires_at=clock_timestamp()-interval '1 second'
          WHERE owner='${identity(leader)}'`);
        await until(() => starts() === 2 && sql(`SELECT count(*) FROM fixture_work WHERE pid=${standby.process.pid}`) !== "0",
          "exactly one replacement performs protected work", [standby]);
        await sleep(650);
        assert.equal(starts(), 2, "scheduler callback runs once per owner");
        assert.equal(owner(), identity(standby));
        assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${leader.process.pid}`), oldWork);
        assert.equal(sql("SELECT count(*) FROM fixture_sms"), "2", "one fake SMS claim per elected owner");
        assert.equal(sql(`SELECT count(*) FROM fixture_work w JOIN fixture_starts s ON s.owner=w.owner
          WHERE w.pid<>s.pid OR w.release<>s.release`), "0");
        assert.equal(standby.exited, false, standby.stderr);
      };

      await t.test("SIGKILL leaves standby alive and elects exactly one replacement", async subtest => {
        subtest.after(reset);
        const { leader, standby } = await electedPair();
        await stop(leader);
        assert.equal(leader.signal, "SIGKILL");
        await takeoverAfterExit(leader, standby);
      });

      for (const [kind, mode] of [
        ["renew", "false"], ["renew", "error"], ["renew", "hang"],
        ["registry", "error"], ["registry", "hang"],
      ]) {
        await t.test(`${kind} ${mode}: fail-stop within deadline before replacement work`, async subtest => {
          subtest.after(reset);
          const { leader, standby } = await electedPair();
          const began = Date.now();
          sql(`INSERT INTO fixture_faults VALUES(${leader.process.pid},'${kind}','${mode}')`);
          await until(() => leader.exited, "production fail-stop", [leader, standby], 5_000);
          assert.ok(Date.now() - began < 5_000);
          assert.equal(leader.code, 1, leader.stderr);
          assert.ok(leader.messages.some(message => message.type === "log" && message.level === "fatal"),
            "renewal and registry timeout failures use the actual fatal path");
          await takeoverAfterExit(leader, standby);
        });
      }

      await t.test("anonymous pre-upgrade leases fence old work during overlapping upgraded releases", async subtest => {
        subtest.after(reset);
        const anonymous = "00000000-0000-4000-8000-000000000099";
        const oldGlobalOwner = "00000000-0000-4000-8000-000000000098";
        // A pre-migration anonymous lease and global owner still have time left.
        sql(`INSERT INTO operator_job_locks VALUES
          ('background-worker','${oldGlobalOwner}',clock_timestamp()+interval '120 seconds'),
          ('fixture-scheduler','${anonymous}',clock_timestamp()+interval '120 seconds')`);
        const legacy = launch("legacy-release", anonymous);
        const pair = [launch("upgrade-one"), launch("upgrade-two")];
        await until(() => legacy.messages.some(message => message.type === "legacy-fenced")
          && pair.every(worker => worker.messages.some(message => message.type === "log"
            && message.message?.includes("standby"))), "legacy fencing and upgrade standby", workers);
        const fenced = legacy.messages.find(message => message.type === "legacy-fenced")!;
        // Both an existing anonymous lease and a fresh random per-job owner
        // are fenced, even before their old lease expiry.
        assert.equal(fenced.renewal, false);
        assert.equal(fenced.acquisition, false);
        assert.equal(starts(), 0);
        assert.equal(sql("SELECT count(*) FROM fixture_work"), "0");
        assert.equal(sql("SELECT count(*) FROM fixture_sms"), "0");
        await stop(legacy);
        sql("UPDATE operator_job_locks SET expires_at=clock_timestamp()-interval '1 second'");
        assert.equal(sql(`SELECT operator_renew_job_lock('fixture-scheduler','${anonymous}',120)`), "f");
        await until(() => starts() === 1 && sql("SELECT count(*) FROM fixture_sms") === "1",
          "one upgraded release starts after legacy death", pair);
        await sleep(650);
        assert.equal(starts(), 1);
        const winner = pair.find(worker => identity(worker) === owner())!;
        const loser = pair.find(worker => worker !== winner)!;
        assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${loser.process.pid}`), "0");
        assert.equal(sql(`SELECT operator_acquire_job_lock('legacy-sms','${anonymous}',120)`), "f");
        assert.equal(sql(`SELECT operator_renew_job_lock('fixture-scheduler','${anonymous}',120)`), "f");
        assert.equal(winner.exited, false, winner.stderr);
        assert.equal(loser.exited, false, loser.stderr);
      });
    } finally {
      // Stop every child before removing its socket/database, including on an
      // assertion failure. Never leave synthetic workers running in the repl.
      await Promise.all(workers.map(async worker => {
        if (!worker.exited) worker.process.kill("SIGKILL");
        await until(() => worker.exited, "cleanup exit", [worker]);
      }));
      fixture.close();
    }
  });
