import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getDefaultClubSlug } from "./lib/clubResolver";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { operatorRouter, requireOperator, requireSameOrigin } from "./lib/operatorAuth";
import { validateTwilioWebhook, WEBHOOK_PATHS } from "./lib/twilioWebhook";

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));
app.use("/api/operator", operatorRouter);
app.use((req, res, next) => {
  if (["GET", "HEAD"].includes(req.method) && req.path === "/api/healthz") return next();
  if (req.method === "POST" && WEBHOOK_PATHS.has(req.path)) return validateTwilioWebhook(req, res, next);
  requireOperator(req, res, next);
});
app.use(requireSameOrigin);

const defaultDashboardPath = () => `/dashboard/c/${encodeURIComponent(getDefaultClubSlug())}/dashboard`;
app.get("/", (_req, res) => res.redirect(defaultDashboardPath()));
app.get("/onboarding", (_req, res) => res.redirect(defaultDashboardPath()));

app.use("/api", router);
app.use("/dashboard/api", router);
if (process.env.NODE_ENV === "production") {
  const dashboard = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dashboard/dist/public");
  app.use("/dashboard", express.static(dashboard, { index: false, dotfiles: "deny" }));
  app.get("/dashboard/{*page}", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(dashboard, "index.html"));
  });
}

export default app;
