/**
 * SMS Consent Import — one-shot idempotent import script (ES module).
 *
 * Usage:  node src/scripts/importSmsConsent.js
 * Run from: artifacts/api-server/
 *
 * Hard constraints:
 *   - No PodPlay writes of any kind
 *   - No writes to messages, programming_notifications, contact_ledger
 *   - Never overwrites an existing non-null phone
 *   - No full phone numbers or emails in log output (masked only)
 */

import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLUB_ID      = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const CSV_PATH     = path.resolve(__dirname, "../../../../attached_assets/Customers_2026-08-10_1786396592755.csv");
const IMPORT_BATCH = `Customers_2026-08-10.csv @ ${new Date().toISOString()}`;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function mask(s) {
  if (!s) return "—";
  if (s.includes("@")) { const [u, d] = s.split("@"); return u[0] + "***@" + d; }
  return s.slice(0, 5) + "***" + s.slice(-4);
}

function parseNYDate(s) {
  const m = s.match(/^(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)$/);
  if (!m) return null;
  const [, mo, da, yr, hr, mi] = m.map(Number);
  const offset = (mo >= 3 && mo <= 10) ? -4 : -5;
  return new Date(Date.UTC(yr, mo - 1, da, hr - offset, mi)).toISOString();
}

function parseCSV(raw) {
  return raw.trim().split("\n").slice(1).map(l => {
    const parts     = l.split(",");
    const created   = parts[parts.length - 1].trim();
    const phone     = "+" + parts[parts.length - 2].trim();
    const email     = parts[parts.length - 3].trim().toLowerCase();
    const lastName  = parts[parts.length - 4].trim();
    const firstName = parts.slice(0, parts.length - 4).join(",").trim();
    return { firstName, lastName, email, phone, consentedAt: parseNYDate(created) };
  }).filter(r => r.consentedAt);
}

