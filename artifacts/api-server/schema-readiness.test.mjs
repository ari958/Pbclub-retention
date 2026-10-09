import assert from "node:assert/strict";
import test from "node:test";
import { checkSchemaReadiness, databaseConfigurationErrors, schemaRequirements, leaseRequirements } from "./schema-readiness.mjs";
import { runProductionBuild } from "./production-build.mjs";

const env = () => ({ SUPABASE_URL: "https://offline-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "offline-service-key", OPERATOR_PASSWORD: "offline-long-password",
  PUBLIC_API_URL: "https://offline.example.com" });
function metadata() {
  const paths = {};
  for (const { table, methods } of schemaRequirements) paths[`/${table}`] = Object.fromEntries(methods.map(method => [method, {}]));
  for (const { name, args } of leaseRequirements) paths[`/rpc/${name}`] = { post: {
    parameters: [{ in: "body", schema: { properties: Object.fromEntries(args.map(arg => [arg, { type: "string" }])) } }],
  } };
  return { swagger: "2.0", paths };
}
function transport({ doc = metadata(), statusFor = () => 200 } = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const status = statusFor(url);
    return new Response(options.method === "HEAD" ? null : JSON.stringify(doc), { status });
  } };
}

test("external production configuration required; no managed/dev DB fallback or unsafe origins", async () => {
  for (const url of [undefined, "", "http://offline-project.supabase.co", "https://localhost",
    "https://project.example.dev", "postgres://private:credential@db", "https://offline-project.supabase.co/rest/v1",
    "https://private:credential@offline-project.supabase.co", "https://offline-project.supabase.co?token=secret",
    "https://offline-project.supabase.co#secret", "https://offline-project.supabase.co:443",
    "https://offline-project.supabase.co\\", " https://offline-project.supabase.co"]) {
    const report = await checkSchemaReadiness({ env: { ...env(), SUPABASE_URL: url, DATABASE_URL: "never-use" },
      fetchImpl: () => assert.fail("No network on invalid configuration") });
    assert.equal(report.configuration, "failed");
    assert.equal(report.connectivity, "not checked");
    assert.equal(report.schema, "not checked");
    assert.ok(!JSON.stringify(report).includes("credential"));
  }
  for (const key of [undefined, "", " ", "secret\nvalue"]) {
    assert.ok(databaseConfigurationErrors({ ...env(), SUPABASE_SERVICE_ROLE_KEY: key }).length);
  }
});

test("bounded metadata + zero-row HEAD probes only; no writes, RPCs, app imports, or row fetches", async () => {
  const fixture = transport();
  const supplied = env();
  const before = { ...supplied };
  const result = await checkSchemaReadiness({ env: supplied, ...fixture });
  assert.equal(result.configuration, "passed");
  assert.equal(result.connectivity, "passed");
  assert.equal(result.schema, "passed");
  assert.deepEqual(result.errors, []);
  assert.equal(fixture.calls.length, 1 + schemaRequirements.length);
  for (const { url, options } of fixture.calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.apikey, supplied.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(options.headers["Accept-Profile"], "public");
    assert.ok(options.signal);
    if (options.method === "GET") assert.equal(new URL(url).pathname, "/rest/v1/");
    else {
      assert.equal(options.method, "HEAD");
      assert.equal(new URL(url).searchParams.get("limit"), "0");
      assert.ok(new URL(url).searchParams.get("select"));
    }
    assert.ok(!url.includes("/rpc/"));
  }
  assert.deepEqual(supplied, before);
  assert.ok(!JSON.stringify(result).includes(supplied.SUPABASE_SERVICE_ROLE_KEY));
  assert.ok(!JSON.stringify(result).includes(supplied.SUPABASE_URL));
});

test("missing template club_id fails even on empty tables; connectivity is not schema readiness", async () => {
  const fixture = transport({ statusFor: url => url.includes("message_templates?") ? 400 : 200 });
  const result = await checkSchemaReadiness({ env: env(), ...fixture });
  assert.equal(result.connectivity, "passed");
  assert.equal(result.schema, "failed");
  assert.match(result.errors.join("\n"), /message_templates.*club_id/);
  assert.equal(fixture.calls.length, 1 + schemaRequirements.length); // Keep reporting other checks after failure.
  assert.equal(await runProductionBuild({ env: env(), schemaCheck: () => Promise.resolve(result),
    info: () => {}, error: () => {}, spawn: () => assert.fail("No compilation after missing column") }), 1);
});

