import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import express from "express";
import { operatorRouter, requireOperator, requireSameOrigin } from "../operatorAuth";

// Do not import the API app/index: those wire up database/provider clients and workers.
// The fixture is a loopback app using the real operator middleware.
process.env.NODE_ENV = "test";
process.env.OPERATOR_PASSWORD = "offline-gateway-fixture-password";
process.env.RUN_BACKGROUND_JOBS = "false";
process.env.SMS_LIVE = "false";
delete process.env.PUBLIC_API_URL;

const railway = JSON.parse(await readFile(new URL("../../../../../railway.json", import.meta.url), "utf8"));
const healthPath: string = railway.deploy.healthcheckPath;

test("production deploy config: single service, public API health, one replica", () => {
  assert.equal(healthPath, "/api/healthz");
  assert.equal(railway.deploy.startCommand, "node --enable-source-maps artifacts/api-server/dist/index.mjs");
  assert.equal(railway.build.buildCommand, "node artifacts/api-server/production-build.mjs");
  // Two replicas would contend for the scheduler lease; one is elected, the other idles.
  assert.equal(railway.deploy.numReplicas, 1);
});

test("operator protection on the production entry (offline)", { timeout: 20_000 }, async (t: TestContext) => {
  let healthStatus = 200;
  const healthy = { status: "ok", db_reachable: true, sms_live: false, paused: false };
  const degraded = { status: "degraded", db_reachable: false, sms_live: false, paused: null };
  const requests: Array<{ method: string; url: string; cookie?: string }> = [];
  const app = express();
  app.set("trust proxy", 1);
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
    res.setHeader("Cache-Control", "no-store");
    res.status(healthStatus).json(healthStatus === 200 ? healthy : degraded);
  });
  app.get("/dashboard/assets/app.js", (_req, res) => res.type("js").send("/* protected fixture */"));
  app.get("/dashboard/{*page}", (_req, res) => res.send("protected dashboard fixture"));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    redirect: "manual", signal: AbortSignal.timeout(3_000), ...init,
  });

  await t.test("anonymous startup GET and HEAD succeed on the health check", async () => {
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

  await t.test("login cookie, protected assets, and logout keep auth intact", async () => {
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
    assert.equal((await request("/dashboard/c/fixture/dashboard", { headers: { cookie } })).status, 200);
    assert.equal((await request("/api/operator/logout", { method: "POST", headers: { cookie } })).status, 303);
    assert.equal((await request("/dashboard/assets/app.js", { headers: { cookie } })).status, 401);
  });

  await t.test("degraded health never becomes successful readiness", async () => {
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
    assert.deepEqual(await (await request(healthPath)).json(), healthy);
  });
});
