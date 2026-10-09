import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { operatorPostgresFixture } from "./fixtures/operatorPostgres";

type Message = {
  type: string; instance_id?: string; pid?: number; enabled?: boolean;
  level?: string; message?: string; renewal?: boolean; acquisition?: boolean; kind?: string;
};
type Worker = {
  process: ChildProcess; messages: Message[]; stderr: string;
  exited: boolean; code: number | null; signal: NodeJS.Signals | null;
  pid: number;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string, workers: Worker[], deadline = 5_000) {
  const end = Date.now() + deadline;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(30);
  }
  assert.fail(`${description} timed out: ${JSON.stringify(workers.map(worker => ({
    pid: worker.pid, exited: worker.exited, code: worker.code,
    signal: worker.signal, stderr: worker.stderr, messages: worker.messages,
  })))}`);
}

test("isolated production worker lifecycle through startup failures, crashes, suspension, failed heartbeats and overlapping releases",
  { timeout: 180_000 }, async t => {
    const fixture = operatorPostgresFixture();
    const { sql } = fixture;
    const workers: Worker[] = [];
    const bundle = join(fixture.root, "worker.cjs");
    const applicationBundle = join(fixture.root, "application-worker.cjs");
    try {
      const suspensionLauncher = join(fixture.root, "suspension-launcher");
      const compiler = spawnSync("cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
        new URL("./fixtures/suspensionLauncher.c", import.meta.url).pathname, "-o", suspensionLauncher],
      { encoding: "utf8", timeout: 30_000 });
      assert.equal(compiler.status, 0, `Cannot build isolated suspension launcher: ${compiler.error ?? ""}${compiler.stderr}`);
      sql(`CREATE TABLE fixture_starts(owner uuid PRIMARY KEY,pid integer,release text);
        CREATE TABLE fixture_work(id bigserial PRIMARY KEY,owner uuid,pid integer,release text);
        CREATE TABLE fixture_sms(event_id uuid PRIMARY KEY,owner uuid,pid integer);
        CREATE TABLE fixture_faults(pid integer,kind text,mode text,PRIMARY KEY(pid,kind));`);
      const fake = new URL("./fixtures/workerDatabase.ts", import.meta.url).pathname;
      const services = new URL("./fixtures/applicationServices.ts", import.meta.url).pathname;
      const outputs = await Promise.all([
        ["lifecycleWorker.ts", bundle], ["applicationWorker.ts", applicationBundle],
      ].map(([entry, outfile]) => build({
        entryPoints: [new URL(`./fixtures/${entry}`, import.meta.url).pathname],
        outfile, bundle: true, platform: "node", format: "cjs", metafile: true,
        plugins: [{
          name: "offline-worker-only",
          setup(builder) {
            builder.onLoad({ filter: /\/backgroundLock\.ts$/ }, args => ({
              // Scale the shared duration in the isolated bundle, so the SQL
              // lease and synchronous production deadline always agree.
              contents: readFileSync(args.path, "utf8").replace(
                "const leaseTtlSeconds = 120;",
                'const leaseTtlSeconds = process.env.FIXTURE_SUSPENSION === "true" ? 30 : 120;'),
              loader: "ts",
            }));
            builder.onResolve({ filter: /^\.\/(?:lib\/)?(supabaseClient|logger)$/ }, () => ({ path: fake }));
            builder.onResolve({
              filter: /^(?:\.\/app|\.\/lib\/(?:scheduler|queuePoller|clubResolver|operatorMonitoring)|\.\.\/schema-readiness\.mjs)$/,
            }, () => ({ path: services }));
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
      })));
      // Compile-time guard in addition to a scrubbed child environment: neither
      // Supabase, Twilio, production clients nor real schedulers may be bundled.
      for (const output of outputs) {
        for (const input of Object.keys(output.metafile!.inputs)) {
          assert.doesNotMatch(input, /node_modules|supabaseClient|\/logger\.ts|queuePoller|feedbackPoller|twilio/i);
        }
      }
      const applicationInputs = Object.keys(outputs[1].metafile!.inputs);
      for (const required of ["src/index.ts", "src/lib/backgroundWorker.ts", "src/lib/backgroundLock.ts"]) {
        assert.ok(applicationInputs.some(input => input.endsWith(required)), `Must exercise real ${required}`);
      }
      const launch = (release: string, legacyOwner?: string, application = false, startupFault?: string,
        suspension = false): Worker => {
        const child = spawn(suspension ? suspensionLauncher : process.execPath,
          [...(suspension ? [process.execPath] : []), application ? applicationBundle : bundle], {
          // Allowlist, not a copy of process.env: no shared credentials or URLs.
          env: {
            // Models the designated live instance, so the kill switch is on.
            PATH: process.env.PATH, NODE_ENV: "production", RUN_BACKGROUND_JOBS: "true", SCHEDULER_ENABLED: "true",
            SMS_LIVE: "false", WORKER_FIXTURE_SOCKET: fixture.root, FIXTURE_RELEASE: release,
            ...(application ? {
              PORT: "1", PUBLIC_API_URL: "https://fixture.invalid",
              OPERATOR_PASSWORD: "synthetic-fixture-only-password",
              ALERT_OPERATOR_TO: "+15555550100", TWILIO_PHONE_NUMBER: "+15555550101",
              TWILIO_ACCOUNT_SID: "fixture-not-a-credential", TWILIO_AUTH_TOKEN: "fixture-not-a-credential",
            } : {}),
            ...(startupFault ? { FIXTURE_STARTUP_FAULT: startupFault } : {}),
            ...(suspension ? { FIXTURE_SUSPENSION: "true" } : {}),
            ...(legacyOwner ? { FIXTURE_LEGACY: "true", FIXTURE_LEGACY_OWNER: legacyOwner } : {}),
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        assert.ok(child.pid);
        const worker: Worker = { process: child, pid: child.pid, messages: [], stderr: "", exited: false, code: null, signal: null };
        child.on("message", message => {
          const event = message as Message;
          worker.messages.push(event);
          if (event.type === "ready") worker.pid = event.pid!;
        });
        child.stderr!.on("data", data => { worker.stderr += String(data); });
        child.on("error", error => { worker.stderr += `Child process error: ${String(error)}\n`; });
        child.on("exit", (code, signal) => { worker.exited = true; worker.code = code; worker.signal = signal; });
        workers.push(worker);
        return worker;
      };
      const stop = async (worker: Worker) => {
        // Kill the launcher; its parent-death signal also kills a stopped child.
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
            if (error) reject(new Error(`API probe failed for pid=${worker.pid}: ${error}; ${worker.stderr}`));
            else resolve();
          });
        });
      };
      const identity = (worker: Worker) => worker.messages.find(message => message.type === "ready")!.instance_id!;
      const owner = () => sql("SELECT owner FROM operator_job_locks WHERE name='background-worker'");
      const electedPair = async (suspension = false) => {
        const pair = [launch("old-release", undefined, false, undefined, suspension),
          launch("upgraded-release", undefined, false, undefined, suspension)];
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
        assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${standby.pid}`), "0");
        assert.equal(sql("SELECT count(*) FROM fixture_sms"), "1");
        assert.equal(leader.exited, false, leader.stderr);
        assert.equal(standby.exited, false, standby.stderr);
        return { leader, standby, pair };
      };
      const takeoverAfterExit = async (leader: Worker, standby: Worker) => {
        assert.equal(leader.exited, true, "must observe OS exit before expiring the lease");
        const oldWork = sql(`SELECT count(*) FROM fixture_work WHERE pid=${leader.pid}`);
        assert.equal(starts(), 1, "replacement must not start before old worker exits");
        assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${standby.pid}`), "0");
        // Death leaves the lease intact; emulate passage of its 120s TTL only
        // after OS exit, not by prematurely stealing an alive owner's lease.
        sql(`UPDATE operator_job_locks SET expires_at=clock_timestamp()-interval '1 second'
          WHERE owner='${identity(leader)}'`);
        await until(() => starts() === 2 && sql(`SELECT count(*) FROM fixture_work WHERE pid=${standby.pid}`) !== "0",
          "exactly one replacement performs protected work", [standby]);
        await sleep(650);
        assert.equal(starts(), 2, "scheduler callback runs once per owner");
        assert.equal(owner(), identity(standby));
        assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${leader.pid}`), oldWork);
        assert.equal(sql("SELECT count(*) FROM fixture_sms"), "2", "one fake SMS claim per elected owner");
        assert.equal(sql(`SELECT count(*) FROM fixture_work w JOIN fixture_starts s ON s.owner=w.owner
          WHERE w.pid<>s.pid OR w.release<>s.release`), "0");
        assert.equal(standby.exited, false, standby.stderr);
      };

      for (const fault of ["acquire", "initial-registry-standby", "initial-registry-leader", "scheduler"]) {
        await t.test(`${fault}: actual application startup exits before safe replacement`, async subtest => {
          subtest.after(reset);
          const began = Date.now();
          const failed = launch("failed-startup", undefined, true, fault);
          await until(() => failed.exited, "bounded application startup shutdown", [failed], 5_000);
          assert.ok(Date.now() - began < 5_000);
          assert.equal(failed.code, 1, failed.stderr);
          assert.equal(failed.signal, null, "application exits itself, not via harness SIGKILL");
          assert.ok(failed.messages.some(message => message.type === "schema-ready"),
            "fault must be reached after startup preflight");
          assert.ok(failed.messages.some(message => message.type === "log" && message.level === "fatal"
            && message.message === "Background worker startup failed; terminating"),
          "must execute index.ts startup rejection handler, not a fixture catch or renewal failure");
          if (fault === "scheduler") {
            assert.equal(failed.messages.filter(message => message.type === "scheduler-timer-started").length, 1,
              "partial scheduler creates exactly one live timer before throwing");
          } else {
            assert.ok(failed.messages.some(message => message.type === "startup-fault" && message.kind === fault));
            assert.ok(!failed.messages.some(message => message.type === "scheduler-timer-started"));
          }
          for (const type of ["protected-callback", "schedulers-started", "queue-started", "watchdog-started"]) {
            assert.ok(!failed.messages.some(message => message.type === type), `failed startup must not reach ${type}`);
          }
          assert.equal(starts(), 0);
          assert.equal(sql("SELECT count(*) FROM fixture_work"), "0");
          assert.equal(sql("SELECT count(*) FROM fixture_sms"), "0");
          assert.equal(owner(), "", "startup exception releases any acquired global lease");

          // Start two replacements only after observing OS exit. No artificial
          // expiry: the failed startup's real finally path must release its lease.
          const failedMessages = failed.messages.length;
          const replacements = [
            launch("replacement-one", undefined, true),
            launch("replacement-two", undefined, true),
          ];
          await until(() => replacements.every(worker => worker.messages.some(message => message.type === "ready"))
            && starts() === 1 && sql("SELECT count(*) FROM fixture_sms") === "1",
          "one replacement starts safely after startup failure", replacements);
          const winner = replacements.find(worker => identity(worker) === owner())!;
          const standby = replacements.find(worker => worker !== winner)!;
          assert.ok(winner);
          await until(() => standby.messages.some(message => message.type === "log"
            && message.message?.includes("standby")), "replacement contender stays standby", replacements);
          await Promise.all(replacements.map(ping));
          await until(() => replacements.every(worker => worker.messages.some(message => message.type === "api")),
            "replacement APIs responsive", replacements);
          await sleep(650); // Let the partial timer and multiple renewals have time to fire.
          assert.equal(starts(), 1);
          assert.equal(sql("SELECT count(*) FROM fixture_sms"), "1");
          assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${failed.pid}`), "0");
          assert.equal(sql(`SELECT count(*) FROM fixture_sms WHERE pid=${failed.pid}`), "0");
          assert.equal(failed.messages.length, failedMessages, "dead process leaves no protected callbacks");
          assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${standby.pid}`), "0");
          assert.ok(!standby.messages.some(message => message.type === "scheduler-timer-started"));
          assert.equal(winner.messages.filter(message => message.type === "scheduler-timer-started").length, 1);
          assert.equal(winner.messages.find(message => message.type === "api")!.enabled, true);
          assert.equal(standby.messages.find(message => message.type === "api")!.enabled, false);
          for (const worker of replacements) assert.equal(worker.exited, false, worker.stderr);
        });
      }

      await t.test("SIGKILL leaves standby alive and elects exactly one replacement", async subtest => {
        subtest.after(reset);
        const { leader, standby } = await electedPair();
        await stop(leader);
        assert.equal(leader.signal, "SIGKILL");
        await takeoverAfterExit(leader, standby);
      });

      for (const inFlight of [false, true]) {
        await t.test(`SIGSTOP/SIGCONT ${inFlight ? "in-flight callback" : "idle worker"} cannot work after takeover`,
          async subtest => {
            subtest.after(reset);
            const { leader, standby, pair } = await electedPair(true);
            if (inFlight) {
              leader.process.send("in-flight");
              await until(() => leader.messages.some(message => message.type === "callback-in-flight"),
                "callback awaiting with a held job lease", pair);
              assert.equal(sql(`SELECT owner FROM operator_job_locks WHERE name='fixture-scheduler'`),
                identity(leader));
            }
            const status = () => readFileSync(`/proc/${leader.pid}/status`, "utf8");
            assert.match(status(), /^TracerPid:\s+0$/m, "suspension worker must not inherit signal-consuming tracing");
            process.kill(leader.pid, "SIGSTOP");
            await until(() => /^State:\s+T/m.test(status()),
              "OS-confirmed process suspension", pair);
            const oldWork = sql(`SELECT count(*) FROM fixture_work WHERE pid=${leader.pid}`);
            const oldSms = sql(`SELECT count(*) FROM fixture_sms WHERE pid=${leader.pid}`);
            const oldHeartbeat = sql(`SELECT last_seen_at FROM operator_worker_instances
              WHERE instance_id='${identity(leader)}'`);
            // No UPDATE to steal a live lease: only the fixture's TTL is scaled.
            // Both the global lease and any held job lease expire in PostgreSQL.
            await until(() => {
              // Check sustained group-stop at every takeover poll, rather than
              // accepting one transient tracing stop as proof of suspension.
              assert.match(status(), /^State:\s+T/m, "worker must remain OS-stopped through takeover");
              return owner() === identity(standby) && starts() === 2
                && sql(`SELECT count(*) FROM fixture_sms WHERE pid=${standby.pid}`) === "1";
            },
            "replacement works while the original is still stopped", pair, 35_000);
            assert.equal(leader.exited, false, "suspension is not process death");
            assert.match(status(), /^State:\s+T/m);
            assert.equal(sql(`SELECT count(*) FROM operator_job_locks
              WHERE owner='${identity(leader)}' AND expires_at>clock_timestamp()`), "0");
            assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${leader.pid}`), oldWork);
            assert.equal(sql(`SELECT last_seen_at FROM operator_worker_instances
              WHERE instance_id='${identity(leader)}'`), oldHeartbeat, "suspended worker cannot renew its registry");
            process.kill(leader.pid, "SIGCONT");
            await until(() => leader.exited, "resumed worker terminates on lease loss", pair);
            assert.equal(leader.code, 1, leader.stderr);
            assert.equal(leader.signal, null, "production fail-stop, not harness cleanup");
            if (inFlight) assert.ok(!leader.messages.some(message => message.type === "callback-resumed"),
              "deadline guard must stop the pending continuation before it runs");
            assert.ok(leader.messages.some(message => message.type === "log" && message.level === "fatal"
              && message.message?.includes("Lost database job lease")));
            assert.deepEqual({
              work: sql(`SELECT count(*) FROM fixture_work WHERE pid=${leader.pid}`),
              sms: sql(`SELECT count(*) FROM fixture_sms WHERE pid=${leader.pid}`),
            }, { work: oldWork, sms: oldSms },
            "resumed callbacks must neither mutate protected data nor submit fake SMS");
            await sleep(650);
            assert.equal(owner(), identity(standby));
            assert.equal(starts(), 2);
            assert.equal(sql("SELECT count(*) FROM fixture_sms"), "2");
            assert.equal(standby.exited, false, standby.stderr);
          });
      }

      for (const [kind, mode] of [
        ["renew", "false"], ["renew", "error"], ["renew", "hang"],
        ["registry", "error"], ["registry", "hang"],
      ]) {
        await t.test(`${kind} ${mode}: fail-stop within deadline before replacement work`, async subtest => {
          subtest.after(reset);
          const { leader, standby } = await electedPair();
          const began = Date.now();
          sql(`INSERT INTO fixture_faults VALUES(${leader.pid},'${kind}','${mode}')`);
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
        assert.equal(sql(`SELECT count(*) FROM fixture_work WHERE pid=${loser.pid}`), "0");
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
