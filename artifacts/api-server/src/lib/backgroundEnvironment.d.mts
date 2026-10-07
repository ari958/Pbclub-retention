type BackgroundEnvironment = {
  NODE_ENV?: string;
  RUN_BACKGROUND_JOBS?: string;
  ALERT_OPERATOR_TO?: string;
};

export function backgroundJobsEnabledForEnvironment(
  env: BackgroundEnvironment, enabledInTests?: boolean,
): boolean;
export function productionWorkerConfigurationErrors(env: BackgroundEnvironment): string[];
