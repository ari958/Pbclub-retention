import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import rateLimit from "express-rate-limit";

const COOKIE = "operator_session";
const TTL = 12 * 60 * 60 * 1000;
const sessions = new Map<string, { expires: number; label: string; passwordVersion: string }>();
const digest = (value: string) => createHash("sha256").update(value).digest();
const cookieOptions = () => ({
  httpOnly: true, secure: true, path: "/",
  // The workspace preview is a cross-site iframe; production remains Strict.
  sameSite: process.env.NODE_ENV === "development" ? "none" as const : "strict" as const,
});
const cookies = (req: Request) => Object.fromEntries((req.headers.cookie ?? "").split(";")
  .map((part) => part.trim().split("=")).filter(([key, value]) => key && value));

export function operatorSession(req: Request) {
  const token = cookies(req)[COOKIE];
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now() || !process.env.OPERATOR_PASSWORD
    || session.passwordVersion !== digest(process.env.OPERATOR_PASSWORD).toString("hex")) {
    if (token) sessions.delete(token);
    return null;
  }
  // Audit the authenticated session, not a client-supplied identity or bearer token.
  return { actor: `operator:${digest(token).toString("hex").slice(0, 12)} (${session.label})` };
}

export function requireOperator(req: Request, res: Response, next: NextFunction) {
  const session = operatorSession(req);
  if (!session) {
    res.setHeader("Cache-Control", "no-store");
    if (req.path.startsWith("/api/") || !req.get("accept")?.includes("text/html")) {
      res.status(401).json({ error: "Operator login required" });
    } else res.redirect("/api/operator/login");
    return;
  }
  res.locals.operator = session;
  res.setHeader("Cache-Control", "no-store");
  // Attribute all existing approval / audit paths to the authenticated session.
  if (req.body && typeof req.body === "object") {
    if ("approved_by" in req.body || req.path.endsWith("/approve") || req.path.endsWith("/messages/bulk")) req.body.approved_by = session.actor;
    if ("actor" in req.body || req.path.endsWith("/kill-switch")) req.body.actor = session.actor;
  }
  next();
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin) {
    const host = req.get("x-forwarded-host") ?? req.get("host");
    const allowed = new Set([`https://${host}`, `http://${host}`]);
    if (process.env.PUBLIC_API_URL) allowed.add(process.env.PUBLIC_API_URL.replace(/\/$/, ""));
    if (!allowed.has(origin)) return void res.status(403).json({ error: "Cross-origin request refused" });
  }
  next();
}

export const operatorRouter = Router();
operatorRouter.use(requireSameOrigin);
const attempts = new Map<string, { totalHits: number; resetTime: Date }>();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: "draft-7", legacyHeaders: false,
  // Lazy cleanup avoids an unconditional housekeeping timer in dev.
  store: {
    localKeys: true,
    async increment(key: string) {
      for (const [ip, value] of attempts) if (value.resetTime.getTime() <= Date.now()) attempts.delete(ip);
      const value = attempts.get(key) ?? { totalHits: 0, resetTime: new Date(Date.now() + 15 * 60 * 1000) };
      value.totalHits++;
      attempts.set(key, value);
      return value;
    },
    async decrement(key: string) { const value = attempts.get(key); if (value) value.totalHits = Math.max(0, value.totalHits - 1); },
    async resetKey(key: string) { attempts.delete(key); },
  },
});
operatorRouter.get("/login", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const frameAncestors = process.env.NODE_ENV === "development" ? "'self' https://replit.com https://*.replit.com" : "'self'";
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors ${frameAncestors}`);
  res.type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>PB Club operator login</title><style>body{margin:0;background:#111827;color:#f9fafb;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{width:min(360px,85vw)}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{padding:12px;margin:8px 0 22px;border-radius:6px}button{background:#e8a838;border:0;color:#111827;font-weight:700}p{color:#b8c2d1;line-height:1.5}</style>
  <main><h1>Operator login</h1><p>Sign in to manage PB Club. Login does not approve messages or change sending settings.</p>
  <form method="post" action="/api/operator/login"><label for="label">Operator label</label><input id="label" name="label" maxlength="80" value="Operator" autocomplete="nickname">
  <label for="password">Password</label><input id="password" type="password" name="password" required autocomplete="current-password"><button>Sign in</button></form></main></html>`);
});
operatorRouter.post("/login", loginLimiter, (req, res) => {
  const password = process.env.OPERATOR_PASSWORD;
  if (!password) return void res.status(503).send("Operator login is not configured. Set OPERATOR_PASSWORD in Secrets.");
  const input = typeof req.body.password === "string" ? req.body.password : "";
  if (!timingSafeEqual(digest(input), digest(password))) return void res.status(401).send("Invalid password.");
  for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
  const old = cookies(req)[COOKIE];
  if (old) sessions.delete(old);
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { expires: Date.now() + TTL, label: String(req.body.label ?? "Operator").trim().slice(0, 80) || "Operator",
    passwordVersion: digest(password).toString("hex") });
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: TTL });
  res.setHeader("Cache-Control", "no-store");
  res.redirect(303, "/dashboard/");
});
operatorRouter.get("/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const session = operatorSession(req);
  res.status(session ? 200 : 401).json(session ? { authenticated: true, actor: session.actor } : { authenticated: false });
});
operatorRouter.post("/logout", (req, res) => {
  const token = cookies(req)[COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(COOKIE, cookieOptions());
  res.setHeader("Cache-Control", "no-store");
  res.redirect(303, "/api/operator/login");
});
