import { supabase } from "./supabaseClient";
import { withBackgroundLock } from "./backgroundLock";
import { backgroundJobsConfigured, setBackgroundWorkerLeader } from "./backgroundPolicy";
import { workerIdentity } from "./workerIdentity";
import { logger } from "./logger";

/** One elected process starts every scheduler. API-only contenders stay standby. */
export async function startBackgroundWorker(start: () => Promise<void>) {
  const register = async (state: "standby" | "leader") => {
    const { error } = await supabase.from("operator_worker_instances").upsert({
      ...workerIdentity, state, last_seen_at: new Date().toISOString(),
    }).abortSignal(AbortSignal.timeout(10_000));
    if (error) throw new Error("Cannot record worker heartbeat; install migration 020");
  };
  while (backgroundJobsConfigured()) {
    await register("standby");
    const result = await withBackgroundLock("background-worker", async () => {
      await register("leader");
      setBackgroundWorkerLeader(true);
      logger.info({ holder: workerIdentity }, "Background worker elected");
      await start();
      // SIGTERM retains its normal exit behavior. A dead process's lease expires;
      // a standby retries acquisition without ever starting duplicate schedulers.
      await new Promise<void>(() => {});
    }, supabase, () => register("leader"));
    if (result.acquired) return;
    logger.warn({ holder: workerIdentity }, "Background worker standby: another process holds the global lease");
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
}
