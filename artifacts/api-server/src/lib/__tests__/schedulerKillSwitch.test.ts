import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundJobsEnabledForEnvironment,
  liveSmsAllowedForEnvironment,
  nonProductionLiveSmsError,
  productionWorkerConfigurationErrors,
  schedulerDesignatedForEnvironment,
} from "../backgroundEnvironment.mjs";

const live = { NODE_ENV: "production", RUN_BACKGROUND_JOBS: "true", SMS_LIVE: "true", SCHEDULER_ENABLED: "true" };

test("SCHEDULER_ENABLED defaults off: production config alone starts nothing and sends nothing", () => {
  // Exactly what artifact.toml + .replit [userenv.production] give every deployment.
  const inherited = { NODE_ENV: "production", RUN_BACKGROUND_JOBS: "true", SMS_LIVE: "true" };
  assert.equal(schedulerDesignatedForEnvironment(inherited), false);
  assert.equal(backgroundJobsEnabledForEnvironment(inherited), false);
  assert.equal(liveSmsAllowedForEnvironment(inherited), false);
  for (const value of ["false", "1", "TRUE", "yes", " true", ""]) {
    const env = { ...live, SCHEDULER_ENABLED: value };
    assert.equal(backgroundJobsEnabledForEnvironment(env), false, `SCHEDULER_ENABLED=${JSON.stringify(value)}`);
    assert.equal(liveSmsAllowedForEnvironment(env), false, `SCHEDULER_ENABLED=${JSON.stringify(value)}`);
  }
});

test("the designated production instance runs jobs and sends live", () => {
  assert.equal(schedulerDesignatedForEnvironment(live), true);
  assert.equal(backgroundJobsEnabledForEnvironment(live), true);
  assert.equal(liveSmsAllowedForEnvironment(live), true);
  // Each remaining switch still turns its own feature off.
  assert.equal(backgroundJobsEnabledForEnvironment({ ...live, RUN_BACKGROUND_JOBS: "false" }), false);
  assert.equal(liveSmsAllowedForEnvironment({ ...live, SMS_LIVE: "false" }), false);
});

test("SCHEDULER_ENABLED never enables anything outside production", () => {
  for (const NODE_ENV of [undefined, "development", "staging"]) {
    const env = { ...live, NODE_ENV };
    assert.equal(schedulerDesignatedForEnvironment(env), false);
    assert.equal(backgroundJobsEnabledForEnvironment(env), false);
    assert.equal(liveSmsAllowedForEnvironment(env), false);
  }
});

test("boot refuses SMS_LIVE=true on any non-production instance", () => {
  for (const NODE_ENV of [undefined, "development", "test", "staging"]) {
    assert.match(nonProductionLiveSmsError({ NODE_ENV, SMS_LIVE: "true" }) ?? "", /refusing to start/);
  }
  assert.equal(nonProductionLiveSmsError({ NODE_ENV: "development", SMS_LIVE: "false" }), null);
  assert.equal(nonProductionLiveSmsError({ NODE_ENV: "development" }), null);
  // Production boots without the secret (fail-safe: idle, not crashed).
  assert.equal(nonProductionLiveSmsError({ NODE_ENV: "production", SMS_LIVE: "true" }), null);
});

test("offline suites keep the explicit test-only exemptions", () => {
  assert.equal(backgroundJobsEnabledForEnvironment({ NODE_ENV: "test", RUN_BACKGROUND_JOBS: "true" }, true), true);
  assert.equal(backgroundJobsEnabledForEnvironment({ NODE_ENV: "test", RUN_BACKGROUND_JOBS: "true" }, false), false);
  assert.equal(liveSmsAllowedForEnvironment({ NODE_ENV: "test", SMS_LIVE: "true" }), true);
});

test("production worker config is still validated when the kill switch is off", () => {
  const errors = productionWorkerConfigurationErrors({ NODE_ENV: "production", RUN_BACKGROUND_JOBS: "true" });
  assert.ok(errors.some((error) => error.includes("ALERT_OPERATOR_TO")));
});
