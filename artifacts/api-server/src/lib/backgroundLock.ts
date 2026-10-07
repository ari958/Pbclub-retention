import { randomUUID } from "node:crypto";
import { supabase } from "./supabaseClient";
import { logger } from "./logger";
import { backgroundJobsConfigured } from "./backgroundPolicy";
import { workerIdentity } from "./workerIdentity";

/** Renewable, owner-bound database leases; missing migration fails closed. */
export async function withBackgroundLock<T>(
  name: string, work: (owner: string) => Promise<T>, client = supabase,
  onRenew?: () => Promise<void>,
): Promise<{ acquired: boolean; value?: T }> {
  const owner = process.env.NODE_ENV === "test" ? randomUUID() : workerIdentity.instance_id;
  const { data, error } = await client.rpc("operator_acquire_job_lock", { p_name: name, p_owner: owner, p_ttl_seconds: 120 });
  if (error) throw new Error(`Cannot acquire ${name} lock: ${error.message}`);
  if (data !== true) return { acquired: false };
  const runId = randomUUID();
  const traced = process.env.NODE_ENV === "production" && name !== "background-worker";
  let completed = false;
  let lost: Error | null = null;
  let renewing = false;
  const heartbeat = backgroundJobsConfigured() ? setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const result = await client.rpc("operator_renew_job_lock", { p_name: name, p_owner: owner, p_ttl_seconds: 120 })
        .abortSignal(AbortSignal.timeout(10_000));
      if (result.error || result.data !== true) throw new Error("Database job lease renewal failed");
      await onRenew?.();
    } catch (error) {
      lost = error instanceof Error ? error : new Error(String(error));
      logger.fatal({ job: name, err: lost }, "Lost database job lease; terminating worker to prevent overlap");
      // Don't allow an old worker to keep sending after another acquires an expired lease.
      if (process.env.NODE_ENV !== "test") process.exit(1);
    } finally { renewing = false; }
  }, 30_000) : null;
  heartbeat?.unref();
  try {
    if (traced) {
      const trace = await client.from("operator_worker_runs").insert({
        id: runId, job: name, holder: workerIdentity, started_at: new Date().toISOString(), status: "running",
      });
      if (trace.error) throw new Error("Cannot record background execution; install migration 020");
      logger.info({ run_id: runId, job: name, holder: workerIdentity }, "Background execution started");
    }
    const value = await work(owner);
    if (lost) throw lost;
    completed = true;
    return { acquired: true, value };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (traced) {
      const trace = await client.from("operator_worker_runs").update({
        status: completed ? "done" : "error", finished_at: new Date().toISOString(),
      }).eq("id", runId);
      if (trace.error) logger.error({ run_id: runId, job: name }, "Background completion persistence failed");
      logger.info({ run_id: runId, job: name, completed, holder: workerIdentity }, "Background execution finished");
    }
    const released = await client.rpc("operator_release_job_lock", { p_name: name, p_owner: owner });
    if (released.error) logger.error({ job: name, error: released.error.message }, "Could not release database job lease");
  }
}
