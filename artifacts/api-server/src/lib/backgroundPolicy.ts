import { backgroundJobsEnabledForEnvironment } from "./backgroundEnvironment.mjs";

let enabledInTests = false;
let leader = false;
export function setBackgroundWorkerLeader(value: boolean) { leader = value; }
export function setBackgroundJobsEnabledForTests(enabled: boolean) {
  if (process.env.NODE_ENV !== "test") throw new Error("Background worker test policy is test-only");
  enabledInTests = enabled;
}
export const backgroundJobsConfigured = () => backgroundJobsEnabledForEnvironment(process.env, enabledInTests);
export const backgroundJobsEnabled = () => backgroundJobsConfigured()
  && (process.env.NODE_ENV === "test" || leader);
