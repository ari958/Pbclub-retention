// Publishing-only. Never import the application or supabaseClient (runtime).
// This deliberately checks startup + worker infrastructure, not every app table.
export const schemaRequirements = Object.freeze([
  { table: "clubs", columns: ["id", "slug", "sms_kill_switch", "scheduled_sync_time", "timezone"], methods: ["get"] },
  { table: "message_templates", columns: ["id", "club_id", "name", "body", "use_case_tags", "is_builtin"], methods: ["get", "post"] },
  { table: "operator_job_locks", columns: ["name", "owner", "expires_at"], methods: ["get"] },
  { table: "operator_runtime", columns: ["name", "updated_at", "result"], methods: ["get", "post", "patch"] },
  { table: "jobs", columns: ["id", "status", "started_at", "finished_at", "stats", "error", "last_heartbeat", "updated_at"], methods: ["get", "patch"] },
  { table: "job_logs", columns: ["job_id", "logged_at", "level", "message"], methods: ["get", "post"] },
  { table: "operator_worker_instances", columns: ["instance_id","pid","host","started_at","environment","run_background_jobs","state","last_seen_at"], methods: ["get","post","patch"] },
  { table: "operator_worker_runs", columns: ["id","job","holder","started_at","finished_at","status"], methods: ["get","post","patch"] },
  { table: "operator_alert_incidents", columns: ["condition_key","incident_id","active","opened_at","closed_at","text"], methods: ["get"] },
  { table: "operator_alert_events", columns: ["id","incident_id","condition_key","phase","text","holder","claimed_at","sent_at","status","provider_sid","error"], methods: ["get","patch"] },
]);
export const leaseRequirements = Object.freeze([
  { name: "operator_acquire_job_lock", args: ["p_name", "p_owner", "p_ttl_seconds"] },
  { name: "operator_renew_job_lock", args: ["p_name", "p_owner", "p_ttl_seconds"] },
  { name: "operator_release_job_lock", args: ["p_name", "p_owner"] },
  { name: "operator_observe_alert", args: ["p_key","p_active","p_text","p_holder"] },
]);

export function databaseConfigurationErrors(env) {
  const errors = [];
  try {
    const value = env.SUPABASE_URL;
    const url = new URL(value);
    // External hosted Supabase only. No arbitrary URLs, embedded auth, query,
    // local/managed DB substitutions, .env loading, or guessed project fallback.
    if (typeof value !== "string" || value !== value.trim()
      || !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(value)
      || url.username || url.password || url.port) throw new Error();
  } catch {
    errors.push("SUPABASE_URL must be the intended external hosted Supabase HTTPS project origin.");
  }
  if (typeof env.SUPABASE_SERVICE_ROLE_KEY !== "string"
    || !env.SUPABASE_SERVICE_ROLE_KEY.trim()
    || /[\s\x00-\x1f\x7f]/.test(env.SUPABASE_SERVICE_ROLE_KEY)) {
    errors.push("SUPABASE_SERVICE_ROLE_KEY must be configured for the intended Supabase project.");
  }
  return errors;
}

// No response bodies, URLs, credentials, row values, or thrown errors in output.
function httpFailure(status) {
  if (status === 401 || status === 403) return "authentication or permission denied";
  if (status === 400 || status === 404) return "required schema is missing or inaccessible";
  if (status === 429) return "database API rate limited";
  return "database API request failed";
}

async function boundedJson(response, maxBytes) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function checkSchemaReadiness({
  env = process.env, fetchImpl = fetch,
  requestTimeoutMs = 3000, totalTimeoutMs = 20000, maxMetadataBytes = 2 * 1024 * 1024,
} = {}) {
  const errors = databaseConfigurationErrors(env);
  const report = { configuration: errors.length ? "failed" : "passed", connectivity: "not checked",
    schema: "not checked", errors, target: "external Supabase from publishing environment",
    coverage: "startup templates, club resolution, worker leases/registry, execution journals, alert incidents, telemetry, job state/logs",
    limitations: "Read access and API-advertised write/execute permissions only; no writes or RPC execution. Not a full application schema, RLS, constraints, seeds, or worker/provider readiness check." };
  if (errors.length) return report;

  const deadline = AbortSignal.timeout(totalTimeoutMs);
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Accept-Profile": "public" };
  const origin = env.SUPABASE_URL.replace(/\/$/, "");
  // race also bounds an uncooperative injected transport/body reader. Native
  // fetch receives the same abort signal, cancelling its network operations.
  async function request(path, method, accept, consume) {
    if (deadline.aborted) throw new Error();
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(requestTimeoutMs)]);
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new Error());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(`${origin}/rest/v1/${path}`, {
            method, headers: { ...headers, Accept: accept }, signal, redirect: "error",
          });
          return await consume(response);
        })(), cancelled,
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  let metadata;
  try {
    metadata = await request("", "GET", "application/openapi+json", async response => {
      if (!response.ok) {
        await response.body?.cancel();
        report.errors.push(`Connectivity: ${httpFailure(response.status)}.`);
        return null;
      }
      report.connectivity = "passed";
      return await boundedJson(response, maxMetadataBytes);
    });
  } catch {
    report.errors.push("Connectivity/metadata: request timed out, transport failed, or metadata was invalid/oversized.");
  }
  if (!metadata?.paths || typeof metadata.paths !== "object") {
    if (report.connectivity !== "passed") report.connectivity = "failed";
    report.schema = "failed";
    report.errors.push("Schema coverage: database API metadata unavailable; readiness cannot be established.");
    return report;
  }

  report.schema = "passed";
  for (const requirement of schemaRequirements) {
    const path = metadata.paths[`/${requirement.table}`];
    for (const method of requirement.methods) {
      if (!path?.[method]) report.errors.push(`Schema: ${requirement.table} does not advertise required ${method.toUpperCase()} access.`);
    }
    try {
      await request(`${requirement.table}?select=${requirement.columns.join(",")}&limit=0`,
        "HEAD", "application/json", async response => {
          if (!response.ok) report.errors.push(`Schema: ${requirement.table} [${requirement.columns.join(",")}]: ${httpFailure(response.status)}.`);
          await response.body?.cancel();
        });
    } catch {
      report.errors.push(`Schema: ${requirement.table} column/read probe timed out or failed.`);
    }
    if (deadline.aborted) {
      report.errors.push("Schema coverage: total time budget exhausted; remaining checks not run.");
      break;
    }
  }
  for (const requirement of leaseRequirements) {
    const operation = metadata.paths[`/rpc/${requirement.name}`]?.post;
    // PostgREST OpenAPI v2 describes RPC arguments in its body parameter.
    const body = operation?.parameters?.find(parameter => parameter.in === "body")?.schema;
    const schema = body?.$ref?.startsWith("#/definitions/")
      ? metadata.definitions?.[body.$ref.slice("#/definitions/".length)] : body;
    if (!operation || !requirement.args.every(arg => Object.hasOwn(schema?.properties ?? {}, arg))) {
      report.errors.push(`Schema: ${requirement.name} required executable signature is not advertised.`);
    }
  }
  if (report.errors.length) report.schema = "failed";
  return report;
}
