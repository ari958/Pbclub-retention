import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

const socket = process.env.WORKER_FIXTURE_SOCKET;
if (!socket || !isAbsolute(socket) || !socket.includes("/operator-postgres-")) {
  throw new Error("Worker harness requires its disposable PostgreSQL socket");
}
export const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
export async function sql(source: string, signal?: AbortSignal): Promise<string> {
  const result = await promisify(execFile)("psql", [
    "-h", socket!, "-p", "55442", "-U", "fixture_owner", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-At", "-c", source,
  ], { signal, timeout: 8_000 });
  return result.stdout.trim();
}

type Result = { data: unknown; error: { message: string } | null };
// Supabase's lazy PromiseLike + abortSignal contract, backed only by local psql.
function request(operation: (signal?: AbortSignal) => Promise<unknown>) {
  let signal: AbortSignal | undefined;
  const execute = async (): Promise<Result> => {
    try { return { data: await operation(signal), error: null }; }
    catch (error) {
      // Surface the actual local SQL/abort error, not just the production
      // heartbeat wrapper's fixed migration instruction.
      process.stderr.write(`Fixture database request failed: ${String(error)}\n`);
      return { data: null, error: { message: String(error) } };
    }
  };
  return {
    abortSignal(value: AbortSignal) { signal = value; return this; },
    then<T = Result, U = never>(
      resolve?: ((value: Result) => T | PromiseLike<T>) | null,
      reject?: ((reason: unknown) => U | PromiseLike<U>) | null,
    ) { return execute().then(resolve, reject); },
  };
}

function initialFailure(kind: string) {
  if (process.env.FIXTURE_STARTUP_FAULT === kind) {
    process.send?.({ type: "startup-fault", kind, pid: process.pid });
    throw new Error(`Injected initial ${kind} failure`);
  }
}
async function failure(kind: string, signal?: AbortSignal) {
  const mode = await sql(`SELECT mode FROM fixture_faults WHERE pid=${process.pid} AND kind=${literal(kind)}`, signal);
  if (mode === "error") throw new Error(`Injected ${kind} failure`);
  if (mode === "false") return false;
  if (mode === "hang") {
    // A real blocked database request, canceled through the production timeout.
    await sql("SELECT pg_sleep(20)", signal);
  }
  return true;
}

export const supabase = {
  rpc(name: string, args: Record<string, unknown>) {
    return request(async signal => {
      if (name === "operator_acquire_job_lock" && args.p_name === "background-worker") {
        initialFailure("acquire");
      }
      if (name === "operator_renew_job_lock" && args.p_name === "background-worker") {
        if (!await failure("renew", signal)) return false;
      }
      const signatures: Record<string, string[]> = {
        operator_acquire_job_lock: ["p_name", "p_owner", "p_ttl_seconds"],
        operator_renew_job_lock: ["p_name", "p_owner", "p_ttl_seconds"],
        operator_release_job_lock: ["p_name", "p_owner"],
        operator_observe_alert: ["p_key", "p_active", "p_text", "p_holder"],
      };
      const fields = signatures[name];
      if (!fields) throw new Error(`Unexpected fixture RPC: ${name}`);
      const values = fields.map(key => args[key] == null ? "NULL" :
        literal(typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key]));
      const value = await sql(`SELECT ${name}(${values.join(",")})`, signal);
      return value === "t" ? true : value === "f" ? false : value ? JSON.parse(value) : null;
    });
  },
  from(table: string) {
    // Application template seeding is unrelated to lifecycle verification.
    if (table === "clubs") return {
      select(columns: string) {
        if (columns !== "id") throw new Error("Unexpected fixture club selector");
        return request(async () => []);
      },
    };
    if (table === "operator_worker_instances") return {
      upsert(row: Record<string, unknown>) {
        return request(async signal => {
          initialFailure(`initial-registry-${row.state}`);
          if (row.state === "leader") await failure("registry", signal);
          const keys = Object.keys(row);
          await sql(`INSERT INTO operator_worker_instances(${keys.join(",")})
            VALUES(${keys.map(key => literal(row[key])).join(",")})
            ON CONFLICT(instance_id) DO UPDATE SET
            ${keys.filter(key => key !== "instance_id").map(key => `${key}=EXCLUDED.${key}`).join(",")}`, signal);
          return null;
        });
      },
    };
    if (table === "operator_worker_runs") return {
      insert(row: Record<string, unknown>) {
        return request(async signal => {
          await sql(`INSERT INTO operator_worker_runs(id,job,holder,started_at,status)
            VALUES(${literal(row.id)},${literal(row.job)},${literal(JSON.stringify(row.holder))},
            ${literal(row.started_at)},${literal(row.status)})`, signal);
          return null;
        });
      },
      update(row: Record<string, unknown>) {
        return { eq(key: string, value: unknown) {
          if (key !== "id") throw new Error("Unexpected run selector");
          return request(async signal => {
            await sql(`UPDATE operator_worker_runs SET status=${literal(row.status)},
              finished_at=${literal(row.finished_at)} WHERE id=${literal(value)}`, signal);
            return null;
          });
        } };
      },
    };
    throw new Error(`Unexpected fixture table: ${table}`);
  },
};

// No production logger (or transport) is imported into a synthetic worker.
const log = (level: string, _details: unknown, message: string) =>
  process.send?.({ type: "log", level, message, pid: process.pid });
export const logger = {
  info: (details: unknown, message: string) => log("info", details, message),
  warn: (details: unknown, message: string) => log("warn", details, message),
  error: (details: unknown, message: string) => log("error", details, message),
  fatal: (details: unknown, message: string) => log("fatal", details, message),
};
