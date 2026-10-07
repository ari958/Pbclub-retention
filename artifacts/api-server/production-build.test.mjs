import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runProductionBuild, validateProductionEnvironment } from "./production-build.mjs";

// Explicit fixtures only: never inherit real development/production credentials.
const valid = () => ({
  OPERATOR_PASSWORD: "offline-production-password",
  PUBLIC_API_URL: "https://production.example.com",
});

test("password is required and must meet the production runtime's 16-character minimum", () => {
  for (const password of [undefined, "", "123456789012345", 123]) {
    assert.deepEqual(validateProductionEnvironment({ ...valid(), OPERATOR_PASSWORD: password }), [
      "OPERATOR_PASSWORD must be configured with at least 16 characters.",
    ]);
  }
  assert.deepEqual(validateProductionEnvironment({ ...valid(), OPERATOR_PASSWORD: "1234567890123456" }), []);
});

test("published and custom HTTPS origins, with optional trailing slash, are valid", () => {
  for (const url of [
    "https://fixture.replit.app",
    "https://fixture.replit.app/",
    "https://production.example.com",
    "https://production.example.com/",
  ]) assert.deepEqual(validateProductionEnvironment({ ...valid(), PUBLIC_API_URL: url }), []);
});

test("invalid, development, non-origin, and credential-bearing URLs fail safely", () => {
  for (const url of [
    undefined, "", "not-a-url", "https://", "http://production.example.com",
    "https:////production.example.com", "https://replit.dev", "https://fixture.replit.dev",
    "https://fixture.replit.dev./", "https://replit.dev./", "https://localhost./", "https://./",
    "https://production.example.com\\", "https://\\production.example.com",
    "https://FIXTURE.REPLIT.DEV/", "https://localhost", "https://fixture.localhost",
    "https://127.0.0.1", "https://[::1]", "https://0.0.0.0",
    "https://user:private-url-password@production.example.com",
    "https://production.example.com/api", "https://production.example.com?private=query",
    "https://production.example.com#private", "https://production.example.com?",
    "https://production.example.com#", " https://production.example.com",
    "https://production.example.com\n", "https://production.exa\nmple.com",
  ]) {
    const errors = validateProductionEnvironment({ ...valid(), PUBLIC_API_URL: url });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^PUBLIC_API_URL must/);
    if (url) assert.ok(!errors.join("\n").includes(url));
  }
});

test("all configuration errors appear before any compilation, with no secret values", () => {
  const output = [];
  let calls = 0;
  const status = runProductionBuild({
    env: { OPERATOR_PASSWORD: "private-short", PUBLIC_API_URL: "https://private:token@bad-url" },
    spawn: () => { calls++; throw new Error("Must not compile"); },
    info: message => output.push(message),
    error: message => output.push(message),
  });
  assert.equal(status, 1);
  assert.equal(calls, 0);
  assert.match(output.join("\n"), /OPERATOR_PASSWORD/);
  assert.match(output.join("\n"), /PUBLIC_API_URL/);
  assert.doesNotMatch(output.join("\n"), /private-short|private:token|bad-url/);
});

test("valid configuration passes the supplied publishing values unchanged to both compilers", () => {
  const env = { ...valid(), NODE_ENV: "development", SUPABASE_SERVICE_ROLE_KEY: "offline-database-secret" };
  const original = { ...env };
  const calls = [];
  const output = [];
  assert.equal(runProductionBuild({
    env, cwd: "/offline-workspace",
    spawn: (...args) => { calls.push(args); return { status: 0 }; },
    info: message => output.push(message), error: message => output.push(message),
  }), 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [
    ["pnpm", ["--filter", "@workspace/dashboard", "run", "build"]],
    ["pnpm", ["--filter", "@workspace/api-server", "run", "build"]],
  ]);
  for (const [, , options] of calls) {
    assert.equal(options.env.OPERATOR_PASSWORD, env.OPERATOR_PASSWORD);
    assert.equal(options.env.PUBLIC_API_URL, env.PUBLIC_API_URL);
    assert.equal(options.env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(options.env.NODE_ENV, "production");
    assert.equal(options.env.BASE_PATH, "/dashboard/");
    assert.equal(options.env.PORT, "23183");
    assert.equal(options.cwd, "/offline-workspace");
  }
  assert.deepEqual(env, original);
  assert.match(output.join("\n"), /Database connectivity and schema were not checked/);
  for (const secret of [env.OPERATOR_PASSWORD, env.SUPABASE_SERVICE_ROLE_KEY]) {
    assert.ok(!output.join("\n").includes(secret));
  }
});

test("compilation failure stops the chain, including failure to spawn", () => {
  for (const status of [7, null]) {
    let calls = 0;
    assert.equal(runProductionBuild({
      env: valid(), info: () => {}, error: () => {},
      spawn: () => { calls++; return { status }; },
    }), status ?? 1);
    assert.equal(calls, 1);
  }
  const output = [];
  assert.equal(runProductionBuild({
    env: valid(), info: () => {}, error: message => output.push(message),
    spawn: () => { throw new Error("private-compiler-detail"); },
  }), 1);
  assert.doesNotMatch(output.join("\n"), /private-compiler-detail/);
});

test("actual CLI rejects missing publishing settings before pnpm can run", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./production-build.mjs", import.meta.url))], {
    env: {}, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /OPERATOR_PASSWORD/);
  assert.match(result.stderr, /PUBLIC_API_URL/);
  assert.doesNotMatch(result.stderr, /ENOENT|pnpm|SUPABASE/);
});
