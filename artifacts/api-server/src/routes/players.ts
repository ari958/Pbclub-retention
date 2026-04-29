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
// Updates progression_status with full audit trail

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

  // Fetch current status for audit trail
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
// Returns win-back conversion stats for the dashboard

router.get("/players/winback-stats", async (_req, res) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();

  // Players who received an outbound message while lapsing/dormant
  // and then attended an event within 14 days
  const { data: conversions, error } = await supabase
    .from("messages")
    .select(`
      id,
      sent_at,
      converted_at,
      conversations (
        player_id,
        triggered_by
      )
    `)
    .eq("direction", "outbound")
    .eq("status", "sent")
    .not("converted_at", "is", null)
    .gte("sent_at", thirtyDaysAgo);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Total sent in last 30 days
  const { count: totalSent } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .eq("status", "sent")
    .gte("sent_at", thirtyDaysAgo);

  const converted = conversions?.length ?? 0;
  const conversionRate = totalSent && totalSent > 0
    ? Math.round((converted / totalSent) * 100)
    : null;

  res.json({
    period_days: 30,
    messages_sent: totalSent ?? 0,
    conversions: converted,
    conversion_rate_pct: conversionRate,
  });
});

export default router;
