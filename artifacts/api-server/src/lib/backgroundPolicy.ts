let enabledInTests = false;
export function setBackgroundJobsEnabledForTests(enabled: boolean) {
  if (process.env.NODE_ENV !== "test") throw new Error("Background worker test policy is test-only");
  enabledInTests = enabled;
}
export const backgroundJobsEnabled = () => process.env.RUN_BACKGROUND_JOBS === "true"
  && (process.env.NODE_ENV === "production" || (process.env.NODE_ENV === "test" && enabledInTests));
