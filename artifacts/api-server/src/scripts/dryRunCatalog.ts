/**
 * Dry-run: read historical fill from the event_fill table and print a
 * per-archetype, per-slot (daily_peak × season) utilization catalog.
 *
 * Source: event_fill (fill_rate = final_signups / total_teams, pre-computed)
 *   - is_canceled = true rows EXCLUDED from all averages
 *   - fill_rate IS NULL rows EXCLUDED (totalTeams was 0)
 *   - archetype_id IS NULL rows shown in an UNCLASSIFIED section
 *
 * No PodPlay API calls. No upcoming-events data. Historical completed events only.
 *
 *   npx tsx src/scripts/dryRunCatalog.ts
 */

import { createClient } from "@supabase/supabase-js";
import { loadArchetypes } from "../lib/classifyEvent";

const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface FillRow {
  event_id: string;
  archetype_id: string | null;
  fill_rate: number;
  total_teams: number;
  final_signups: number;
  is_daily_peak: boolean;
  is_peak_season: boolean;
  start_time: string;
}

interface SlotStats {
  n: number;
  rates: number[];
}

type SlotMap = Map<string, SlotStats>; // key: "dp=T|ps=T" etc.

function slotKey(dp: boolean, ps: boolean): string {
  return `dp=${dp ? "Y" : "N"} | season=${ps ? "peak" : "off_peak"}`;
}

function mean(rates: number[]): number {
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function confidenceLabel(n: number): string {
  if (n >= 20) return "";
  if (n >= 5) return " ⚠ low-confidence";
  return " ⚠ THIN (<5 events)";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(72));
  console.log("PB Club — Program Catalog  |  Historical Fill from event_fill");
  console.log("Source: completed past events only (is_canceled=false, fill_rate IS NOT NULL)");
  console.log("=".repeat(72));

  // 1. Load archetypes
  const archetypes = await loadArchetypes(CLUB_ID);
  console.log(`\n✓ ${archetypes.length} archetypes loaded from DB\n`);

  // 2. Read all non-canceled, non-null fill rows
  const allRows: FillRow[] = [];
  let page = 0;
  while (true) {
    const { data, error } = await sb
      .from("event_fill")
      .select("event_id, archetype_id, fill_rate, total_teams, final_signups, is_daily_peak, is_peak_season, start_time")
      .eq("club_id", CLUB_ID)
      .eq("is_canceled", false)
      .not("fill_rate", "is", null)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error) { console.error("❌ event_fill read failed:", error.message); process.exit(1); }
    if (!data?.length) break;
    allRows.push(...(data as FillRow[]));
    if (data.length < 1000) break;
    page++;
  }

  console.log(`✓ ${allRows.length} completed events loaded from event_fill`);

  const classifiedRows   = allRows.filter((r) => r.archetype_id !== null);
  const unclassifiedRows = allRows.filter((r) => r.archetype_id === null);

  console.log(`  Classified (have archetype_id): ${classifiedRows.length}`);
  console.log(`  Unclassified (null archetype_id): ${unclassifiedRows.length}\n`);

  // 3. Group by archetype_id → slot
  const byArch = new Map<string, SlotMap>();
  for (const arch of archetypes) byArch.set(arch.id, new Map());

  for (const row of classifiedRows) {
    const slotMap = byArch.get(row.archetype_id!);
    if (!slotMap) continue; // archetype not in current DB (deleted or different club)
    const key = slotKey(row.is_daily_peak, row.is_peak_season);
    if (!slotMap.has(key)) slotMap.set(key, { n: 0, rates: [] });
    const slot = slotMap.get(key)!;
    slot.n++;
    // Clamp to 1.0: 2 known overbookings (post-signup court edits in PodPlay).
    // Count as full — cap, don't drop, so n stays accurate.
    slot.rates.push(Math.min(row.fill_rate, 1.0));
  }

  // 4. Print catalog
  console.log("─".repeat(72));
  console.log("ARCHETYPE CATALOG  (historical fill, completed events)");
  console.log("─".repeat(72));

  for (const arch of archetypes) {
    const slotMap = byArch.get(arch.id)!;
    const totalN   = [...slotMap.values()].reduce((s, v) => s + v.n, 0);
    const allRates = [...slotMap.values()].flatMap((v) => v.rates);
    const overallFill = allRates.length ? fmtPct(mean(allRates)) : "—";

    const typeTag = arch.canonical_type === "clinic" ? "CLINIC   " : "OPEN PLAY";
    console.log(
      `\n[${typeTag}] ${arch.canonical_name}` +
      `  (priority ${arch.match_priority}${arch.overrides_podplay_type ? ", overrides type" : ""})`,
    );
    console.log(
      `  Total completed events: ${totalN}   Overall mean fill: ${overallFill}` +
      `${totalN > 0 ? confidenceLabel(totalN) : ""}`,
    );

    if (totalN === 0) {
      console.log("  (no historical events in event_fill for this archetype)");
      continue;
    }

    // Print each slot sorted for readability
    const slotOrder = [
      slotKey(true,  true),
      slotKey(true,  false),
      slotKey(false, true),
      slotKey(false, false),
    ];

    for (const key of slotOrder) {
      const slot = slotMap.get(key);
      if (!slot || slot.n === 0) continue;
      const slotMean = fmtPct(mean(slot.rates));
      const minFill  = fmtPct(Math.min(...slot.rates));
      const maxFill  = fmtPct(Math.max(...slot.rates));
      console.log(
        `    ${key.padEnd(28)}  n=${String(slot.n).padStart(3)}  ` +
        `mean=${slotMean.padStart(6)}  [min=${minFill}, max=${maxFill}]` +
        confidenceLabel(slot.n),
      );
    }
  }

  // 5. Unclassified summary (null archetype_id — not classified by eventFillSync)
  console.log("\n" + "─".repeat(72));
  console.log(`UNCLASSIFIED (archetype_id IS NULL)  —  ${unclassifiedRows.length} events`);
  console.log("─".repeat(72));
  if (unclassifiedRows.length === 0) {
    console.log("  ✅ None — all non-excluded events are classified.");
  } else {
    const totalFill = mean(unclassifiedRows.map((r) => r.fill_rate));
    console.log(`  Overall mean fill for unclassified: ${fmtPct(totalFill)}`);
    console.log("  (These events had no matching archetype at fetch time; re-run backfill after keyword patches)");
  }

  console.log("\n" + "=".repeat(72));
  console.log("Eyeball checkpoint done. No DB writes. No PodPlay API calls.");
  console.log("=".repeat(72));
}

main().catch((err) => { console.error(err); process.exit(1); });
