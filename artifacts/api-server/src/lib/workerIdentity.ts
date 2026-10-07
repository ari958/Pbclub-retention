import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export const workerIdentity = Object.freeze({
  instance_id: randomUUID(),
  pid: process.pid,
  host: hostname(),
  started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  environment: process.env.NODE_ENV ?? "unknown",
  run_background_jobs: process.env.RUN_BACKGROUND_JOBS ?? "unset",
});