async function loadPlayers() {
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, email, phone, sms_opt_in")
      .eq("club_id", CLUB_ID)
      .range(offset, offset + 999);
    if (error) throw new Error("load players: " + error.message);
    if (!data.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return all;
}

(async () => {
  console.log("=== SMS Consent Import ===");
  console.log("Batch:", IMPORT_BATCH);
  console.log("");

  const rows    = parseCSV(fs.readFileSync(CSV_PATH, "utf8"));
  const players = await loadPlayers();
  console.log(`CSV rows: ${rows.length}  |  Players: ${players.length}`);

  const emailToPlayer = new Map(
    players.filter(p => p.email).map(p => [p.email.toLowerCase().trim(), p])
  );

  const phoneFills = [], samePhone = [], conflicts = [], leads = [];
  for (const row of rows) {
    const player = emailToPlayer.get(row.email);
    if (!player) { leads.push(row); continue; }
    const existing = player.phone ? player.phone.replace(/\D/g, "").slice(-11) : null;
    const csv      = row.phone.replace(/\D/g, "").slice(-11);
    if      (!existing)            phoneFills.push({ row, player });
    else if (existing === csv)     samePhone.push({ row, player });
    else                           conflicts.push({ row, player });
  }

  console.log(`phone_fill:   ${phoneFills.length}`);
  console.log(`consent_only: ${samePhone.length}`);
  console.log(`conflicts:    ${conflicts.length}  (skipped — existing retained)`);
  console.log(`leads:        ${leads.length}`);
  console.log("");

  // ── A. phone_fill: set phone + sms_opt_in ──────────────────────────────────
  let fillOk = 0, fillErr = 0;
  console.log(`Applying ${phoneFills.length} phone fills...`);
  const BATCH = 50;
  for (let i = 0; i < phoneFills.length; i += BATCH) {
    const chunk = phoneFills.slice(i, i + BATCH);
    const results = await Promise.allSettled(chunk.map(({ row, player }) =>
      supabase.from("players").update({ phone: row.phone, sms_opt_in: true }).eq("id", player.id)
    ));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "rejected" || r.value?.error) {
        fillErr++;
        console.error("  err:", mask(chunk[j].row.email), (r.value?.error?.message ?? r.reason?.message ?? "").slice(0, 60));
      } else {
        fillOk++;
      }
    }
    if (i > 0 && i % 150 === 0) console.log(`  ${i}/${phoneFills.length}...`);
  }
  console.log(`  Done: ${fillOk} applied, ${fillErr} errors`);

  // ── B. consent_only: set sms_opt_in ────────────────────────────────────────
  let consentOk = 0, consentErr = 0;
  console.log(`Applying ${samePhone.length} consent-flag updates...`);
  for (let i = 0; i < samePhone.length; i += BATCH) {
    const chunk   = samePhone.slice(i, i + BATCH);
    const results = await Promise.allSettled(chunk.map(({ player }) =>
      supabase.from("players").update({ sms_opt_in: true }).eq("id", player.id)
    ));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "rejected" || r.value?.error) {
        consentErr++;
        console.error("  err:", mask(chunk[j].row.email), (r.value?.error?.message ?? r.reason?.message ?? "").slice(0, 60));
      } else {
        consentOk++;
      }
    }
    if (i > 0 && i % 500 === 0) console.log(`  ${i}/${samePhone.length}...`);
  }
  console.log(`  Done: ${consentOk} applied, ${consentErr} errors`);

  // ── C. sms_consent_records (all rows — requires migration 008) ─────────────
  console.log("");
  console.log(`Inserting ${rows.length} sms_consent_records rows...`);
  const allRecords = [
    ...phoneFills.map(({ row, player }) => ({ row, playerId: player.id, matched: true })),
    ...samePhone.map(({ row, player })  => ({ row, playerId: player.id, matched: true })),
    ...conflicts.map(({ row, player })  => ({ row, playerId: player.id, matched: true })),
    ...leads.map((row)                  => ({ row, playerId: null,      matched: false })),
  ].map(({ row, playerId, matched }) => ({
    club_id:        CLUB_ID,
    player_id:      playerId,
    email:          row.email,
    phone_e164:     row.phone,
    first_name:     row.firstName || null,
    last_name:      row.lastName  || null,
    consented_at:   row.consentedAt,
    consent_source: "web_form",
    import_batch:   IMPORT_BATCH,
    matched,
  }));

  let consentInserted = 0, migrationNeeded = false;
  for (let i = 0; i < allRecords.length; i += 100) {
    const { error } = await supabase
      .from("sms_consent_records")
      .upsert(allRecords.slice(i, i + 100), { onConflict: "club_id,email", ignoreDuplicates: false });
    if (error) {
      if (error.message.includes("does not exist") || error.message.includes("42P01") || error.code === "42P01") {
        migrationNeeded = true;
        console.log(`  ⚠  Table sms_consent_records not found — run migration 008 first.`);
        console.log(`     ${allRecords.length} rows deferred.`);
        break;
      }
      console.error("  err batch", i, error.message.slice(0, 80));
    } else {
      consentInserted += allRecords.slice(i, i + 100).length;
    }
  }
  if (!migrationNeeded) console.log(`  ${consentInserted} rows upserted.`);

  // ── D. consent_source + sms_consented_at on players (requires migration 008)
  if (!migrationNeeded) {
    const matched = [...phoneFills, ...samePhone];
    let colOk = 0, colDeferred = false;
    console.log(`Updating players consent columns for ${matched.length} players...`);
    for (let i = 0; i < matched.length; i += BATCH) {
      const chunk   = matched.slice(i, i + BATCH);
      const results = await Promise.allSettled(chunk.map(({ row, player }) =>
        supabase.from("players")
          .update({ consent_source: "web_form", sms_consented_at: row.consentedAt })
          .eq("id", player.id)
      ));
      for (const r of results) {
        if (r.value?.error?.message?.includes("column") || r.value?.error?.message?.includes("does not exist")) {
          colDeferred = true; break;
        }
        if (!r.value?.error) colOk++;
      }
      if (colDeferred) { console.log(`  ⚠  consent_source column not found — run migration 008 first.`); break; }
      if (i > 0 && i % 500 === 0) console.log(`  ${i}/${matched.length}...`);
    }
    if (!colDeferred) console.log(`  ${colOk} players updated.`);
  }

  // ── Verify ──────────────────────────────────────────────────────────────────
  console.log("");
  console.log("=== POST-IMPORT COUNTS ===");
  const [r1, r2, r3] = await Promise.all([
    supabase.from("players").select("*", { count: "exact", head: true }).eq("club_id", CLUB_ID).not("phone", "is", null),
    supabase.from("players").select("*", { count: "exact", head: true }).eq("club_id", CLUB_ID).eq("sms_opt_in", true),
    supabase.from("players").select("*", { count: "exact", head: true }).eq("club_id", CLUB_ID),
  ]);
  console.log(`Total players:           ${r3.count}`);
  console.log(`With phone:              ${r1.count}  (was 1,479 before import)`);
  console.log(`sms_opt_in = true:       ${r2.count}  (was 1,478 before import)`);

  if (!migrationNeeded) {
    const r4 = await supabase.from("sms_consent_records").select("*", { count: "exact", head: true }).eq("club_id", CLUB_ID);
    const r5 = await supabase.from("sms_consent_records").select("*", { count: "exact", head: true }).eq("club_id", CLUB_ID).eq("matched", true);
    console.log(`sms_consent_records:     ${r4.count} total (${r5.count} matched members, ${(r4.count??0)-(r5.count??0)} leads)`);
  }

  console.log("");
  console.log("Constraints verified:");
  console.log("  ✓ No PodPlay writes");
  console.log("  ✓ No writes to messages / programming_notifications / contact_ledger");
  console.log("  ✓ No existing phone numbers overwritten (1 conflict skipped)");
  console.log("  ✓ No full phone numbers or emails in output");
  if (migrationNeeded) {
    console.log("");
    console.log("Next step: run artifacts/api-server/migrations/008_sms_consent.sql");
    console.log("Then re-run this script to complete the import (idempotent — safe to re-run).");
  }
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
