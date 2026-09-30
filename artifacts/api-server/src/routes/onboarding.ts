import { Router, type IRouter } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";
import { requireClub, type ClubScopedRequest } from "../lib/clubResolver";
import { isRetentionOnlyMode } from "../lib/retentionPolicy";

const router: IRouter = Router();

// Preserve onboarding for later phases, but expose no onboarding endpoints now.
router.use("/onboarding", (_req, res, next) => {
  if (isRetentionOnlyMode()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

const CR_BASE = "https://api.courtreserve.com/api/v1";

// ─── GET /api/onboarding/status ───────────────────────────────────────────────
router.get("/onboarding/status", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;

  const { data, error } = await supabase
    .from("clubs")
    .select("id, name, onboarded, platform")
    .eq("id", clubId)
    .maybeSingle();

  if (error) {
    if (
      error.message?.includes("onboarded") ||
      error.message?.includes("platform") ||
      error.code === "42703"
    ) {
      req.log.warn("onboarding columns missing — migration pending, defaulting onboarded=true");
      res.json({ onboarded: true, platform: "podplay", name: null, migrationPending: true });
      return;
    }
    req.log.error({ err: error.message }, "Failed to fetch onboarding status");
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({
    onboarded: data?.onboarded ?? false,
    platform: (data?.platform as string) ?? "podplay",
    name: (data?.name as string) ?? null,
  });
});

// ─── POST /api/onboarding/validate ────────────────────────────────────────────
// Pre-club credential check — does not require an existing club in context.
// For PodPlay, `subdomain` is required so we can test against the correct host.

const ValidateSchema = z.object({
  platform: z.enum(["podplay", "courtreserve"]),
  apiKey: z.string().min(1, "API key is required"),
  subdomain: z.string().optional(), // required for platform=podplay
  orgId: z.string().optional(),
});

router.post("/onboarding/validate", async (req, res) => {
  const parsed = ValidateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  const { platform, apiKey, subdomain, orgId } = parsed.data;

  try {
    if (platform === "podplay") {
      if (!subdomain) {
        res.status(400).json({ error: "subdomain is required for PodPlay validation" });
        return;
      }
      const podplayBase = `https://${subdomain}.podplay.app/apis/v2`;
      const r = await fetch(`${podplayBase}/users?page=1&ipp=1`, {
        headers: { "x-api-key": apiKey },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        req.log.warn({ status: r.status }, "PodPlay credential validation failed");
        res.status(422).json({
          valid: false,
          error: `PodPlay returned ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        });
        return;
      }
      res.json({ valid: true });
      return;
    }

    if (platform === "courtreserve") {
      if (!orgId) {
        res.status(400).json({ error: "Organization ID is required for CourtReserve" });
        return;
      }
      const r = await fetch(`${CR_BASE}/customrating/get?organizationId=${encodeURIComponent(orgId)}`, {
        headers: { "x-api-key": apiKey },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        req.log.warn({ status: r.status, orgId }, "CourtReserve credential validation failed");
        res.status(422).json({
          valid: false,
          error: `CourtReserve returned ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        });
        return;
      }
      const body = await r.json() as any;
      const raw = Array.isArray(body) ? body : (body.items ?? body.data ?? []);
      const categories = (raw as any[]).map((c: any) => ({
        id: String(c.Id ?? c.id ?? ""),
        name: String(c.Name ?? c.CategoryName ?? c.name ?? ""),
      }));
      req.log.info({ orgId, count: categories.length }, "CourtReserve credentials valid");
      res.json({ valid: true, categories });
      return;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err: message }, "Credential validation threw");
    res.status(500).json({ valid: false, error: message });
    return;
  }

  res.status(400).json({ error: "Unknown platform" });
});

// ─── POST /api/onboarding/complete ────────────────────────────────────────────

const CompleteSchema = z.object({
  name: z.string().min(1, "Club name is required"),
  timezone: z.string().min(1, "Timezone is required"),
  scheduled_sync_time: z.string().min(1, "Sync time is required"),
  platform: z.enum(["podplay", "courtreserve"]),
  apiKey: z.string().min(1, "API key is required"),
  subdomain: z.string().optional(),
  orgId: z.string().optional(),
  crRatingCategoryId: z.string().optional(),
});

router.post("/onboarding/complete", requireClub, async (req, res) => {
  const clubId = (req as ClubScopedRequest).clubId;

  const parsed = CompleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }

  const {
    name,
    timezone,
    scheduled_sync_time,
    platform,
    apiKey,
    subdomain,
    orgId,
    crRatingCategoryId,
  } = parsed.data;

  const { error } = await supabase
    .from("clubs")
    .update({
      name,
      timezone,
      scheduled_sync_time,
      platform,
      platform_api_key: apiKey,
      platform_subdomain: subdomain ?? null,
      platform_org_id: orgId ?? null,
      cr_rating_category_id: crRatingCategoryId ?? null,
      onboarded: true,
    })
    .eq("id", clubId);

  if (error) {
    req.log.error({ err: error.message }, "Failed to complete onboarding");
    res.status(500).json({ error: error.message });
    return;
  }

  req.log.info({ club_id: clubId, platform }, "Club onboarding completed");
  res.json({ ok: true });
});

export default router;
