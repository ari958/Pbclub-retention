/**
 * lib/jobStore.ts
 *
 * Replaces in-memory job state in sync.ts and import.ts with
 * Supabase-backed persistence. Jobs survive server restarts.
 *
 * Place this file at: artifacts/api-server/src/lib/jobStore.ts
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
);

export type JobStatus = "idle" | "running" | "cancelled" | "done" | "error";

export interface JobState {
  id: string;
  status: JobStatus;
  started_at: string | null;
  finished_at: string | null;
  stats: Record<string, number> | null;
  error: string | null;
  logs: string[];
}

const MAX_LOGS = 200;

export async function getJob(id: string): Promise<JobState> {
  const { data } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .single();

  if (!data) {
    return { id, status: "idle", started_at: null, finished_at: null, stats: null, error: null, logs: [] };
  }

  return {
    id: data.id,
    status: data.status,
    started_at: data.started_at,
    finished_at: data.finished_at,
    stats: data.stats,
    error: data.error,
    logs: Array.isArray(data.logs) ? data.logs : [],
  };
}

export async function startJob(id: string): Promise<void> {
  await supabase.from("jobs").upsert({
    id,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    stats: null,
    error: null,
    logs: [],
    updated_at: new Date().toISOString(),
  });
}

export async function appendJobLog(id: string, message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);

  // Fetch current logs, append, trim, write back
  const { data } = await supabase.from("jobs").select("logs").eq("id", id).single();
  const current: string[] = Array.isArray(data?.logs) ? data.logs : [];
  const updated = [...current, line].slice(-MAX_LOGS);

  await supabase
    .from("jobs")
    .update({ logs: updated, updated_at: new Date().toISOString() })
    .eq("id", id);
}

export async function finishJob(
  id: string,
  status: "done" | "cancelled" | "error",
  stats?: Record<string, number>,
  error?: string
): Promise<void> {
  await supabase.from("jobs").update({
    status,
    finished_at: new Date().toISOString(),
    ...(stats ? { stats } : {}),
    ...(error ? { error } : {}),
    updated_at: new Date().toISOString(),
  }).eq("id", id);
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
  await supabase.from("jobs").update({
    status: "cancelled",
    updated_at: new Date().toISOString(),
  }).eq("id", id);
}
