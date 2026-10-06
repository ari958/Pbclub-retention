import type { Plugin } from "vite";

/** Gate dev HTML and assets too; never rely solely on a React route guard. */
export function operatorGate(): Plugin {
  return {
    name: "operator-access-gate",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (pathname.startsWith("/dashboard/api/") || pathname.startsWith("/api/")) return next();
        try {
          const response = await fetch(`http://127.0.0.1:${process.env.API_PORT ?? "8080"}/api/operator/session`, {
            headers: { cookie: req.headers.cookie ?? "" },
          });
          if (response.ok) return next();
        } catch { /* Failed API means no unauthenticated asset access. */ }
        res.setHeader("Cache-Control", "no-store");
        if (req.headers.accept?.includes("text/html")) {
          res.statusCode = 302;
          res.setHeader("Location", "/api/operator/login");
        } else res.statusCode = 401;
        res.end("Operator login required");
      });
    },
  };
}
