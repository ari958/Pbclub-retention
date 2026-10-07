import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runProductionBuild, validateProductionEnvironment } from "./production-build.mjs";
import { backgroundJobsEnabledForEnvironment, productionWorkerConfigurationErrors } from "./src/lib/backgroundEnvironment.mjs";
import { backgroundJobsEnabled, setBackgroundJobsEnabledForTests } from "./src/lib/backgroundPolicy.ts";

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

test("publishing requires an alert destination only for exact true worker opt-in", () => {
  for (const flag of [undefined, "", "false", "TRUE", "True", "1", " true", "true ", "true"]) {
    for (const destination of [undefined, "", "+12025550123"]) {
      for (const nodeEnv of [undefined, "development", "test", "production"]) {
        const env = { ...valid(), NODE_ENV: nodeEnv, RUN_BACKGROUND_JOBS: flag, ALERT_OPERATOR_TO: destination };
        const expected = flag === "true" && !destination
          ? ["Production background jobs require ALERT_OPERATOR_TO"] : [];
        assert.deepEqual(validateProductionEnvironment(env), expected);
        assert.deepEqual(productionWorkerConfigurationErrors({ ...env, NODE_ENV: "production" }), expected);
      }
    }
  }
});

test("runtime worker policy preserves environment gating and explicit test-only override", () => {
  const original = { NODE_ENV: process.env.NODE_ENV, RUN_BACKGROUND_JOBS: process.env.RUN_BACKGROUND_JOBS };
  try {
    for (const nodeEnv of [undefined, "development", "test", "production"]) {
      for (const flag of [undefined, "false", "TRUE", "1", "true"]) {
        for (const testOverride of [false, true]) {
          process.env.NODE_ENV = "test";
          setBackgroundJobsEnabledForTests(testOverride);
          if (nodeEnv === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = nodeEnv;
          if (flag === undefined) delete process.env.RUN_BACKGROUND_JOBS;
          else process.env.RUN_BACKGROUND_JOBS = flag;
          const env = { NODE_ENV: nodeEnv, RUN_BACKGROUND_JOBS: flag };
          const enabled = flag === "true" && (nodeEnv === "production" || (nodeEnv === "test" && testOverride));
          assert.equal(backgroundJobsEnabledForEnvironment(env, testOverride), enabled);
          assert.equal(backgroundJobsEnabled(), enabled);
          assert.deepEqual(productionWorkerConfigurationErrors(env),
            nodeEnv === "production" && flag === "true"
              ? ["Production background jobs require ALERT_OPERATOR_TO"] : []);
        }
      }
    }
    process.env.NODE_ENV = "development";
    assert.throws(() => setBackgroundJobsEnabledForTests(true), /test-only/);
  } finally {
    process.env.NODE_ENV = "test";
    setBackgroundJobsEnabledForTests(false);
    for (const key of ["NODE_ENV", "RUN_BACKGROUND_JOBS"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
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
    env: { OPERATOR_PASSWORD: "private-short", PUBLIC_API_URL: "https://private:token@bad-url", RUN_BACKGROUND_JOBS: "true" },
    spawn: () => { calls++; throw new Error("Must not compile"); },
    info: message => output.push(message),
    error: message => output.push(message),
  });
  assert.equal(status, 1);
  assert.equal(calls, 0);
  assert.match(output.join("\n"), /OPERATOR_PASSWORD/);
  assert.match(output.join("\n"), /PUBLIC_API_URL/);
  assert.match(output.join("\n"), /ALERT_OPERATOR_TO/);
  assert.doesNotMatch(output.join("\n"), /private-short|private:token|bad-url/);
});

test("valid configuration passes the supplied publishing values unchanged to both compilers", () => {
  const env = { ...valid(), NODE_ENV: "development", SUPABASE_SERVICE_ROLE_KEY: "offline-database-secret",
    RUN_BACKGROUND_JOBS: "true", ALERT_OPERATOR_TO: "+12025550123" };
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
    assert.equal(options.env.RUN_BACKGROUND_JOBS, env.RUN_BACKGROUND_JOBS);
    assert.equal(options.env.ALERT_OPERATOR_TO, env.ALERT_OPERATOR_TO);
    assert.equal(options.env.NODE_ENV, "production");
    assert.equal(options.env.BASE_PATH, "/dashboard/");
    assert.equal(options.env.PORT, "23183");
    assert.equal(options.cwd, "/offline-workspace");
  }
  assert.deepEqual(env, original);
  assert.match(output.join("\n"), /Database connectivity and schema were not checked/);
  for (const secret of [env.OPERATOR_PASSWORD, env.SUPABASE_SERVICE_ROLE_KEY, env.ALERT_OPERATOR_TO]) {
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

test("actual CLI rejects missing worker alerts even from a development build shell", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./production-build.mjs", import.meta.url))], {
    env: { ...valid(), NODE_ENV: "development", RUN_BACKGROUND_JOBS: "true" }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(),
    "Production configuration preflight failed:\n- Production background jobs require ALERT_OPERATOR_TO");
});

test("missing worker alert alone blocks both compilers without mutating the supplied environment", () => {
  const env = { ...valid(), RUN_BACKGROUND_JOBS: "true", ALERT_OPERATOR_TO: "" };
  const original = { ...env };
  const output = [];
  assert.equal(runProductionBuild({
    env, info: message => output.push(message), error: message => output.push(message),
    spawn: () => { assert.fail("Compilation must not start"); },
  }), 1);
  assert.deepEqual(env, original);
  assert.deepEqual(output, [
    "Production configuration preflight failed:\n- Production background jobs require ALERT_OPERATOR_TO",
  ]);
});
