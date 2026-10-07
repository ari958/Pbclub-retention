import { randomUUID } from "node:crypto";
import { createHook } from "node:async_hooks";
import { supabase } from "./supabaseClient";
import { logger } from "./logger";
import { backgroundJobsConfigured } from "./backgroundPolicy";
import { workerIdentity } from "./workerIdentity";

const leaseTtlSeconds = 120;
type LocalLease = { name: string; deadline: number };
const activeLeases = new Set<LocalLease>();
const monotonicNow = () => performance.now();
function checkLeaseDeadlines() {
  for (const lease of activeLeases) {
    if (monotonicNow() < lease.deadline) continue;
    logger.fatal({ job: lease.name }, "Lost database job lease; terminating worker to prevent overlap");
    // This check is synchronous and runs BEFORE an asynchronous continuation.
    // An overdue timer that awaits a renewal cannot protect other ready callbacks.
    process.exit(1);
  }
}
const continuationGuard = createHook({ before: checkLeaseDeadlines });

/** Renewable, owner-bound database leases; missing migration fails closed. */
export async function withBackgroundLock<T>(
  name: string, work: (owner: string) => Promise<T>, client = supabase,
  onRenew?: () => Promise<void>,
): Promise<{ acquired: boolean; value?: T }> {
  const owner = process.env.NODE_ENV === "test" ? randomUUID() : workerIdentity.instance_id;
  const acquisitionStarted = monotonicNow();
  const { data, error } = await client.rpc("operator_acquire_job_lock", { p_name: name, p_owner: owner, p_ttl_seconds: leaseTtlSeconds });
  if (error) throw new Error(`Cannot acquire ${name} lock: ${error.message}`);
  if (data !== true) return { acquired: false };
  const localLease = { name, deadline: acquisitionStarted + leaseTtlSeconds * 1_000 };
  if (process.env.NODE_ENV === "production") {
    activeLeases.add(localLease);
    continuationGuard.enable();
    // Also fence an acquisition response that arrives after its lease expired.
    checkLeaseDeadlines();
  }
  const runId = randomUUID();
  const traced = process.env.NODE_ENV === "production" && name !== "background-worker";
  let completed = false;
  let lost: Error | null = null;
  let renewing = false;
  const heartbeat = backgroundJobsConfigured() ? setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const renewalStarted = monotonicNow();
      const result = await client.rpc("operator_renew_job_lock", { p_name: name, p_owner: owner, p_ttl_seconds: leaseTtlSeconds })
        .abortSignal(AbortSignal.timeout(10_000));
      if (result.error || result.data !== true) throw new Error("Database job lease renewal failed");
      // Use request START, not response receipt: a delayed response must never
      // extend local authority beyond the database's actual expiration.
      localLease.deadline = renewalStarted + leaseTtlSeconds * 1_000;
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
    activeLeases.delete(localLease);
    if (activeLeases.size === 0) continuationGuard.disable();
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