test("each scoped table requires every declared column, including job heartbeat and update timestamps", async () => {
  for (const { table, columns } of schemaRequirements) {
    for (const column of columns) {
      const fixture = transport({ statusFor: url => {
        const parsed = new URL(url);
        return parsed.pathname === `/rest/v1/${table}` && parsed.searchParams.get("select")?.split(",").includes(column) ? 400 : 200;
      } });
      const result = await checkSchemaReadiness({ env: env(), ...fixture });
      assert.equal(result.schema, "failed");
      assert.ok(result.errors.some(error => error.includes(table) && error.includes(column)));
    }
  }
});

test("missing table/read permission and missing advertised writes/RPC signatures fail closed", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const result = await checkSchemaReadiness({ env: env(),
      ...transport({ statusFor: url => url.includes("operator_runtime?") ? status : 200 }) });
    assert.equal(result.schema, "failed");
    assert.match(result.errors.join("\n"), /operator_runtime/);
  }
  for (const mutate of [
    doc => delete doc.paths["/message_templates"].post,
    doc => delete doc.paths["/operator_runtime"].patch,
    doc => delete doc.paths["/rpc/operator_renew_job_lock"],
    doc => delete doc.paths["/rpc/operator_acquire_job_lock"].post.parameters[0].schema.properties.p_owner,
  ]) {
    const doc = metadata();
    mutate(doc);
    assert.equal((await checkSchemaReadiness({ env: env(), ...transport({ doc }) })).schema, "failed");
  }
});

test("metadata RPC definition references are checked without execution", async () => {
  const doc = metadata();
  doc.definitions = {};
  for (const { name } of leaseRequirements) {
    doc.definitions[name] = doc.paths[`/rpc/${name}`].post.parameters[0].schema;
    doc.paths[`/rpc/${name}`].post.parameters[0].schema = { $ref: `#/definitions/${name}` };
  }
  assert.equal((await checkSchemaReadiness({ env: env(), ...transport({ doc }) })).schema, "passed");
});

test("authentication failure, malformed/oversized metadata and raw errors produce sanitized failures", async () => {
  for (const fetchImpl of [
    async () => new Response("private-provider-detail", { status: 401 }),
    async () => new Response("private-invalid-json"),
    async () => new Response(JSON.stringify({ paths: {}, private: "x".repeat(2048) })),
    async () => { throw new Error("private-provider-detail offline-service-key"); },
  ]) {
    const result = await checkSchemaReadiness({ env: env(), fetchImpl, maxMetadataBytes: 100 });
    assert.equal(result.schema, "failed");
    assert.ok(!JSON.stringify(result).includes("private-provider-detail"));
    assert.ok(!JSON.stringify(result).includes("offline-service-key"));
  }
});

test("request and total deadlines bound hanging transport and body reads", async () => {
  const keepAlive = setInterval(() => {}, 100);
  try {
    for (const fetchImpl of [
      () => new Promise(() => {}),
      async () => new Response(new ReadableStream({ start() {} })),
    ]) {
      const start = Date.now();
      const result = await checkSchemaReadiness({ env: env(), fetchImpl, requestTimeoutMs: 20, totalTimeoutMs: 80 });
      assert.equal(result.schema, "failed");
      assert.ok(Date.now() - start < 1000);
    }
    const fixture = transport();
    let count = 0;
    const result = await checkSchemaReadiness({ env: env(), requestTimeoutMs: 100, totalTimeoutMs: 35,
      fetchImpl: async (...args) => {
        count++;
        if (count === 1) return fixture.fetchImpl(...args);
        return new Promise(() => {});
      } });
    assert.equal(result.schema, "failed");
    assert.match(result.errors.join("\n"), /total time budget exhausted/);
    assert.equal(count, 2);
  } finally {
    clearInterval(keepAlive);
  }
});
