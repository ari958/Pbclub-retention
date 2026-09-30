import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectSource } from "./snapshot-source.js";

async function fixture(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "snapshot-source-"));
}

async function write(root: string, name: string, contents: string): Promise<void> {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

test("resolves nested mounts, router.route chains, path arrays, and dynamic paths", async () => {
  const root = await fixture();
  try {
    await write(root, "artifacts/demo/src/app.ts", `
      import express from "express";
      import router from "./routes";
      const app = express();
      app.use(["/api", "/v2"], router);
    `);
    await write(root, "artifacts/demo/src/routes/index.ts", `
      import { Router } from "express";
      import child from "./nested/child";
      const router = Router();
      router.use("/nested", child);
      export default router;
    `);
    await write(root, "artifacts/demo/src/routes/nested/child.ts", `
      import { Router } from "express";
      const router = Router();
      router.route(["/one", "/two"]).get(() => {}).post(() => {});
      router.get(/\\/regex/, () => {});
      router.get(process.env.ROUTE_PATH ?? "/private-route-default", () => {});
      export default router;
    `);

    const snapshot = await collectSource(root);
    assert.equal(snapshot.routes.filter((route) => route.method === "GET").length, 8);
    assert.equal(snapshot.routes.filter((route) => route.method === "POST").length, 4);
    assert(snapshot.routes.some((route) => route.path === "/api/nested/one"));
    assert(snapshot.routes.some((route) => route.path === "/v2/nested/two"));
    assert(snapshot.routes.some((route) => route.path.includes("<dynamic>")));
    assert(!JSON.stringify(snapshot).includes("private-route-default"));
    assert(snapshot.env.some((entry) => entry.name === "ROUTE_PATH"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collects configuration env names, required aliases, flags, and src text TODOs safely", async () => {
  const root = await fixture();
  try {
    await write(root, "vite.config.ts", `
      const rawPort = process.env.API_PORT;
      if (!rawPort) throw new Error("API_PORT is required");
      const supplied = process.env.NOT_REQUIRED;
      if (supplied) throw new Error("presence is rejected, not required");
      process.env.NON_NULL_KEY!;
      const optional = process.env.PRIVATE_TOKEN ?? "literal-default-secret";
      const { SUPABASE_ANON_KEY } = process.env;
      const { VITE_NAV_MODE } = import.meta.env;
      const { VITE_API_URL: viteApiUrl } = import.meta.env;
      const smsLive = process.env.SMS_LIVE === "true";
      if (!viteApiUrl) throw new Error("missing URL");
    `);
    await write(root, "artifacts/demo/src/styles.css", "/* TODO: style the navigation */\\n");
    await write(root, "artifacts/demo/src/query.sql", "-- FIXME: index this query\\n");

    const snapshot = await collectSource(root);
    const env = new Map(snapshot.env.map((entry) => [entry.name, entry]));
    assert(env.get("API_PORT")?.required);
    assert.equal(env.get("NOT_REQUIRED")?.required, false);
    assert(env.get("NON_NULL_KEY")?.required);
    assert(env.get("SUPABASE_ANON_KEY"));
    assert(env.get("VITE_API_URL")?.required);
    assert(env.get("VITE_NAV_MODE")?.flag);
    assert(env.get("SMS_LIVE")?.flag);
    assert(env.get("PRIVATE_TOKEN"));
    assert(!JSON.stringify(snapshot).includes("literal-default-secret"));
    assert(snapshot.todos.some((todo) => todo.file.endsWith("styles.css") && todo.text.includes("TODO")));
    assert(snapshot.todos.some((todo) => todo.file.endsWith("query.sql") && todo.text.includes("FIXME")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});