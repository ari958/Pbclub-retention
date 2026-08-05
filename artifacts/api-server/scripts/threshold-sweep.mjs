/**
 * Threshold Sweep — Phase 2.2 Item 3
 *
 * Runs the backtest across a grid of offsets × thresholds, segmented by
 * program type (Clinics vs Open Play). Saves full grid to
 * /tmp/phase22/threshold-sweep.csv and prints a human-readable report.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node threshold-sweep.mjs [clubId]
 *   (clubId defaults to first row in clubs table)
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Config ─────────────────────────────────────────────────────────────────────
const OFFSETS     = [2, 3, 4, 6, 12, 24];   // hours before start
const THRESHOLDS  = [2, 3, 4, 5, 6, 7, 8];  // min_signups (N)
const DAYS        = 120;
const COVERAGE_THRESHOLD = 0.9;
const UNDERCOUNT_RATIO   = 0.70;

// Program-type classifier (mirrors backtest endpoint logic)
function progType(archName) {
  const lc = (archName || "").toLowerCase();
  if (lc.includes("clinic") || lc.includes("learn") || lc.includes("junior")) return "Clinics";
  return "Open Play";
}

// ── 1. Resolve clubId ─────────────────────────────────────────────────────────
async function getClubId() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const { data, error } = await supabase.from("clubs").select("id, name").limit(1).single();
  if (error || !data) { console.error("Cannot resolve clubId:", error?.message); process.exit(1); }
  console.log(`Using club: ${data.name} (${data.id})`);
  return data.id;
}

// ── 2. Load event_fill rows ────────────────────────────────────────────────────
async function loadFillRows(clubId, cutoff, nowIso) {
  const rows = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from("event_fill")
      .select("event_id, archetype_id, final_signups, total_teams, fill_rate, start_time")
      .eq("club_id", clubId)
      .eq("is_canceled", false)
      .not("archetype_id", "is", null)
      .gte("start_time", cutoff)
      .lt("start_time", nowIso)
      .range(page * 500, (page + 1) * 500 - 1);
    if (error) throw new Error(`event_fill load: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 500) break;
    page++;
  }
  return rows;
}

// ── 3. Load archetype names ────────────────────────────────────────────────────
async function loadArchetypeNames(clubId) {
  const { data } = await supabase.from("programs").select("id, canonical_name").eq("club_id", clubId);
  return new Map((data ?? []).map((a) => [a.id, a.canonical_name]));
}

// ── 4. Load attendances (booked_at) ───────────────────────────────────────────
async function loadAttendances(allEventIds) {
  const attMap = new Map();
  const ID_CHUNK = 200, ATT_PAGE = 1000;
  for (let ci = 0; ci < allEventIds.length; ci += ID_CHUNK) {
    const chunk = allEventIds.slice(ci, ci + ID_CHUNK);
    let ap = 0;
    while (true) {
      const { data: batch, error } = await supabase
        .from("attendances")
        .select("event_id, booked_at, program_name")
        .in("event_id", chunk)
        .range(ap * ATT_PAGE, (ap + 1) * ATT_PAGE - 1);
      if (error || !batch?.length) break;
      for (const row of batch) {
        const eid = row.event_id;
        if (!attMap.has(eid)) attMap.set(eid, { total: 0, withBookedAt: 0, times: [], programName: null });
        const c = attMap.get(eid);
        c.total++;
        if (row.booked_at) {
          c.withBookedAt++;
          c.times.push(new Date(row.booked_at).getTime());
        }
        if (!c.programName && row.program_name) c.programName = row.program_name;
      }
      if (batch.length < ATT_PAGE) break;
      ap++;
    }
  }
  return attMap;
}

// ── 5. Identify excluded archetypes (undercount) ──────────────────────────────
function buildExcludedArchetypes(fillRows, attMap, archetypeNames) {
  const ratioMap = new Map();
  for (const fill of fillRows) {
    if (!fill.archetype_id || !fill.final_signups || fill.final_signups <= 0) continue;
    const localCount = attMap.get(fill.event_id)?.total ?? 0;
    const ratio = localCount / fill.final_signups;
    if (!ratioMap.has(fill.archetype_id)) {
      ratioMap.set(fill.archetype_id, { name: archetypeNames.get(fill.archetype_id) ?? fill.archetype_id.slice(0, 8), ratios: [] });
    }
    ratioMap.get(fill.archetype_id).ratios.push(ratio);
  }

  const excluded = new Set();
  const summary = {};
  for (const [aid, { name, ratios }] of ratioMap) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    summary[name] = { median: Math.round(median * 1000) / 1000, n: ratios.length, excluded: median < UNDERCOUNT_RATIO };
    if (median < UNDERCOUNT_RATIO) excluded.add(aid);
  }
  return { excluded, summary };
}

// ── 6. Single checkpoint evaluation ──────────────────────────────────────────
function evalCheckpoint(fillRows, attMap, archetypeNames, excluded, offsetHours, minSignups) {
  // Results keyed by program type
  const byType = {};
  let totalEval = 0, totalFire = 0, totalTP = 0, totalFP = 0;
  let skipped = { coverage: 0, undercount: 0, noData: 0 };
  const usableRowCounts = [];

  for (const fill of fillRows) {
    if (fill.final_signups === null || fill.final_signups === undefined) continue;
    if (excluded.has(fill.archetype_id)) { skipped.undercount++; continue; }

    const att = attMap.get(fill.event_id);
    if (!att || att.total === 0) { skipped.noData++; continue; }
    const coverage = att.withBookedAt / att.total;
    if (coverage < COVERAGE_THRESHOLD) { skipped.coverage++; continue; }

    const startMs   = new Date(fill.start_time).getTime();
    const cutoffMs  = startMs - offsetHours * 3_600_000;
    const signupAt  = att.times.filter((t) => t <= cutoffMs).length;
    const fires     = signupAt < minSignups;
    const finalCount = fill.final_signups;
    const isTP = fires && finalCount < minSignups;
    const isFP = fires && finalCount >= minSignups;

    const archName = archetypeNames.get(fill.archetype_id) ?? "Unknown";
    const pt = progType(archName);
    if (!byType[pt]) byType[pt] = { evaluated: 0, wouldFire: 0, tp: 0, fp: 0 };
    const s = byType[pt];

    totalEval++; s.evaluated++;
    usableRowCounts.push(att.total);
    if (fires) {
      totalFire++; s.wouldFire++;
      if (isTP) { totalTP++; s.tp++; }
      if (isFP) { totalFP++; s.fp++; }
    }
  }

  const sortedUR = [...usableRowCounts].sort((a, b) => a - b);
  const medUR = sortedUR.length ? sortedUR[Math.floor(sortedUR.length / 2)] : null;

  return {
    evaluated:    totalEval,
    would_fire:   totalFire,
    tp:           totalTP,
    fp:           totalFP,
    fp_rate:      totalFire > 0 ? Math.round(totalFP / totalFire * 1000) / 1000 : null,
    median_rows:  medUR,
    skipped,
    by_type:      byType,
  };
}

// ── 7. Format helpers ─────────────────────────────────────────────────────────
function pct(n) { return n === null ? "N/A" : `${Math.round(n * 100)}%`; }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const clubId = await getClubId();
  const nowIso  = new Date().toISOString();
  const cutoff  = new Date(Date.now() - DAYS * 86_400_000).toISOString();

  console.log(`\nLoading ${DAYS}-day event_fill window…`);
  const fillRows = await loadFillRows(clubId, cutoff, nowIso);
  console.log(`  ${fillRows.length} rows loaded`);

  console.log("Loading archetype names…");
  const archetypeNames = await loadArchetypeNames(clubId);

  const allEventIds = [...new Set(fillRows.map((r) => r.event_id))];
  console.log(`Loading attendances for ${allEventIds.length} events…`);
  const attMap = await loadAttendances(allEventIds);
  console.log(`  attendance data for ${attMap.size} events`);

  const { excluded, summary: archetypeSummary } = buildExcludedArchetypes(fillRows, attMap, archetypeNames);
  console.log("\nArchetype local/PodPlay ratio summary:");
  for (const [name, s] of Object.entries(archetypeSummary)) {
    console.log(`  ${name}: median=${s.median} n=${s.n} ${s.excluded ? "⚠ EXCLUDED (undercount)" : "✓"}`);
  }
  console.log();

  // ── Run grid ───────────────────────────────────────────────────────────────
  const grid = [];   // rows for CSV
  const results = new Map();  // key = `${offset}_${n}` → result

  console.log("Running sweep…");
  for (const offset of OFFSETS) {
    for (const n of THRESHOLDS) {
      const r = evalCheckpoint(fillRows, attMap, archetypeNames, excluded, offset, n);
      results.set(`${offset}_${n}`, r);

      for (const [pt, s] of Object.entries(r.by_type)) {
        grid.push({
          offset_hours:     offset,
          min_signups:      n,
          program_type:     pt,
          evaluated:        s.evaluated,
          would_fire:       s.wouldFire,
          tp:               s.tp,
          fp:               s.fp,
          fp_rate:          s.wouldFire > 0 ? Math.round(s.fp / s.wouldFire * 1000) / 1000 : null,
          median_rows:      r.median_rows,
          skipped_coverage: r.skipped.coverage,
          skipped_undercount: r.skipped.undercount,
          skipped_no_data:  r.skipped.noData,
        });
      }
      // Also add an "All" row
      grid.push({
        offset_hours:     offset,
        min_signups:      n,
        program_type:     "All",
        evaluated:        r.evaluated,
        would_fire:       r.would_fire,
        tp:               r.tp,
        fp:               r.fp,
        fp_rate:          r.fp_rate,
        median_rows:      r.median_rows,
        skipped_coverage: r.skipped.coverage,
        skipped_undercount: r.skipped.undercount,
        skipped_no_data:  r.skipped.noData,
      });
    }
  }

  // ── Save CSV ───────────────────────────────────────────────────────────────
  mkdirSync("/tmp/phase22", { recursive: true });
  const headers = Object.keys(grid[0] ?? {});
  const csvLines = [
    headers.join(","),
    ...grid.map((row) => headers.map((h) => {
      const v = row[h];
      return v === null || v === undefined ? "" : String(v);
    }).join(",")),
  ];
  writeFileSync("/tmp/phase22/threshold-sweep.csv", csvLines.join("\n"), "utf8");
  console.log("Saved: /tmp/phase22/threshold-sweep.csv");

  // ── Print report ───────────────────────────────────────────────────────────

  // Print grid header
  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("  THRESHOLD SWEEP — Phase 2.2 Item 3");
  console.log("══════════════════════════════════════════════════════════════════════");

  for (const pt of ["Open Play", "Clinics", "All"]) {
    console.log(`\n── ${pt} ──`);
    const header = ["T\\N", ...THRESHOLDS.map((n) => `N=${n}`)].join("\t");
    console.log(header);

    for (const offset of OFFSETS) {
      const cells = THRESHOLDS.map((n) => {
        const r = results.get(`${offset}_${n}`);
        if (!r) return "—";
        if (pt === "All") {
          const fpR = r.fp_rate;
          return fpR === null ? `0fired` : `${pct(fpR)}(${r.fp}FP/${r.would_fire})`;
        } else {
          const s = r.by_type[pt];
          if (!s || s.wouldFire === 0) return `0fired`;
          const fpR = s.fp / s.wouldFire;
          return `${pct(fpR)}(${s.fp}FP/${s.wouldFire})`;
        }
      });
      console.log([`T-${offset}h`, ...cells].join("\t"));
    }
  }

  // ── Q1: FP rate at N=4/T-3h ────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════════════");
  console.log("  DIRECT ANSWERS");
  console.log("══════════════════════════════════════════════════════════════════════");

  const live = results.get("3_4");
  console.log(`\nQ1 — FP rate at live config N=4/T-3h:`);
  if (live) {
    console.log(`  All:       FP rate=${pct(live.fp_rate)}  (${live.fp} FP / ${live.would_fire} fired / ${live.evaluated} evaluated)`);
    console.log(`  Median rows/event: ${live.median_rows}`);
    for (const [pt, s] of Object.entries(live.by_type)) {
      const fpr = s.wouldFire > 0 ? s.fp / s.wouldFire : null;
      console.log(`  ${pt}: FP rate=${pct(fpr)}  (${s.fp} FP / ${s.wouldFire} fired / ${s.evaluated} evaluated)`);
    }
  } else {
    console.log("  No data for N=4/T-3h");
  }

  // ── Q2: Best threshold per program type ───────────────────────────────────
  console.log(`\nQ2 — Best threshold minimizing FP while still catching dead sessions:`);
  for (const pt of ["Open Play", "Clinics"]) {
    let best = null, bestFP = Infinity, bestFPRate = 1;
    for (const offset of OFFSETS) {
      for (const n of THRESHOLDS) {
        const r = results.get(`${offset}_${n}`);
        if (!r) continue;
        const s = r.by_type[pt];
        if (!s || s.wouldFire === 0) continue;
        const fpRate = s.fp / s.wouldFire;
        const tp = s.tp;
        // Prefer lower FP rate; tie-break on more TPs caught
        if (tp > 0 && (fpRate < bestFPRate || (fpRate === bestFPRate && s.fp < bestFP))) {
          bestFPRate = fpRate;
          bestFP = s.fp;
          best = { offset, n, tp, fp: s.fp, wouldFire: s.wouldFire, evaluated: s.evaluated, fpRate };
        }
      }
    }
    if (best) {
      console.log(`  ${pt}: N=${best.n}/T-${best.offset}h  → FP=${pct(best.fpRate)} (${best.fp}/${best.wouldFire}), TP=${best.tp}`);
    } else {
      console.log(`  ${pt}: No combination fires — insufficient data or all thresholds too high`);
    }
  }

  // ── Q3: Do Clinics and Open Play differ? ───────────────────────────────────
  console.log(`\nQ3 — Do Clinics and Open Play need different rules?`);
  const liveOP  = live?.by_type["Open Play"];
  const liveCL  = live?.by_type["Clinics"];
  const fprOP   = liveOP && liveOP.wouldFire > 0 ? liveOP.fp / liveOP.wouldFire : null;
  const fprCL   = liveCL && liveCL.wouldFire > 0 ? liveCL.fp / liveCL.wouldFire : null;
  console.log(`  At N=4/T-3h:`);
  console.log(`    Open Play: FP=${pct(fprOP)}  (${liveOP?.fp ?? 0} FP / ${liveOP?.wouldFire ?? 0} fired / ${liveOP?.evaluated ?? 0} evaluated)`);
  console.log(`    Clinics:   FP=${pct(fprCL)}  (${liveCL?.fp ?? 0} FP / ${liveCL?.wouldFire ?? 0} fired / ${liveCL?.evaluated ?? 0} evaluated)`);

  // ── Validation hint ────────────────────────────────────────────────────────
  console.log("\n── Reconstruction validation ──");
  if (live && live.fp_rate !== null && live.fp_rate < 0.05 && live.evaluated > 5) {
    console.log("  ⚠ WARNING: FP rate near zero for N=4/T-3h — reconstruction may still be broken.");
    console.log("    Expected ~44% from Phase 0.6 baseline.");
  } else if (live) {
    console.log(`  ✓ FP rate at N=4/T-3h = ${pct(live.fp_rate)} (Phase 0.6 baseline: ~44%)`);
  }

  console.log("\nDone.\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
