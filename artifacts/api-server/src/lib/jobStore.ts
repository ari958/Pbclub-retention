import { supabase } from "./supabaseClient";

export type JobStatus = "idle" | "running" | "cancelled" | "done" | "error";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface JobState {
  id: string;
  status: JobStatus;
  started_at: string | null;
  finished_at: string | null;
  stats: Record<string, number> | null;
  error: string | null;
  logs: string[];
}

const DEFAULT_LOG_LIMIT = 200;

/**
 * Get current state of a job. By default does NOT fetch logs (cheap).
 * Pass { withLogs: true } to fetch recent log lines from job_logs table.
 */
export async function getJob(
  id: string,
  options: { withLogs?: boolean; logLimit?: number } = {}
): Promise<JobState> {
  const { data } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single();

  let logs: string[] = [];
  if (options.withLogs) {
    const { data: logRows, error: logErr } = await supabase
      .from("job_logs")
      .select("logged_at, level, message")
      .eq("job_id", id)
      .order("logged_at", { ascending: false })
      .limit(options.logLimit ?? DEFAULT_LOG_LIMIT);
    if (logErr) {
      console.error(`[jobStore] getJob logs fetch failed for ${id}:`, logErr.message);
    } else if (logRows) {
      logs = logRows
        .slice()
        .reverse()
        .map((r: any) => `[${r.logged_at}] ${r.message}`);
    }
  }

  if (!data) {
    return {
      id,
      status: "idle",
      started_at: null,
      finished_at: null,
      stats: null,
      error: null,
      logs,
    };
  }

  return {
    id: data.id,
    status: data.status,
    started_at: data.started_at,
    finished_at: data.finished_at,
    stats: data.stats,
    error: data.error,
    logs,
  };
}

export async function startJob(id: string): Promise<void> {
  // Reclaim any stale running jobs (crash recovery) before starting a new one.
  // Silently succeeds if the last_heartbeat column doesn't exist yet (pre-migration 006).
  await reclaimStaleJobs();

  const { error } = await supabase
    .from("jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      stats: null,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error(`[jobStore] startJob failed for ${id}:`, error.message);
  }
}

/**
 * Update last_heartbeat for a running job.
 * Call every ~30 s during long-running loops so reclaimStaleJobs() can
 * distinguish a live-but-slow job from a crashed one.
 *
 * Silent no-op if the last_heartbeat column hasn't been added yet (pre-migration 006).
 */
export async function heartbeatJob(id: string): Promise<void> {
  try {
    const { error } = await supabase
      .from("jobs")
      .update({ last_heartbeat: new Date().toISOString() })
      .eq("id", id);
    if (error && !error.message.includes("last_heartbeat")) {
      console.warn(`[jobStore] heartbeatJob warning for ${id}:`, error.message);
    }
  } catch {
    // Heartbeat is non-critical — never propagate errors
  }
}

/**
 * Move any job that has been stuck in 'running' with no heartbeat update
 * for longer than thresholdMinutes to status='error'.
 *
 * Called automatically at the top of startJob() and exported so the status
 * endpoints can call it on demand.
 *
 * Returns the number of jobs reclaimed. Returns 0 silently if the
 * last_heartbeat column doesn't exist yet (pre-migration 006).
 */
export async function reclaimStaleJobs(thresholdMinutes = 5): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000).toISOString();
    const { data, error } = await supabase
      .from("jobs")
      .update({
        status: "error",
        error: `stale: no heartbeat for >${thresholdMinutes}m — process likely crashed`,
        updated_at: new Date().toISOString(),
      })
      .eq("status", "running")
      .lt("last_heartbeat", cutoff)
      .select("id");

    if (error) {
      // Column not yet added → ignore; any other error → log
      if (!error.message.includes("last_heartbeat")) {
        console.warn("[jobStore] reclaimStaleJobs error:", error.message);
      }
      return 0;
    }
    const reclaimed = (data ?? []).length;
    if (reclaimed > 0) {
      console.log(`[jobStore] reclaimStaleJobs: reclaimed ${reclaimed} stale job(s)`);
    }
    return reclaimed;
  } catch {
    return 0;
  }
}

/**
 * Append a log line for a job. Single INSERT to job_logs — no read-modify-write.
 * Safe under concurrent writers.
 */
export async function appendJobLog(
  id: string,
  message: string,
  level: LogLevel = "info",
  context?: Record<string, unknown>
): Promise<void> {
  console.log(`[${new Date().toISOString()}] [${id}] ${message}`);

  const { error } = await supabase.from("job_logs").insert({
    job_id: id,
    level,
    message,
    context: context ?? null,
  });

  if (error) {
    console.error(`[jobStore] appendJobLog insert failed for ${id}:`, error.message);
  }
}

export async function finishJob(
  id: string,
  status: "done" | "cancelled" | "error",
  stats?: Record<string, number>,
  error?: string
): Promise<void> {
  const { error: updateErr } = await supabase
    .from("jobs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      ...(stats ? { stats } : {}),
      ...(error ? { error } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (updateErr) {
    console.error(`[jobStore] finishJob failed for ${id}:`, updateErr.message);
  }
}

export async function isCancelled(id: string): Promise<boolean> {
  const { data } = await supabase
    .from("jobs")
    .select("status")
    .eq("id", id)
    .single();
  return data?.status === "cancelled";
}

export async function requestCancel(id: string): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error(`[jobStore] requestCancel failed for ${id}:`, error.message);
  }
}
