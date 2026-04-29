import { Router, type IRouter } from "express";
import { createClient } from "@supabase/supabase-js";
// @ts-ignore — plain JS module
import { assembleProfile } from "../assembleProfile.js";

const router: IRouter = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!
);

// ─── GET /api/players/:id/profile ────────────────────────────────────────────

router.get("/players/:id/profile", async (req, res) => {
  try {
    const data = await assembleProfile(req.params.id);
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const supabaseError = (err as any)?.supabaseError;
    req.log.error(
      {
        err,
        supabase: supabaseError
          ? {
              message: supabaseError.message,
              code: supabaseError.code,
              hint: supabaseError.hint,
              details: supabaseError.details,
            }
          : undefined,
      },
      "Failed to assemble player profile",
    );
    if (
      supabaseError?.code === "PGRST116" ||
      message.includes("JSON object requested, multiple (or no) rows returned")
    ) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    res.status(500).json({ error: message });
  }
});

// ─── POST /api/players/:id/progression ───────────────────────────────────────

router.post("/players/:id/progression", async (req, res) => {
  const { status, assessed_by } = req.body as {
    status: string | null;
    assessed_by?: string;
  };

  const validStatuses = ["ready-to-advance", "developing", "at-ceiling", null];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: "Invalid progression status" });
    return;
  }

  const { data: current } = await supabase
    .from("players")
    .select("progression_status")
    .eq("id", req.params.id)
    .single();

  const { error } = await supabase
    .from("players")
    .update({
      progression_status: status,
      progression_previous: current?.progression_status ?? null,
      progression_assessed_at: new Date().toISOString(),
      progression_assessed_by: assessed_by ?? "operator",
    })
    .eq("id", req.params.id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ updated: true, previous: current?.progression_status, current: status });
});

// ─── GET /api/players/winback-stats ──────────────────────────────────────────
// Wrapped in try/catch so a missing column or empty data never crashes the dashboard

router.get("/players/winback-stats", async (_req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

    const [conversionsRes, totalSentRes] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .eq("status", "sent")
        .not("converted_at", "is", null)
        .gte("created_at", thirtyDaysAgo),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .eq("status", "sent")
        .gte("created_at", thirtyDaysAgo),
    ]);

    const converted = conversionsRes.count ?? 0;
    const totalSent = totalSentRes.count ?? 0;
    const conversionRate =
      totalSent > 0 ? Math.round((converted / totalSent) * 100) : null;

    res.json({
      period_days: 30,
      messages_sent: totalSent,
      conversions: converted,
      conversion_rate_pct: conversionRate,
    });
  } catch (err: unknown) {
    // Never let this endpoint crash the dashboard — return null stats
    res.json({
      period_days: 30,
      messages_sent: 0,
      conversions: 0,
      conversion_rate_pct: null,
    });
  }
});

export default router;
