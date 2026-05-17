/**
 * ClubContext — supplies the active club (id, slug, name, timezone) to
 * every page in the dashboard.
 *
 * Source of truth: the URL :slug parameter under /c/:slug/*.
 * Provider mounts inside the /c/:slug route in App.tsx. Pages call
 * useClub() to access the resolved club; they should never read the slug
 * directly or fetch the clubs table themselves.
 *
 * Loading model:
 *   - status: 'loading'   — initial render, slug present, fetch in flight
 *   - status: 'ready'     — club resolved; clubId is non-null
 *   - status: 'not_found' — slug doesn't match any club; render NotFound
 *   - status: 'error'     — Supabase error; render error state
 *
 * Pages should gate club-scoped Supabase queries on `status === 'ready'`.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useParams } from "react-router-dom";
import { supabase } from "./supabase";

export interface Club {
  id: string;
  slug: string;
  name: string;
  timezone: string;
}

type ClubContextValue =
  | { status: "loading"; club: null }
  | { status: "ready"; club: Club }
  | { status: "not_found"; club: null; slug: string }
  | { status: "error"; club: null; error: string };

const ClubContext = createContext<ClubContextValue | undefined>(undefined);

export function ClubProvider({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const [value, setValue] = useState<ClubContextValue>({
    status: "loading",
    club: null,
  });

  useEffect(() => {
    if (!slug) {
      setValue({ status: "error", club: null, error: "No slug in URL" });
      return;
    }

    let cancelled = false;
    setValue({ status: "loading", club: null });

    supabase
      .from("clubs")
      .select("id, slug, name, timezone")
      .eq("slug", slug)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setValue({ status: "error", club: null, error: error.message });
          return;
        }
        if (!data) {
          setValue({ status: "not_found", club: null, slug });
          return;
        }
        setValue({ status: "ready", club: data as Club });
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>;
}

/**
 * Strict accessor — throws if used outside a ClubProvider or before ready.
 * Use in pages that gate their render on status. For most components,
 * prefer useClubStatus() instead and handle loading/error explicitly.
 */
export function useClub(): Club {
  const ctx = useContext(ClubContext);
  if (!ctx) throw new Error("useClub must be used inside <ClubProvider>");
  if (ctx.status !== "ready") {
    throw new Error(
      `useClub called while status=${ctx.status}. Gate render on useClubStatus() or wait for ready.`,
    );
  }
  return ctx.club;
}

/**
 * Permissive accessor — returns the full context. Use for layouts that
 * render loading/error UI explicitly.
 */
export function useClubStatus(): ClubContextValue {
  const ctx = useContext(ClubContext);
  if (!ctx) throw new Error("useClubStatus must be used inside <ClubProvider>");
  return ctx;
}

/**
 * Helper for constructing club-scoped API URLs.
 * Example: clubApiUrl(slug, '/api/players')
 *        → '/api/players?slug=pb-club'
 *        + extra query params merged in
 */
export function clubApiUrl(
  slug: string,
  path: string,
  extra?: Record<string, string | number | boolean | undefined>,
): string {
  const params = new URLSearchParams();
  params.set("slug", slug);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) params.set(k, String(v));
    }
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${params.toString()}`;
}

/**
 * Memoized convenience for components that need clubId frequently.
 * Returns null while loading or on error.
 */
export function useClubId(): string | null {
  const ctx = useClubStatus();
  return useMemo(
    () => (ctx.status === "ready" ? ctx.club.id : null),
    [ctx],
  );
}
