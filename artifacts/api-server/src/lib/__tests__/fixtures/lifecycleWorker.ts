import { randomUUID } from "node:crypto";
import { startBackgroundWorker } from "../../backgroundWorker";
import { withBackgroundLock } from "../../backgroundLock";
import { backgroundJobsEnabled } from "../../backgroundPolicy";
import { workerIdentity } from "../../workerIdentity";
import { literal, sql, supabase } from "./workerDatabase";

// Deliberately run production policy: NODE_ENV=test bypasses leader gating and
// process.exit on renewal loss, so it cannot prove the real lifecycle.
if (process.env.NODE_ENV !== "production" || process.env.SMS_LIVE !== "false") {
  throw new Error("Unsafe synthetic worker environment");
}
// Deny network transports even if an accidental dependency is later introduced.
globalThis.fetch = async () => { throw new Error("Network forbidden in worker fixture"); };
process.on("message", message => {
  if (message === "ping") process.send?.({
    type: "api", enabled: backgroundJobsEnabled(), ...workerIdentity,
  });
  if (message === "in-flight") suspendNextTick = true;
});
process.send?.({ type: "ready", ...workerIdentity });
let suspendNextTick = false;

async function fakeSms(claim: unknown) {
  const event = claim as { id: string };
  await sql(`INSERT INTO fixture_sms(event_id,owner,pid)
    VALUES(${literal(event.id)},${literal(workerIdentity.instance_id)},${process.pid})`);
}

async function protectedTick() {
  if (!backgroundJobsEnabled()) throw new Error("Standby started protected work");
  await withBackgroundLock("fixture-scheduler", async () => {
    if (suspendNextTick) {
      suspendNextTick = false;
      process.send?.({ type: "callback-in-flight", ...workerIdentity });
      // Keep the real job lock held across an asynchronous callback. On resume,
      // this continuation competes with overdue production lease heartbeats.
      await new Promise(resolve => setTimeout(resolve, 1_000));
      process.send?.({ type: "callback-resumed", ...workerIdentity });
    }
    await sql(`INSERT INTO fixture_work(owner,pid,release)
      VALUES(${literal(workerIdentity.instance_id)},${process.pid},${literal(process.env.FIXTURE_RELEASE)})`);
    const claim = await supabase.rpc("operator_observe_alert", {
      p_key: `fixture:${workerIdentity.instance_id}`, p_active: true,
      p_text: "Local fixture only", p_holder: workerIdentity,
    });
    if (claim.error) throw new Error(claim.error.message);
    if (claim.data) await fakeSms(claim.data);
  });
}

async function main() {
  if (process.env.FIXTURE_LEGACY === "true") {
    // Pre-upgrade workers used an anonymous per-job UUID, unrelated to global
    // identity. They must be fenced even while the old lease row still exists.
    const owner = process.env.FIXTURE_LEGACY_OWNER!;
    const renewal = await supabase.rpc("operator_renew_job_lock", {
      p_name: "fixture-scheduler", p_owner: owner, p_ttl_seconds: 120,
    });
    const acquisition = await supabase.rpc("operator_acquire_job_lock", {
      p_name: "legacy-sms", p_owner: randomUUID(), p_ttl_seconds: 120,
    });
    process.send?.({ type: "legacy-fenced", renewal: renewal.data, acquisition: acquisition.data });
    setInterval(() => {}, 1_000);
    return;
  }
  await startBackgroundWorker(async () => {
    await sql(`INSERT INTO fixture_starts(owner,pid,release)
      VALUES(${literal(workerIdentity.instance_id)},${process.pid},${literal(process.env.FIXTURE_RELEASE)})`);
    process.send?.({ type: "schedulers-started", ...workerIdentity });
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try { await protectedTick(); }
      catch (error) { process.stderr.write(String(error)); process.exit(2); }
      finally { busy = false; }
    };
    await tick();
    setInterval(tick, 100);
  });
}
main().catch(error => { process.stderr.write(String(error)); process.exit(2); });
