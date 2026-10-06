import { spawnSync } from "node:child_process";
const env = { ...process.env, PORT: "23183", BASE_PATH: "/dashboard/", NODE_ENV: "production" };
for (const args of [
  ["--filter", "@workspace/dashboard", "run", "build"],
  ["--filter", "@workspace/api-server", "run", "build"],
]) {
  const result = spawnSync("pnpm", args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
