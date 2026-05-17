/**
 * PodPlay URL helpers — replaces hardcoded "pbclub.podplay.app" across
 * the codebase. The host is now derived from clubs.platform_subdomain.
 *
 * Usage in routes (after requireClub middleware has resolved clubId):
 *
 *   const base = await getPodPlayBaseUrl(clubId);
 *   const res = await fetch(`${base}/apis/v2/users`, ...);
 *
 * Usage in batch jobs that iterate over clubs:
 *
 *   for (const club of clubs) {
 *     const base = buildPodPlayBaseUrl(club.platform_subdomain);
 *     ...
 *   }
 *
 * Caching: same in-memory pattern as clubResolver — 60s TTL. The clubs
 * table changes essentially never; this avoids a Supabase round-trip
 * inside hot paths.
 */

import { supabase } from "./supabaseClient";

const PODPLAY_DOMAIN = "podplay.app";
const CACHE_TTL_MS = 60_000;

type CacheEntry = { baseUrl: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/**
 * Build a PodPlay base URL from a subdomain string.
 * Pure function — no DB hit. Use when you already have the subdomain
 * in hand (e.g. inside a batch loop over clubs).
 * Returns e.g. "https://pbclub.podplay.app"
 */
export function buildPodPlayBaseUrl(subdomain: string | null | undefined): string {
  if (!subdomain) {
    throw new Error(
      "Cannot build PodPlay base URL: club has no platform_subdomain set.",
    );
  }
  return `https://${subdomain}.${PODPLAY_DOMAIN}`;
}

/**
 * Resolve a club's PodPlay base URL by clubId.
 * Returns e.g. "https://pbclub.podplay.app"
 * Hits Supabase on cache miss; cached for 60s after.
 */
export async function getPodPlayBaseUrl(clubId: string): Promise<string> {
  const now = Date.now();
  const cached = cache.get(clubId);
  if (cached && cached.expiresAt > now) return cached.baseUrl;

  const { data, error } = await supabase
    .from("clubs")
    .select("platform_subdomain")
    .eq("id", clubId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error(`No club with id=${clubId}`);

  const baseUrl = buildPodPlayBaseUrl(data.platform_subdomain);
  cache.set(clubId, { baseUrl, expiresAt: now + CACHE_TTL_MS });
  return baseUrl;
}

/**
 * Build the public signup URL for an event.
 * Replaces hardcoded "https://pbclub.podplay.app/community/events/<id>" patterns.
 */
export async function getEventSignupUrl(
  clubId: string,
  eventId: string,
): Promise<string> {
  const baseUrl = await getPodPlayBaseUrl(clubId);
  return `${baseUrl}/community/events/${eventId}`;
}
