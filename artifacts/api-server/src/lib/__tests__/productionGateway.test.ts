import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import express from "express";
import { operatorRouter, requireOperator, requireSameOrigin } from "../operatorAuth";

// Do not import the API app/index: those wire up database/provider clients and workers.
// The only upstream is a loopback fixture using the real operator middleware.
process.env.NODE_ENV = "test";
process.env.OPERATOR_PASSWORD = "offline-gateway-fixture-password";
process.env.RUN_BACKGROUND_JOBS = "false";
process.env.SMS_LIVE = "false";
delete process.env.PUBLIC_API_URL;

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const config = await readFile(new URL("../../../../dashboard/.replit-artifact/artifact.toml", import.meta.url), "utf8");

function configSection(name: string): string {
  const sections = config.split(/^\[([^\]\n]+)\]\s*$/m);
  const index = sections.indexOf(name);
  assert.notEqual(index, -1, `Missing artifact section [${name}]`);
  return sections[index + 1];
}

const production = configSection("services.production");
const command: string[] = JSON.parse(production.match(/^run\s*=\s*(\[.*\])\s*$/m)?.[1] ?? "null");
const startup = configSection("services.production.health.startup");
const healthPath = JSON.parse(startup.match(/^path\s*=\s*(".*")\s*$/m)?.[1] ?? "null");

async function startGateway(t: TestContext, apiPort: number): Promise<string> {
  // Observe the real entrypoint's ephemeral listener via a test-only preload.
  // This avoids fixed ports, reservation races, and changing production code for tests.
  const observer = `import http from "node:http";
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (...args) {
      this.once("listening", () => process.send({ port: this.address().port }));
      return listen.apply(this, args);
    };`;
  assert.deepEqual(command, ["node", "artifacts/dashboard/production-gateway.mjs"]);
  const child = spawn(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(observer)}`, ...command.slice(1),
  ], {
    cwd: root,
    // Deliberately do not inherit workspace credentials or provider settings.
    env: { NODE_ENV: "test", PORT: "0", API_PORT: String(apiPort),
      RUN_BACKGROUND_JOBS: "false", SMS_LIVE: "false" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway did not listen: ${output}`)), 5_000);
    const finish = (error?: Error, value?: number) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`Gateway exited (${code}): ${output}`)));
    child.once("message", (message) => {
      const bound = (message as { port: number }).port;
      if (!Number.isInteger(bound) || bound <= 0) finish(new Error("Invalid gateway listener"));
      else finish(undefined, bound);
    });
  });
  return `http://127.0.0.1:${port}`;
}

test("production startup probe uses public API health, not protected HTML", () => {
  assert.equal(healthPath, "/api/healthz");
  assert.deepEqual(command, ["node", "artifacts/dashboard/production-gateway.mjs"]);
});

