import { Router, type IRouter } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";

const router: IRouter = Router();

const CLUB_ID = process.env.CLUB_ID ?? "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";
const CR_BASE = "https://api.courtreserve.com/api/v1";

// ─── GET /api/onboarding/status ───────────────────────────────────────────────

router.get("/onboarding/status", async (req, res) => {
  const { data, error } = await supabase
    .from("clubs")
    .select("id, name, onboarded, platform")
    .eq("id", CLUB_ID)
    .maybeSingle();

  if (error) {
    // Migration not yet applied — treat as onboarded so the dashboard keeps working
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

const ValidateSchema = z.object({
  platform: z.enum(["podplay", "courtreserve"]),
  apiKey: z.string().min(1, "API key is required"),
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

  const { platform, apiKey, orgId } = parsed.data;

  try {
    if (platform === "podplay") {
      const r = await fetch(`${PODPLAY_BASE}/users?page=1&ipp=1`, {
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
  orgId: z.string().optional(),
  crRatingCategoryId: z.string().optional(),
});

router.post("/onboarding/complete", async (req, res) => {
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
      platform_org_id: orgId ?? null,
      cr_rating_category_id: crRatingCategoryId ?? null,
      onboarded: true,
    })
    .eq("id", CLUB_ID);

  if (error) {
    req.log.error({ err: error.message }, "Failed to complete onboarding");
    res.status(500).json({ error: error.message });
    return;
  }

  req.log.info({ club_id: CLUB_ID, platform }, "Club onboarding completed");
  res.json({ ok: true });
});

export default router;
