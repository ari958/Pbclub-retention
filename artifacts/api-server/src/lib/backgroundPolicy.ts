import { backgroundJobsEnabledForEnvironment } from "./backgroundEnvironment.mjs";

let enabledInTests = false;
export function setBackgroundJobsEnabledForTests(enabled: boolean) {
  if (process.env.NODE_ENV !== "test") throw new Error("Background worker test policy is test-only");
  enabledInTests = enabled;
}
export const backgroundJobsEnabled = () => backgroundJobsEnabledForEnvironment(process.env, enabledInTests);
