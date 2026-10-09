// Pure configuration policy shared by runtime and the offline publishing gate.
// Importing this module must never initialize workers or external clients.
// Hard kill switch. SCHEDULER_ENABLED is set ONLY as a secret on the one live
// deployment, never in any committed config, so a fork, staging copy or second
// deployment that copies RUN_BACKGROUND_JOBS=true still stays off. Default: off.
export function schedulerDesignatedForEnvironment(env) {
  return env.NODE_ENV === "production" && env.SCHEDULER_ENABLED === "true";
}

// What the deployment config asks for, before the kill switch is applied.
function backgroundJobsRequested(env, enabledInTests) {
  return env.RUN_BACKGROUND_JOBS === "true"
    && (env.NODE_ENV === "production" || (env.NODE_ENV === "test" && enabledInTests));
}

export function backgroundJobsEnabledForEnvironment(env, enabledInTests = false) {
  return backgroundJobsRequested(env, enabledInTests)
    && (env.NODE_ENV !== "production" || schedulerDesignatedForEnvironment(env));
}

// Live SMS needs SMS_LIVE=true AND the production kill switch. NODE_ENV=test is
// exempt so offline suites can exercise the send path with injected transports;
// a real server can never run that way (see nonProductionLiveSmsError).
export function liveSmsAllowedForEnvironment(env) {
  return env.SMS_LIVE === "true"
    && (env.NODE_ENV === "test" || schedulerDesignatedForEnvironment(env));
}

// Boot refusal: SMS_LIVE=true is only ever valid on a production instance.
export function nonProductionLiveSmsError(env) {
  if (env.SMS_LIVE !== "true" || env.NODE_ENV === "production") return null;
  return `SMS_LIVE=true is only allowed when NODE_ENV=production (got ${env.NODE_ENV ?? "unset"}); refusing to start`;
}

export function productionWorkerConfigurationErrors(env) {
  // Validate whenever production asks for workers, designated or not, so a
  // misconfigured deployment fails at build instead of silently idling.
  if (env.NODE_ENV !== "production" || !backgroundJobsRequested(env, false)) return [];

  const errors = [];
  const destination = env.ALERT_OPERATOR_TO;
  if (typeof destination !== "string" || !destination.trim()) {
    errors.push("Production background jobs require ALERT_OPERATOR_TO");
  } else if (!/^\+[1-9]\d{7,14}$/.test(destination) || destination.trim() !== destination) {
    // Match the operator alert's E.164 bounds; reject surrounding whitespace
    // rather than silently changing a configured recipient.
    errors.push("Production background jobs require ALERT_OPERATOR_TO in E.164 format (+ followed by 8 to 15 digits)");
  }
  for (const key of ["TWILIO_PHONE_NUMBER", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) {
    if (typeof env[key] !== "string" || !env[key].trim()) {
      errors.push(`Production background jobs require ${key} for operator alerts`);
    }
  }
  // Only setting names and fixed instructions: never include supplied values.
  return errors;
}
