import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { getDefaultClubSlug } from "./lib/clubResolver";

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const defaultDashboardPath = () => `/dashboard/c/${encodeURIComponent(getDefaultClubSlug())}/dashboard`;
app.get("/", (_req, res) => res.redirect(defaultDashboardPath()));
app.get("/onboarding", (_req, res) => res.redirect(defaultDashboardPath()));

app.use("/api", router);

export default app;
