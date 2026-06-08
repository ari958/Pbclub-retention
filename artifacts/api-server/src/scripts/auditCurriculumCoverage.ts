/**
 * auditCurriculumCoverage.ts — READ-ONLY curriculum flow data audit.
 *
 * Answers open question 3 from the Curriculum Flow spec:
 * "Does our attendance data have enough rung signal to support the feature?"
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/auditCurriculumCoverage.ts
 *
 * No writes. Safe to run repeatedly.
 */

import { supabase } from "../lib/supabaseClient.js";
import {
  RUNG_CONFIG,
  loadTaxonomy,
  resolveAttendanceRung,
  type AttendanceForRung,
  type TaxonomyEntry,
} from "../lib/curriculumFlow.js";
import {
  detectStall,
  detectRetreat,
  type TimelineEntry,
} from "../lib/curriculumDetectors.js";

const CLUB_ID = process.env.CLUB_ID ?? "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const PAGE = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

type ResolutionMethod = "tag_hit" | "keyword_fallback" | "unresolved";

function classifyAttendance(
  att: AttendanceForRung,
  taxonomy: TaxonomyEntry[]
): { rung: TaxonomyEntry | null; method: ResolutionMethod } {
  const byLevel = new Map(taxonomy.map((t) => [t.level, t]));

  // Priority 1 — explicit tag
  const tag = att.level;
  if (tag !== null && tag !== undefined && !RUNG_CONFIG.noRungTags.has(tag)) {
    const entry = byLevel.get(tag);
    if (entry) return { rung: entry, method: "tag_hit" };
  }

  // Priority 2 — keyword fallback
  const name = att.program_name;
  if (name) {
    for (const { pattern, level } of RUNG_CONFIG.keywordMap) {
      if (pattern.test(name)) {
        const entry = byLevel.get(level);
        if (entry) return { rung: entry, method: "keyword_fallback" };
      }
    }
  }

  return { rung: null, method: "unresolved" };
}

// ─── Paginated fetchers ───────────────────────────────────────────────────────

