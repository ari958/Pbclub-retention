import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Deliberately use only the calling build process's environment. Publishing
// supplies production values; do not load .env files or substitute dev secrets.
// This is configuration validation only: no app imports, database calls, or
// runtime initialization (servers, seeds, workers, or messaging).
export function validateProductionEnvironment(env) {
  const errors = [];
  if (typeof env.OPERATOR_PASSWORD !== "string" || env.OPERATOR_PASSWORD.length < 16) {
    errors.push("OPERATOR_PASSWORD must be configured with at least 16 characters.");
  }

  let validOrigin = false;
  const value = env.PUBLIC_API_URL;
  if (typeof value === "string" && /^https:\/\/[^/]/.test(value) && !/\s/.test(value) && !value.includes("\\")) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/\.+$/, "");
      validOrigin = url.protocol === "https:"
        && !!host
        && !url.username && !url.password
        && url.pathname === "/"
        && !value.includes("?") && !value.includes("#")
        && host !== "replit.dev" && !host.endsWith(".replit.dev")
        && host !== "localhost" && !host.endsWith(".localhost")
        && !host.startsWith("127.") && host !== "[::1]" && host !== "0.0.0.0";
    } catch {
      // URL parser errors can contain the input. Never print them.
    }
  }
  if (!validOrigin) {
    errors.push("PUBLIC_API_URL must be a published HTTPS origin (optional trailing slash), not a workspace or loopback URL, and must not contain credentials, a path, query, or fragment.");
  }
  return errors;
}

export function runProductionBuild({
  env = process.env,
  spawn = spawnSync,
  cwd = process.cwd(),
  info = message => console.info(message),
  error = message => console.error(message),
} = {}) {
  const errors = validateProductionEnvironment(env);
  if (errors.length) {
    error(`Production configuration preflight failed:\n${errors.map(message => `- ${message}`).join("\n")}`);
    return 1;
  }
  info("Production configuration preflight passed for this build process. Database connectivity and schema were not checked.");

  const buildEnv = { ...env, PORT: "23183", BASE_PATH: "/dashboard/", NODE_ENV: "production" };
  for (const args of [
    ["--filter", "@workspace/dashboard", "run", "build"],
    ["--filter", "@workspace/api-server", "run", "build"],
  ]) {
    let result;
    try {
      result = spawn("pnpm", args, { cwd, env: buildEnv, stdio: "inherit" });
    } catch {
      error("Production compilation command could not be started.");
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runProductionBuild();
}
