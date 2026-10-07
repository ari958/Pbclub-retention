import { backgroundJobsEnabled } from "../../backgroundPolicy";
import { withBackgroundLock } from "../../backgroundLock";
import { workerIdentity } from "../../workerIdentity";
import { literal, sql, supabase } from "./workerDatabase";

// Replace only unrelated entrypoint services, not its startup/election policy.
// IPC stands in for HTTP so no network listener or real Express routes load.
export default {
  listen(_port: number, callback: (error?: Error) => Promise<void>) {
    process.on("message", message => {
      if (message === "ping") process.send?.({
        type: "api", enabled: backgroundJobsEnabled(), ...workerIdentity,
      });
    });
    process.send?.({ type: "ready", ...workerIdentity });
    queueMicrotask(() => { void callback().catch(error => {
      process.stderr.write(`Unhandled fixture listen callback: ${String(error)}\n`);
      process.exit(2);
    }); });
  },
};
export const getDefaultClubSlug = () => "fixture-club";
export const resolveClubSlug = async () => "00000000-0000-4000-8000-000000000001";
export const checkSchemaReadiness = async () => {
  process.send?.({ type: "schema-ready", ...workerIdentity });
  return { schema: "passed", errors: [] };
};
export const startQueuePoller = () => process.send?.({ type: "queue-started", ...workerIdentity });
export const startOperatorWatchdog = () => process.send?.({ type: "watchdog-started", ...workerIdentity });

export function startScheduler() {
  let busy = false;
  let started = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    process.send?.({ type: "protected-callback", ...workerIdentity });
    try {
      if (!backgroundJobsEnabled()) throw new Error("Standby started protected work");
      if (!started) {
        await sql(`INSERT INTO fixture_starts(owner,pid,release)
          VALUES(${literal(workerIdentity.instance_id)},${process.pid},${literal(process.env.FIXTURE_RELEASE)})`);
        started = true;
      }
      await withBackgroundLock("fixture-scheduler", async () => {
        await sql(`INSERT INTO fixture_work(owner,pid,release)
          VALUES(${literal(workerIdentity.instance_id)},${process.pid},${literal(process.env.FIXTURE_RELEASE)})`);
        const claim = await supabase.rpc("operator_observe_alert", {
          p_key: `fixture:${workerIdentity.instance_id}`, p_active: true,
          p_text: "Local fixture only", p_holder: workerIdentity,
        });
        if (claim.error) throw new Error(claim.error.message);
        if (claim.data) await sql(`INSERT INTO fixture_sms(event_id,owner,pid)
          VALUES(${literal((claim.data as { id: string }).id)},${literal(workerIdentity.instance_id)},${process.pid})`);
      });
    } catch (error) {
      process.stderr.write(`Fixture scheduler failed: ${String(error)}\n`);
      process.exit(2);
    } finally { busy = false; }
  };
  // This live timer deliberately has no cleanup hook: only the application's
  // real process.exit can prevent it running after a partial startup failure.
  setInterval(tick, 100);
  process.send?.({ type: "scheduler-timer-started", ...workerIdentity });
  if (process.env.FIXTURE_STARTUP_FAULT === "scheduler") {
    throw new Error("Injected scheduler startup failure after timer creation");
  }
  process.send?.({ type: "schedulers-started", ...workerIdentity });
  void tick();
}
