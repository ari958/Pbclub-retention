import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runProductionBuild, validateProductionEnvironment } from "./production-build.mjs";
import { backgroundJobsEnabledForEnvironment, productionWorkerConfigurationErrors } from "./src/lib/backgroundEnvironment.mjs";
import { backgroundJobsEnabled, backgroundJobsConfigured, setBackgroundWorkerLeader, setBackgroundJobsEnabledForTests } from "./src/lib/backgroundPolicy.ts";

// Explicit fixtures only: never inherit real development/production credentials.
const valid = () => ({
  OPERATOR_PASSWORD: "offline-production-password",
  PUBLIC_API_URL: "https://production.example.com",
});
const alertTransport = () => ({
  TWILIO_PHONE_NUMBER: "+12025550124",
  TWILIO_ACCOUNT_SID: "offline-account-sid",
  TWILIO_AUTH_TOKEN: "offline-auth-token",
});
const ready = async () => ({ configuration: "passed", connectivity: "passed", schema: "passed",
  errors: [], target: "offline fixture", coverage: "offline fixture", limitations: "Offline only." });

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
    "https://fixture.up.railway.app",
    "https://fixture.up.railway.app/",
    "https://production.example.com",
    "https://production.example.com/",
  ]) assert.deepEqual(validateProductionEnvironment({ ...valid(), PUBLIC_API_URL: url }), []);
});

test("publishing requires an alert destination only for exact true worker opt-in", () => {
  for (const flag of [undefined, "", "false", "TRUE", "True", "1", " true", "true ", "true"]) {
    for (const destination of [undefined, "", "+12025550123"]) {
      for (const nodeEnv of [undefined, "development", "test", "production"]) {
        const env = { ...valid(), ...alertTransport(), NODE_ENV: nodeEnv, RUN_BACKGROUND_JOBS: flag, ALERT_OPERATOR_TO: destination };
        const expected = flag === "true" && !destination
          ? ["Production background jobs require ALERT_OPERATOR_TO"] : [];
        assert.deepEqual(validateProductionEnvironment(env), expected);
        assert.deepEqual(productionWorkerConfigurationErrors({ ...env, NODE_ENV: "production" }), expected);
      }
    }
  }
});

