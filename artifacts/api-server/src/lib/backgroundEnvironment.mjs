// Pure configuration policy shared by runtime and the offline publishing gate.
// Importing this module must never initialize workers or external clients.
export function backgroundJobsEnabledForEnvironment(env, enabledInTests = false) {
  return env.RUN_BACKGROUND_JOBS === "true"
    && (env.NODE_ENV === "production" || (env.NODE_ENV === "test" && enabledInTests));
}

export function productionWorkerConfigurationErrors(env) {
  return env.NODE_ENV === "production"
    && backgroundJobsEnabledForEnvironment(env)
    && !env.ALERT_OPERATOR_TO
    ? ["Production background jobs require ALERT_OPERATOR_TO"]
    : [];
}
