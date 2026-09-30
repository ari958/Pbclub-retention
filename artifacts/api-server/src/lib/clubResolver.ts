/**
 * Club resolver — extracts and validates the active club for an API request.
 *
 * Every API route that touches club-scoped data must call this before any
 * Supabase query. Returns the club UUID; throws if missing, malformed, or
 * not found. Requests without an explicit club use DEFAULT_CLUB_SLUG.
 *
 * Accepts (in priority order):
 *   1. ?clubId=<uuid> in query string
 *   2. ?slug=<slug>  in query string
 *   3. Path segment :clubId or :slug (when route is mounted under those)
 *
 * Caching: in-memory slug→id map with 60s TTL. The clubs table changes
 * essentially never; this avoids a Supabase round-trip on every request.
 *
 * Architectural rule (see RUNBOOK.md): no route may scope to "the only
 * club" or "the first club". The CLUB_ID constant is gone. Tenant comes
 * from the request, always.
 */

import type { Request } from "express";
import { supabase } from "./supabaseClient";

// --- Errors ------------------------------------------------------------------

export class ClubResolutionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code:
      | "missing_club"
      | "invalid_club_id"
      | "invalid_slug"
      | "club_not_found",
  ) {
    super(message);
    this.name = "ClubResolutionError";
  }
}

// --- Validation --------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

export function getDefaultClubSlug(): string {
  return (process.env.DEFAULT_CLUB_SLUG ?? "pb-club").trim();
}

// --- Cache -------------------------------------------------------------------

type CacheEntry = { id: string; expiresAt: number };
const CACHE_TTL_MS = 60_000;
const slugCache = new Map<string, CacheEntry>();
const idCache = new Set<string>(); // known-valid ids; never expires (ids are stable)

function cachedSlug(slug: string): string | null {
  const entry = slugCache.get(slug);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    slugCache.delete(slug);
    return null;
  }
  return entry.id;
}

function rememberSlug(slug: string, id: string) {
  slugCache.set(slug, { id, expiresAt: Date.now() + CACHE_TTL_MS });
  idCache.add(id);
}

// --- Public API --------------------------------------------------------------

/**
 * Resolve the request's active club to a UUID.
 *
 * Throws ClubResolutionError with appropriate status on any failure:
 *   400 — missing, malformed, or invalid input
 *   404 — well-formed but no matching club
 */
export async function resolveClubId(req: Request): Promise<string> {
  // 1. Try clubId (uuid) from query or params
  const rawClubId =
    typeof req.query.clubId === "string"
      ? req.query.clubId
      : typeof (req.params as Record<string, unknown>).clubId === "string"
        ? (req.params as Record<string, string>).clubId
        : undefined;

  if (rawClubId) {
    if (!UUID_RE.test(rawClubId)) {
      throw new ClubResolutionError(
        `Invalid clubId format: ${rawClubId}`,
        400,
        "invalid_club_id",
      );
    }
    if (idCache.has(rawClubId)) return rawClubId;

    const { data, error } = await supabase
      .from("clubs")
      .select("id")
      .eq("id", rawClubId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new ClubResolutionError(
        `No club with id=${rawClubId}`,
        404,
        "club_not_found",
      );
    }
    idCache.add(rawClubId);
    return rawClubId;
  }

  // 2. Explicit slug, or the configured single-club default. Never first row.
  const rawSlug =
    (typeof req.query.slug === "string"
      ? req.query.slug
      : typeof (req.params as Record<string, unknown>).slug === "string"
        ? (req.params as Record<string, string>).slug
        : undefined) || getDefaultClubSlug();

  return resolveClubSlug(rawSlug);
}

export async function resolveClubSlug(slug: string): Promise<string> {
  if (!SLUG_RE.test(slug)) {
    throw new ClubResolutionError(
      `Invalid slug format: ${slug}`,
      400,
      "invalid_slug",
    );
  }

  const cached = cachedSlug(slug);
  if (cached) return cached;

  const { data, error } = await supabase
    .from("clubs")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ClubResolutionError(
      `No club with slug=${slug}`,
      404,
      "club_not_found",
    );
  }
  rememberSlug(slug, data.id);
  return data.id;
}

/**
 * Express middleware wrapper. Attaches `clubId` to `req` and continues, or
 * sends a 400/404 with a structured error body on failure.
 *
 * Usage:
 *   router.get('/players', requireClub, async (req, res) => {
 *     const clubId = (req as ClubScopedRequest).clubId;
 *     ...
 *   });
 */
export interface ClubScopedRequest extends Request {
  clubId: string;
}

export async function requireClub(
  req: Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  try {
    const clubId = await resolveClubId(req);
    (req as ClubScopedRequest).clubId = clubId;
    res.setHeader("X-Resolved-Club-Id", clubId);
    req.log.info({
      club_id: clubId,
      club_resolution: req.query.clubId || req.params.clubId
        ? "explicit_id"
        : req.query.slug || req.params.slug ? "explicit_slug" : "default_slug",
    }, "Request club resolved");
    next();
  } catch (err) {
    if (err instanceof ClubResolutionError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}