async function fetchAllPlayers() {
  const players: { id: string; coach_assigned_level: string | null }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, coach_assigned_level")
      .eq("club_id", CLUB_ID)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetchAllPlayers: ${error.message}`);
    players.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }
  return players;
}

// attendances.club_id is NULL on all rows (syncEventAttendance never writes it).
// Scope to this club by filtering in-memory against the known player-ID set.
async function fetchAllAttendances(playerIdSet: Set<string>) {
  const rows: { player_id: string; attended_at: string; level: string | null; program_name: string | null; event_id: string | null }[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("player_id, attended_at, level, program_name, event_id")
      .order("attended_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetchAllAttendances: ${error.message}`);
    for (const row of data ?? []) {
      if (playerIdSet.has(row.player_id as string)) rows.push(row as typeof rows[0]);
    }
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n════════════════════════════════════════════════════════");
  console.log("  Curriculum Flow — Coverage Audit");
  console.log(`  Club: ${CLUB_ID}`);
  console.log(`  Run:  ${new Date().toISOString()}`);
  console.log("════════════════════════════════════════════════════════\n");

  // ── 1. Taxonomy ─────────────────────────────────────────────────────────────
  const taxonomy = await loadTaxonomy(CLUB_ID);
  console.log("── Taxonomy ──────────────────────────────────────────");
  taxonomy.forEach((t) => console.log(`  rank ${t.rank}: ${t.level}`));
  console.log();

  // ── 2. Players ──────────────────────────────────────────────────────────────
  console.log("── Players ───────────────────────────────────────────");
  const players = await fetchAllPlayers();
  const totalPlayers = players.length;
  const withLevel    = players.filter((p) => p.coach_assigned_level !== null);
  console.log(`  Total players:                ${totalPlayers}`);
  console.log(`  With coach_assigned_level:    ${withLevel.length}  (${pct(withLevel.length, totalPlayers)})`);
  console.log(`  Without coach_assigned_level: ${totalPlayers - withLevel.length}  (${pct(totalPlayers - withLevel.length, totalPlayers)})`);
  console.log();

  // ── 3. coach_assigned_level distribution ────────────────────────────────────
  console.log("── coach_assigned_level distribution ─────────────────");
  const levelDist = new Map<string, number>();
  for (const p of withLevel) {
    const l = p.coach_assigned_level!;
    levelDist.set(l, (levelDist.get(l) ?? 0) + 1);
  }
  // Sort by taxonomy rank
  const rankOrder = new Map(taxonomy.map((t) => [t.level, t.rank]));
  const sortedLevels = [...levelDist.entries()].sort(
    ([a], [b]) => (rankOrder.get(a) ?? 99) - (rankOrder.get(b) ?? 99)
  );
  for (const [level, count] of sortedLevels) {
    const rank = rankOrder.get(level);
    const rankStr = rank !== undefined ? `rank ${rank}` : "unranked";
    console.log(`  ${level.padEnd(28)} (${rankStr}): ${count}  (${pct(count, totalPlayers)})`);
  }
  // Any level strings not in taxonomy
  const unknownLevels = [...levelDist.keys()].filter((l) => !rankOrder.has(l));
  if (unknownLevels.length) {
    console.log(`  ⚠ Unknown levels (not in taxonomy): ${unknownLevels.join(", ")}`);
  }
  console.log();

  // ── 4. Attendances — resolution breakdown ───────────────────────────────────
  console.log("── Attendance rung resolution ────────────────────────");
  const playerIdSet = new Set(players.map((p) => p.id));
  const allAtts = await fetchAllAttendances(playerIdSet);
  console.log(`  Total attendance rows:   ${allAtts.length}`);

  let tagHit = 0, keywordFallback = 0, unresolved = 0;
  const timelinesByPlayer = new Map<string, TimelineEntry[]>();

  for (const att of allAtts) {
    const { rung, method } = classifyAttendance(
      { level: att.level, program_name: att.program_name },
      taxonomy
    );
    if (method === "tag_hit")          tagHit++;
    else if (method === "keyword_fallback") keywordFallback++;
    else                               unresolved++;

    if (rung) {
      const existing = timelinesByPlayer.get(att.player_id) ?? [];
      existing.push({
        attended_at: att.attended_at,
        level:       rung.level,
        rank:        rung.rank,
        event_id:    att.event_id,
      });
      timelinesByPlayer.set(att.player_id, existing);
    }
  }

  const totalAtts = allAtts.length;
  console.log(`  Tag hit:         ${String(tagHit).padStart(6)}  (${pct(tagHit, totalAtts)})`);
  console.log(`  Keyword fallback:${String(keywordFallback).padStart(6)}  (${pct(keywordFallback, totalAtts)})`);
  console.log(`  Unresolved:      ${String(unresolved).padStart(6)}  (${pct(unresolved, totalAtts)})`);
  console.log();

  // ── 5. Stall / Retreat coverage ─────────────────────────────────────────────
  console.log("── Player timeline depth ─────────────────────────────");
  let playersWithTimeline     = 0;
  let playersEnoughForStall   = 0;  // ≥4 resolved attendances
  let playersNoTimeline       = 0;

  for (const p of players) {
    const tl = timelinesByPlayer.get(p.id) ?? [];
    if (tl.length === 0)  { playersNoTimeline++;      continue; }
    playersWithTimeline++;
    if (tl.length >= 4)   { playersEnoughForStall++;             }
  }

  console.log(`  Players with ≥1 resolved attendance:  ${playersWithTimeline}  (${pct(playersWithTimeline, totalPlayers)})`);
  console.log(`  Players with ≥4 resolved attendances: ${playersEnoughForStall}  (${pct(playersEnoughForStall, totalPlayers)})  ← stall detector meaningful`);
  console.log(`  Players with no resolved attendances: ${playersNoTimeline}  (${pct(playersNoTimeline, totalPlayers)})`);
  console.log();

  // ── 6. Dry-run detectors across all players ─────────────────────────────────
  console.log("── Detector dry-run (in-memory, no writes) ───────────");
  let stallCount   = 0;
  let retreatCount = 0;

  const stallDetails:   string[] = [];
  const retreatDetails: string[] = [];

  for (const p of players) {
    const tl = timelinesByPlayer.get(p.id) ?? [];
    if (tl.length === 0) continue;

    const stall   = detectStall(tl);
    const retreat = detectRetreat(tl);

    if (stall.stalled) {
      stallCount++;
      if (stallDetails.length < 5) {
        stallDetails.push(
          `    player=${p.id}  rank=${stall.rank}  sessions=${stall.sessionsAtRank}  daysAtRank=${stall.daysAtRank}`
        );
      }
    }
    if (retreat.retreated) {
      retreatCount++;
      if (retreatDetails.length < 5) {
        retreatDetails.push(
          `    player=${p.id}  peak=${retreat.peakRank}→current=${retreat.currentRank}  sessionsSince=${retreat.sessionsSinceRetreat}  retreatedAt=${retreat.retreatedAt}`
        );
      }
    }
  }

  const playersChecked = players.filter((p) => (timelinesByPlayer.get(p.id) ?? []).length > 0).length;
  console.log(`  Players checked (≥1 resolved attendance): ${playersChecked}`);
  console.log(`  Stall flag:    ${stallCount}  (${pct(stallCount, playersChecked)})  [minSessions=4, windowDays=60]`);
  if (stallDetails.length) {
    console.log("  First stall examples:");
    stallDetails.forEach((l) => console.log(l));
  }
  console.log(`  Retreat flag:  ${retreatCount}  (${pct(retreatCount, playersChecked)})  [minSessions@peak=2, minSinceRetreat=2]`);
  if (retreatDetails.length) {
    console.log("  First retreat examples:");
    retreatDetails.forEach((l) => console.log(l));
  }
  console.log();

  // ── 7. Summary verdict ──────────────────────────────────────────────────────
  console.log("── Summary verdict ───────────────────────────────────");
  const tagCoverage = pct(tagHit, totalAtts);
  const resolvedCoverage = pct(tagHit + keywordFallback, totalAtts);
  console.log(`  Overall rung resolution rate: ${resolvedCoverage}  (tag: ${tagCoverage}, keyword: ${pct(keywordFallback, totalAtts)})`);
  console.log(`  Players with enough history for stall detection: ${playersEnoughForStall} / ${totalPlayers}`);
  const verdict =
    parseFloat(resolvedCoverage) >= 60 && playersEnoughForStall >= 5
      ? "✅  Data is sufficient to support Curriculum Flow feature build."
      : "⚠   Data coverage is low — review RUNG_CONFIG keyword patterns before proceeding.";
  console.log(`  Verdict: ${verdict}`);
  console.log("\n════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
