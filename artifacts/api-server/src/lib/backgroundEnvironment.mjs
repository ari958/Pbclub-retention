// Pure configuration policy shared by runtime and the offline publishing gate.
// Importing this module must never initialize workers or external clients.
export function backgroundJobsEnabledForEnvironment(env, enabledInTests = false) {
  return env.RUN_BACKGROUND_JOBS === "true"
    && (env.NODE_ENV === "production" || (env.NODE_ENV === "test" && enabledInTests));
}

export function productionWorkerConfigurationErrors(env) {
  if (env.NODE_ENV !== "production" || !backgroundJobsEnabledForEnvironment(env)) return [];

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
