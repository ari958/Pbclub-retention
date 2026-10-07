type BackgroundEnvironment = {
  NODE_ENV?: string;
  RUN_BACKGROUND_JOBS?: string;
  ALERT_OPERATOR_TO?: string;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
};

export function backgroundJobsEnabledForEnvironment(
  env: BackgroundEnvironment, enabledInTests?: boolean,
): boolean;
export function productionWorkerConfigurationErrors(env: BackgroundEnvironment): string[];
