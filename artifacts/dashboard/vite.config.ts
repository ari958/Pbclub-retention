import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { operatorGate } from "./operatorGate";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

const defaultClubSlug = process.env.DEFAULT_CLUB_SLUG;

if (!defaultClubSlug) {
  throw new Error(
    "DEFAULT_CLUB_SLUG environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  define: {
    // Expose existing server secrets to the Vite frontend without requiring new VITE_-prefixed vars
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(process.env.SUPABASE_URL ?? ""),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(process.env.SUPABASE_ANON_KEY ?? ""),
    "import.meta.env.VITE_DEFAULT_CLUB_SLUG": JSON.stringify(defaultClubSlug),
  },
  plugins: [
    operatorGate(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    proxy: (() => {
      // The browser fetches "/dashboard/api/..." (the base path is kept), so
      // match the full prefixed path and rewrite it down to "/api/..." for the
      // API server. Also keep "/api" so direct (non-prefixed) calls work in
      // local dev without a base path.
      const base = basePath.replace(/\/$/, ""); // e.g. "/dashboard"
      const apiPrefix = `${base}/api`;          // e.g. "/dashboard/api"
      const apiTarget = `http://localhost:${process.env.API_PORT ?? 8080}`;
      const prefixedRule = {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(new RegExp(`^${apiPrefix}`), "/api"),
      };
      return {
        [apiPrefix]: prefixedRule,
        "/api": { target: apiTarget, changeOrigin: true },
      };
    })(),
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
