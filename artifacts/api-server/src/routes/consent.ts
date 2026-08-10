/**
 * SMS Consent Import routes.
 *
 * POST /api/consent/import
 *   Idempotent import of the sms_consent_records CSV batch.
 *   Body: { clubId, csvRows: [{email, phoneE164, firstName, lastName, consentedAt}][], importBatch, dryRun? }
 *   Requires migration 008 to have been applied.
 *   Does NOT send any messages. Does NOT write to messages/programming_notifications/contact_ledger.
 *   Does NOT overwrite an existing non-null phone number.
 *   Never touches PodPlay.
 *
 * GET /api/consent/records?clubId=
 *   List consent records for a club (matched + leads).
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { supabase } from "../lib/supabaseClient";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Validation ────────────────────────────────────────────────────────────────

const ConsentRowSchema = z.object({
  email:       z.string().email(),
  phoneE164:   z.string().regex(/^\+1\d{10}$/, "Must be +1XXXXXXXXXX"),
  firstName:   z.string().optional(),
  lastName:    z.string().optional(),
  consentedAt: z.string().datetime(),          // ISO 8601 UTC from the caller
});

const ImportBodySchema = z.object({
  clubId:      z.string().uuid(),
  rows:        z.array(ConsentRowSchema).min(1).max(5000),
  importBatch: z.string().min(1),              // e.g. "Customers_2026-08-10.csv @ 2026-08-10T21:00Z"
  dryRun:      z.boolean().optional(),
});

// ── POST /api/consent/import ──────────────────────────────────────────────────

router.post("/consent/import", async (req, res) => {
  const parsed = ImportBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  const { clubId, rows, importBatch, dryRun = false } = parsed.data;

  try {
    // ── 1. Load all players for this club (email → player) ────────────────────
    const players: any[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from("players")
        .select("id, email, phone, sms_opt_in, opted_out")
        .eq("club_id", clubId)
        .range(offset, offset + 999);
      if (error) throw new Error(`load players: ${error.message}`);
      if (!data?.length) break;
      players.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }

    const emailToPlayer = new Map<string, any>();
    for (const p of players) {
      if (p.email) emailToPlayer.set(p.email.toLowerCase().trim(), p);
    }

    // ── 2. Classify each row ──────────────────────────────────────────────────
    type RowResult = {
      row:      typeof rows[0];
      matched:  boolean;
      playerId: string | null;
      action:   "phone_fill" | "consent_only" | "conflict_skip" | "lead_only";
      conflict?: { existing: string };
    };

    const results: RowResult[] = [];

    for (const row of rows) {
      const player = emailToPlayer.get(row.email.toLowerCase().trim());
      if (!player) {
        results.push({ row, matched: false, playerId: null, action: "lead_only" });
        continue;
      }

      const existingDigits = player.phone
        ? player.phone.replace(/\D/g, "").slice(-11)
        : null;
      const csvDigits = row.phoneE164.replace(/\D/g, "").slice(-11);

      if (!existingDigits) {
        results.push({ row, matched: true, playerId: player.id, action: "phone_fill" });
      } else if (existingDigits === csvDigits) {
        results.push({ row, matched: true, playerId: player.id, action: "consent_only" });
      } else {
        // Conflict — never overwrite, flag for review
        results.push({
          row, matched: true, playerId: player.id, action: "conflict_skip",
          conflict: { existing: player.phone },
        });
      }
    }

    const stats = {
      total:        results.length,
      phone_fills:  results.filter(r => r.action === "phone_fill").length,
      consent_only: results.filter(r => r.action === "consent_only").length,
      conflicts:    results.filter(r => r.action === "conflict_skip").length,
      leads:        results.filter(r => r.action === "lead_only").length,
    };

    if (dryRun) {
      res.json({ dry_run: true, stats, import_batch: importBatch });
      return;
    }

    // ── 3. Upsert sms_consent_records (all rows — matched and leads) ──────────
    // UNIQUE constraint is (club_id, email) — re-running is safe.
    const consentRecords = results.map(r => ({
      club_id:        clubId,
      player_id:      r.playerId ?? null,
      email:          r.row.email.toLowerCase().trim(),
      phone_e164:     r.row.phoneE164,
      first_name:     r.row.firstName ?? null,
      last_name:      r.row.lastName ?? null,
      consented_at:   r.row.consentedAt,
      consent_source: "web_form",
      import_batch:   importBatch,
      matched:        r.matched,
    }));

    let consentInserted = 0;
    const BATCH = 100;
    for (let i = 0; i < consentRecords.length; i += BATCH) {
      const { error } = await supabase
        .from("sms_consent_records")
        .upsert(consentRecords.slice(i, i + BATCH), {
          onConflict:      "club_id,email",
          ignoreDuplicates: false,          // update import_batch on re-run
        });
      if (error) throw new Error(`insert consent records (batch ${i}): ${error.message}`);
      consentInserted += consentRecords.slice(i, i + BATCH).length;
    }

    // ── 4. Update players ─────────────────────────────────────────────────────
    // 4a. phone_fill rows — set phone, sms_opt_in, consent_source, sms_consented_at
    // 4b. consent_only rows — set sms_opt_in, consent_source, sms_consented_at (phone unchanged)
    // NEVER touch conflict rows.
    let playerUpdates = 0;

    const toUpdate = results.filter(r => r.action === "phone_fill" || r.action === "consent_only");
    for (const r of toUpdate) {
      const update: Record<string, any> = {
        sms_opt_in:       true,
        consent_source:   "web_form",
        sms_consented_at: r.row.consentedAt,
      };
      if (r.action === "phone_fill") {
        update.phone = r.row.phoneE164;
      }
      const { error } = await supabase
        .from("players")
        .update(update)
        .eq("id", r.playerId!);
      if (error) {
        logger.warn({ playerId: r.playerId, err: error.message }, "[consent/import] player update failed");
        continue;
      }
      playerUpdates++;
    }

    logger.info({ stats, importBatch, consentInserted, playerUpdates }, "[consent/import] import complete");

    res.json({
      dry_run:          false,
      import_batch:     importBatch,
      consent_records:  consentInserted,
      player_updates:   playerUpdates,
      stats,
      conflicts: results
        .filter(r => r.action === "conflict_skip")
        .map(r => ({
          // Mask to avoid echoing full PII
          email_masked: r.row.email[0] + "***@" + r.row.email.split("@")[1],
          note: "existing phone retained; CSV number NOT written; flag for manual review",
        })),
    });

  } catch (err: any) {
    logger.error({ err }, "[consent/import] error");
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/consent/records ──────────────────────────────────────────────────

router.get("/consent/records", async (req, res) => {
  const clubId = req.query.clubId as string;
  if (!clubId) { res.status(400).json({ error: "clubId required" }); return; }

  const { data, error } = await supabase
    .from("sms_consent_records")
    .select("id, player_id, matched, consent_source, import_batch, consented_at, created_at")
    .eq("club_id", clubId)
    .order("consented_at", { ascending: false })
    .limit(500);

  if (error) { res.status(500).json({ error: error.message }); return; }

  const total    = (data ?? []).length;
  const matched  = (data ?? []).filter((r: any) => r.matched).length;
  const leads    = total - matched;

  res.json({ total, matched, leads, records: data ?? [] });
});

export default router;
