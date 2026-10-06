import { randomUUID } from "node:crypto";
import { supabase } from "./supabaseClient";
import { logger } from "./logger";
import { backgroundJobsEnabled } from "./backgroundPolicy";

/** Renewable, owner-bound database leases; missing migration fails closed. */
export async function withBackgroundLock<T>(
  name: string, work: () => Promise<T>, client = supabase,
): Promise<{ acquired: boolean; value?: T }> {
  const owner = randomUUID();
  const { data, error } = await client.rpc("operator_acquire_job_lock", { p_name: name, p_owner: owner, p_ttl_seconds: 120 });
  if (error) throw new Error(`Cannot acquire ${name} lock: ${error.message}`);
  if (data !== true) return { acquired: false };
  let lost: Error | null = null;
  let renewing = false;
  const heartbeat = backgroundJobsEnabled() ? setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const result = await client.rpc("operator_renew_job_lock", { p_name: name, p_owner: owner, p_ttl_seconds: 120 })
        .abortSignal(AbortSignal.timeout(10_000));
      if (result.error || result.data !== true) throw new Error("Database job lease renewal failed");
    } catch (error) {
      lost = error instanceof Error ? error : new Error(String(error));
      logger.fatal({ job: name, err: lost }, "Lost database job lease; terminating worker to prevent overlap");
      // Don't allow an old worker to keep sending after another acquires an expired lease.
      if (process.env.NODE_ENV !== "test") process.exit(1);
    } finally { renewing = false; }
  }, 30_000) : null;
  heartbeat?.unref();
  try {
    const value = await work();
    if (lost) throw lost;
    return { acquired: true, value };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    const released = await client.rpc("operator_release_job_lock", { p_name: name, p_owner: owner });
    if (released.error) logger.error({ job: name, error: released.error.message }, "Could not release database job lease");
  }
}