test("runtime worker policy preserves environment gating and explicit test-only override", () => {
  const original = { NODE_ENV: process.env.NODE_ENV, RUN_BACKGROUND_JOBS: process.env.RUN_BACKGROUND_JOBS,
    SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED };
  try {
    for (const nodeEnv of [undefined, "development", "test", "production"]) {
      for (const flag of [undefined, "false", "TRUE", "1", "true"]) {
        for (const testOverride of [false, true]) {
         for (const scheduler of [undefined, "false", "true"]) {
          process.env.NODE_ENV = "test";
          setBackgroundJobsEnabledForTests(testOverride);
          if (nodeEnv === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = nodeEnv;
          if (flag === undefined) delete process.env.RUN_BACKGROUND_JOBS;
          else process.env.RUN_BACKGROUND_JOBS = flag;
          if (scheduler === undefined) delete process.env.SCHEDULER_ENABLED;
          else process.env.SCHEDULER_ENABLED = scheduler;
          const env = { ...alertTransport(), NODE_ENV: nodeEnv, RUN_BACKGROUND_JOBS: flag, SCHEDULER_ENABLED: scheduler };
          // Production additionally needs the SCHEDULER_ENABLED kill switch.
          const enabled = flag === "true"
            && ((nodeEnv === "production" && scheduler === "true") || (nodeEnv === "test" && testOverride));
          assert.equal(backgroundJobsEnabledForEnvironment(env, testOverride), enabled);
          assert.equal(backgroundJobsConfigured(), enabled);
          setBackgroundWorkerLeader(false);
          assert.equal(backgroundJobsEnabled(), nodeEnv === "test" && enabled);
          setBackgroundWorkerLeader(true);
          assert.equal(backgroundJobsEnabled(), enabled);
          assert.deepEqual(productionWorkerConfigurationErrors(env),
            nodeEnv === "production" && flag === "true"
              ? ["Production background jobs require ALERT_OPERATOR_TO"] : []);
         }
        }
      }
    }
    process.env.NODE_ENV = "development";
    assert.throws(() => setBackgroundJobsEnabledForTests(true), /test-only/);
  } finally {
    setBackgroundWorkerLeader(false);
    process.env.NODE_ENV = "test";
    setBackgroundJobsEnabledForTests(false);
    for (const key of ["NODE_ENV", "RUN_BACKGROUND_JOBS", "SCHEDULER_ENABLED"]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

test("worker alert configuration is identical for runtime and publishing with synthetic fixtures", () => {
  const worker = { ...valid(), ...alertTransport(), NODE_ENV: "production",
    RUN_BACKGROUND_JOBS: "true", ALERT_OPERATOR_TO: "+12025550123" };
  const check = (env, expected) => {
    const original = { ...env };
    assert.deepEqual(productionWorkerConfigurationErrors(env), expected);
    assert.deepEqual(validateProductionEnvironment(env), expected);
    assert.deepEqual(env, original);
  };
  for (const destination of ["+12345678", "+123456789012345", worker.ALERT_OPERATOR_TO]) {
    check({ ...worker, ALERT_OPERATOR_TO: destination }, []);
  }
  for (const destination of [undefined, "", " ", "\n\t", null, 123, {}]) {
    check({ ...worker, ALERT_OPERATOR_TO: destination }, ["Production background jobs require ALERT_OPERATOR_TO"]);
  }
  for (const destination of [
    "12025550123", "+012345678", "+1234567", "+1234567890123456",
    "+1 (202) 555-0123", "+1202555abcd", " +12025550123", "+12025550123 ",
    "+12025550123\n", "+12025550123\r\n", "+１２０２５５５０１２３", "private-destination",
  ]) {
    const env = { ...worker, ALERT_OPERATOR_TO: destination };
    check(env, ["Production background jobs require ALERT_OPERATOR_TO in E.164 format (+ followed by 8 to 15 digits)"]);
    assert.ok(!productionWorkerConfigurationErrors(env).join("\n").includes(destination));
  }
  for (const key of Object.keys(alertTransport())) {
    for (const missing of [undefined, "", " ", "\n\t", null, 123, {}]) {
      check({ ...worker, [key]: missing }, [`Production background jobs require ${key} for operator alerts`]);
    }
  }
  // Operator infrastructure alerts are not gated by player delivery controls.
  for (const SMS_LIVE of [undefined, "false", "true"]) {
    check({ ...worker, SMS_LIVE, SMS_TEST_OVERRIDE_TO: "+12025550125",
      TWILIO_AUTH_TOKEN: "" }, ["Production background jobs require TWILIO_AUTH_TOKEN for operator alerts"]);
  }
  const incomplete = { ...valid(), NODE_ENV: "production", RUN_BACKGROUND_JOBS: "true" };
  check(incomplete, [
    "Production background jobs require ALERT_OPERATOR_TO",
    ...Object.keys(alertTransport()).map(key => `Production background jobs require ${key} for operator alerts`),
  ]);
});

test("disabled production workers and non-production runtime need no alert settings", () => {
  for (const flag of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
    const env = { ...valid(), NODE_ENV: "production", RUN_BACKGROUND_JOBS: flag,
      ALERT_OPERATOR_TO: "private-invalid-destination" };
    assert.deepEqual(productionWorkerConfigurationErrors(env), []);
    assert.deepEqual(validateProductionEnvironment(env), []);
  }
  for (const NODE_ENV of [undefined, "development", "test"]) {
    const env = { NODE_ENV, RUN_BACKGROUND_JOBS: "true", ALERT_OPERATOR_TO: "private-invalid-destination" };
    assert.deepEqual(productionWorkerConfigurationErrors(env), []);
  }
});

test("invalid alerts stop publishing before database checks or compilation and sanitize all output", async () => {
  for (const changes of [
    { ALERT_OPERATOR_TO: "private-destination" },
    ...Object.keys(alertTransport()).map(key => ({ [key]: "" })),
    { ALERT_OPERATOR_TO: "", ...Object.fromEntries(Object.keys(alertTransport()).map(key => [key, ""])) },
  ]) {
    const env = { ...valid(), ...alertTransport(), NODE_ENV: "development",
      RUN_BACKGROUND_JOBS: "true", ALERT_OPERATOR_TO: "+12025550123", ...changes };
    const output = [];
    assert.equal(await runProductionBuild({
      env, schemaCheck: () => assert.fail("Must not access the database"),
      spawn: () => assert.fail("Must not compile"),
      info: text => output.push(text), error: text => output.push(text),
    }), 1);
    const expected = productionWorkerConfigurationErrors({ ...env, NODE_ENV: "production" });
    assert.deepEqual(output, [`Production configuration preflight failed:\n${expected.map(text => `- ${text}`).join("\n")}`]);
    for (const value of [env.OPERATOR_PASSWORD, env.ALERT_OPERATOR_TO, ...Object.values(alertTransport())]) {
      if (value) assert.ok(!output.join("\n").includes(value));
    }
  }
});

test("actual CLI rejects malformed destinations and absent transport before any external checks", () => {
  for (const changes of [
    { ALERT_OPERATOR_TO: "private-destination" },
    ...Object.keys(alertTransport()).map(key => ({ [key]: "" })),
  ]) {
    const env = { ...valid(), ...alertTransport(), NODE_ENV: "test",
      RUN_BACKGROUND_JOBS: "true", ALERT_OPERATOR_TO: "+12025550123", ...changes };
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./production-build.mjs", import.meta.url))], {
      env, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), `Production configuration preflight failed:\n${productionWorkerConfigurationErrors({ ...env, NODE_ENV: "production" }).map(text => `- ${text}`).join("\n")}`);
    assert.doesNotMatch(result.stderr, /private-destination|offline-auth-token|offline-account-sid|SUPABASE|pnpm/);
  }
});

test("invalid, development, non-origin, and credential-bearing URLs fail safely", () => {
  for (const url of [
    undefined, "", "not-a-url", "https://", "http://production.example.com",
    "https:////production.example.com", "ftp://production.example.com",
    "https://localhost./", "https://./",
    "https://production.example.com\\", "https://\\production.example.com",
    "https://localhost", "https://fixture.localhost",
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

test("all configuration errors appear before any compilation, with no secret values", async () => {
  const output = [];
  let calls = 0;
  const status = await runProductionBuild({
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

test("valid configuration passes the supplied publishing values unchanged to both compilers", async () => {
  const env = { ...valid(), NODE_ENV: "development", SUPABASE_SERVICE_ROLE_KEY: "offline-database-secret",
    ...alertTransport(), RUN_BACKGROUND_JOBS: "true", ALERT_OPERATOR_TO: "+12025550123" };
  const original = { ...env };
  const calls = [];
  const output = [];
  assert.equal(await runProductionBuild({
    env, cwd: "/offline-workspace",
    schemaCheck: async ({ env: supplied }) => { assert.equal(supplied, env); return ready(); },
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
    for (const key of Object.keys(alertTransport())) assert.equal(options.env[key], env[key]);
    assert.equal(options.env.NODE_ENV, "production");
    assert.equal(options.env.BASE_PATH, "/dashboard/");
    assert.equal(options.env.PORT, "23183");
    assert.equal(options.cwd, "/offline-workspace");
  }
  assert.deepEqual(env, original);
  assert.match(output.join("\n"), /configuration=passed; connectivity=passed; schema=passed/);
  for (const secret of [env.OPERATOR_PASSWORD, env.SUPABASE_SERVICE_ROLE_KEY, env.ALERT_OPERATOR_TO, ...Object.values(alertTransport())]) {
    assert.ok(!output.join("\n").includes(secret));
  }
});

test("compilation failure stops the chain, including failure to spawn", async () => {
  for (const status of [7, null]) {
    let calls = 0;
    assert.equal(await runProductionBuild({
      env: valid(), info: () => {}, error: () => {},
      schemaCheck: ready,
      spawn: () => { calls++; return { status }; },
    }), status ?? 1);
    assert.equal(calls, 1);
  }
  const output = [];
  assert.equal(await runProductionBuild({
    env: valid(), info: () => {}, error: message => output.push(message),
    schemaCheck: ready,
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

test("actual publishing CLI fails closed when external database settings are absent", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./production-build.mjs", import.meta.url))], {
    env: valid(), encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /configuration=failed; connectivity=not checked; schema=not checked/);
  assert.match(result.stderr, /SUPABASE_URL/);
  assert.match(result.stderr, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(result.stderr, /ENOENT|offline-production-password/);
});

test("actual CLI rejects missing worker alerts even from a development build shell", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./production-build.mjs", import.meta.url))], {
    env: { ...valid(), ...alertTransport(), NODE_ENV: "development", RUN_BACKGROUND_JOBS: "true" }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(),
    "Production configuration preflight failed:\n- Production background jobs require ALERT_OPERATOR_TO");
});

test("missing worker alert alone blocks both compilers without mutating the supplied environment", async () => {
  const env = { ...valid(), ...alertTransport(), RUN_BACKGROUND_JOBS: "true", ALERT_OPERATOR_TO: "" };
  const original = { ...env };
  const output = [];
  assert.equal(await runProductionBuild({
    env, info: message => output.push(message), error: message => output.push(message),
    schemaCheck: () => assert.fail("Database checks must not start"),
    spawn: () => { assert.fail("Compilation must not start"); },
  }), 1);
  assert.deepEqual(env, original);
  assert.deepEqual(output, [
    "Production configuration preflight failed:\n- Production background jobs require ALERT_OPERATOR_TO",
  ]);
});

test("database failure or exception prevents compilation without leaking exception text", async () => {
  for (const schemaCheck of [
    async () => ({ ...await ready(), schema: "failed", errors: ["Schema: message_templates columns inaccessible."] }),
    async () => { throw new Error("private-credential"); },
  ]) {
    const output = [];
    assert.equal(await runProductionBuild({ env: valid(), schemaCheck,
      spawn: () => assert.fail("No compilation"), info: text => output.push(text), error: text => output.push(text) }), 1);
    assert.doesNotMatch(output.join("\n"), /private-credential/);
  }
});