test("production gateway readiness and operator protection (offline)", { timeout: 20_000 }, async (t) => {
  let healthStatus = 200;
  let disconnectHealth = false;
  const healthy = { status: "ok", db_reachable: true, sms_live: false, paused: false };
  const degraded = { status: "degraded", db_reachable: false, sms_live: false, paused: null };
  const requests: Array<{ method: string; url: string; cookie?: string }> = [];
  const app = express();
  app.use((req, _res, next) => {
    requests.push({ method: req.method, url: req.url, cookie: req.headers.cookie });
    next();
  });
  app.use(express.urlencoded({ extended: false }));
  app.use("/api/operator", operatorRouter);
  app.use((req, res, next) => {
    // Same narrow public exception as the API; no public dashboard/assets bypass.
    if (["GET", "HEAD"].includes(req.method) && req.path === "/api/healthz") return next();
    requireOperator(req, res, next);
  });
  app.use(requireSameOrigin);
  app.get("/api/healthz", (_req, res) => {
    if (disconnectHealth) {
      res.destroy();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(healthStatus).json(healthStatus === 200 ? healthy : degraded);
  });
  app.get("/dashboard/assets/app.js", (_req, res) => res.type("js").send("/* protected fixture */"));
  app.get("/dashboard/{*page}", (_req, res) => res.send("protected dashboard fixture"));
  const upstream = http.createServer(app);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const closeUpstream = () => new Promise<void>((resolve, reject) => {
    if (!upstream.listening) return resolve();
    upstream.close((error) => error ? reject(error) : resolve());
    upstream.closeAllConnections();
  });
  t.after(closeUpstream);
  const base = await startGateway(t, (upstream.address() as AddressInfo).port);
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    redirect: "manual", signal: AbortSignal.timeout(3_000), ...init,
  });

  await t.test("anonymous startup GET and HEAD succeed through the gateway", async () => {
    const response = await request(healthPath);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type")!, /application\/json/);
    assert.deepEqual(await response.json(), healthy);
    assert.deepEqual(requests.at(-1), { method: "GET", url: healthPath, cookie: undefined });
    const head = await request(healthPath, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(requests.at(-1)?.method, "HEAD");
  });

  await t.test("HTML redirects to login while assets and API remain unauthorized", async () => {
    for (const path of ["/dashboard/", "/dashboard/c/fixture/dashboard"]) {
      const html = await request(path, { headers: { Accept: "text/html" } });
      assert.equal(html.status, 302);
      assert.equal(html.headers.get("location"), "/api/operator/login");
      assert.equal(html.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await html.text(), /protected dashboard fixture/);
    }
    for (const path of ["/dashboard/assets/app.js", "/api/operator/session", "/dashboard/api/healthz"]) {
      const response = await request(path);
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await request(healthPath, { method: "POST" })).status, 401);
    assert.equal((await request("/dashboard/assets/app.js", {
      headers: { cookie: "operator_session=forged" },
    })).status, 401);
    assert.equal((await request("/api/operator/login")).status, 200);
  });

  await t.test("login cookie, protected assets, and logout are forwarded without weakening auth", async () => {
    const login = await request("/api/operator/login", {
      method: "POST",
      body: new URLSearchParams({ password: "offline-gateway-fixture-password", label: "Offline fixture" }),
    });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get("location"), "/dashboard/");
    const setCookie = login.headers.get("set-cookie")!;
    for (const flag of [/HttpOnly/, /Secure/, /SameSite=Strict/]) assert.match(setCookie, flag);
    const cookie = setCookie.split(";")[0];
    const asset = await request("/dashboard/assets/app.js?version=fixture", { headers: { cookie } });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "/* protected fixture */");
    assert.deepEqual(requests.at(-1), { method: "GET", url: "/dashboard/assets/app.js?version=fixture", cookie });
    assert.equal((await request("/dashboard/c/fixture/dashboard", { headers: { cookie } })).status, 200);
    assert.equal((await request("/api/operator/logout", { method: "POST", headers: { cookie } })).status, 303);
    assert.equal((await request("/dashboard/assets/app.js", { headers: { cookie } })).status, 401);
  });

  await t.test("degraded and failed upstream health never become successful readiness", async () => {
    for (const status of [503, 500, 502]) {
      healthStatus = status;
      const response = await request(healthPath);
      assert.equal(response.status, status);
      assert.equal(response.ok, false);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), degraded);
      assert.equal((await request("/dashboard/assets/app.js")).status, 401);
    }
    healthStatus = 200;
    const recovered = await request(healthPath);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), healthy);
  });

  await t.test("disconnected upstream health fails closed, then recovers", async () => {
    disconnectHealth = true;
    const response = await request(healthPath);
    assert.equal(response.status, 503);
    assert.equal(response.ok, false);
    assert.equal(await response.text(), "API unavailable");
    disconnectHealth = false;
    assert.equal((await request(healthPath)).status, 200);
  });

  await t.test("unavailable API cannot pass readiness or expose dashboard fallback content", async () => {
    await closeUpstream();
    for (const path of [healthPath, "/dashboard/", "/dashboard/assets/app.js"]) {
      const response = await request(path);
      assert.equal(response.status, 503, path);
      assert.equal(response.ok, false);
      assert.equal(await response.text(), "API unavailable");
    }
  });
});
