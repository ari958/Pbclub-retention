/**
 * seedSyntheticCoachLevels.ts — synthetic coach-level assignments for dev/test.
 *
 * Derives coach_assigned_level from each player's modal booking rank so
 * Curriculum Flow detectors and the confidence ladder have realistic test data.
 * All synthetic rows are clearly marked (source='synthetic') and reversible
 * via wipeSyntheticCoachLevels.ts.
 *
 * NEVER overwrites a real coach assignment. The guard is enforced in both
 * dry-run and apply paths.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/seedSyntheticCoachLevels.ts
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/seedSyntheticCoachLevels.ts --apply
 *
 * Requires: level_history table exists (run CURRICULUM_FLOW_001 + 002 first).
 */

import { supabase } from "../lib/supabaseClient.js";
import {
  loadTaxonomy,
  resolveAttendanceRung,
  type TaxonomyEntry,
} from "../lib/curriculumFlow.js";

const CLUB_ID = process.env.CLUB_ID ?? "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const APPLY   = process.argv.includes("--apply");
const PAGE    = 1000;
const WRITE_BATCH = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic hash of a UUID string → 0–99. */
function playerHash(id: string): number {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  return sum % 100;
}

type Bucket = "aligned" | "deluded" | "ready" | "skip";

function assignBucket(
  hash: number,
  baseRank: number,
  maxRank: number
): { bucket: Bucket; assignedRank: number } {
  if (hash >= 95) return { bucket: "skip", assignedRank: 0 };
  if (hash >= 85) {
    const assignedRank = Math.min(baseRank + 1, maxRank);
    return { bucket: assignedRank === baseRank ? "aligned" : "ready", assignedRank };
  }
  if (hash >= 70) {
    const assignedRank = Math.max(baseRank - 1, 1);
    return { bucket: assignedRank === baseRank ? "aligned" : "deluded", assignedRank };
  }
  return { bucket: "aligned", assignedRank: baseRank };
}

/** Backdate deterministically: 30–180 days ago using the same hash. */
function backdateISO(hash: number): string {
  const daysAgo = 30 + (hash % 151);
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

/** Modal rank of a timeline; ties resolved by most-recent attendance. */
function computeModalRank(timeline: { rank: number }[]): number {
  if (timeline.length === 0) return 0;
  const freq = new Map<number, number>();
  for (const e of timeline) freq.set(e.rank, (freq.get(e.rank) ?? 0) + 1);
  const maxFreq = Math.max(...freq.values());
  const tops = [...freq.entries()].filter(([, f]) => f === maxFreq).map(([r]) => r);
  if (tops.length === 1) return tops[0];
  // Tie: prefer the rank of the most-recent attendance
  const lastRank = timeline[timeline.length - 1].rank;
  return tops.includes(lastRank) ? lastRank : Math.max(...tops);
}

// ─── Paginated fetchers ───────────────────────────────────────────────────────

type PlayerRow = { id: string; club_id: string; coach_assigned_level: string | null };

async function fetchAllPlayers(): Promise<PlayerRow[]> {
  const rows: PlayerRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, club_id, coach_assigned_level")
      .eq("club_id", CLUB_ID)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetchAllPlayers: ${error.message}`);
    rows.push(...(data as PlayerRow[]));
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

type AttRow = { player_id: string; attended_at: string; level: string | null; program_name: string | null; event_id: string | null };

async function fetchAllAttendances(playerIdSet: Set<string>): Promise<AttRow[]> {
  // attendances.club_id is NULL on all rows (syncEventAttendance never writes it).
  // Scope to club by filtering in-memory against known player IDs.
  const rows: AttRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("player_id, attended_at, level, program_name, event_id")
      .order("attended_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`fetchAllAttendances: ${error.message}`);
    for (const row of data ?? []) {
      if (playerIdSet.has(row.player_id as string)) rows.push(row as AttRow);
    }
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

/** Returns the Set of player IDs that already have a synthetic level_history row. */
async function fetchAlreadySeededIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("level_history")
      .select("player_id")
      .eq("source", "synthetic")
      .range(offset, offset + PAGE - 1);
    if (error) {
      // Table doesn't exist yet — caller must handle
      throw error;
    }
    for (const row of data ?? []) ids.add(row.player_id as string);
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }
  return ids;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  Synthetic Coach Level Seed — ${APPLY ? "APPLY MODE" : "DRY-RUN"}`);
  console.log(`  Club: ${CLUB_ID}`);
  console.log(`  Run:  ${new Date().toISOString()}`);
  if (!APPLY) console.log("  (pass --apply to write)");
  console.log("════════════════════════════════════════════════════════\n");

  // ── Check level_history table exists (required for apply) ─────────────────
  let levelHistoryExists = true;
  let alreadySeededIds   = new Set<string>();

  try {
    alreadySeededIds = await fetchAlreadySeededIds();
    console.log(`  level_history table: ✅ exists  (${alreadySeededIds.size} synthetic rows already present)`);
  } catch (err: unknown) {
    levelHistoryExists = false;
    console.log("  level_history table: ❌ NOT FOUND — migrations not yet applied.");
    console.log("  Run these in order in the Supabase SQL Editor:");
    console.log("    1. migrations/CURRICULUM_FLOW_001_level_history.sql");
    console.log("    2. migrations/CURRICULUM_FLOW_002_backfill_seed.sql");
    if (APPLY) {
      console.log("\n  Cannot run --apply without level_history. Aborting.");
      process.exit(1);
    }
    console.log("  Continuing in dry-run simulation mode (no writes attempted).\n");
  }

  // ── Load taxonomy + players + attendances ─────────────────────────────────
  const taxonomy = await loadTaxonomy(CLUB_ID);
  const maxRank  = Math.max(...taxonomy.map((t) => t.rank));
  const rankByLevel = new Map(taxonomy.map((t) => [t.level, t.rank]));
  const levelByRank = new Map(taxonomy.map((t) => [t.rank, t.level]));

  console.log(`  Taxonomy: ${taxonomy.map((t) => `${t.level}(${t.rank})`).join(", ")}`);

  const allPlayers = await fetchAllPlayers();
  const realAssigned = allPlayers.filter((p) => p.coach_assigned_level !== null);
  const realAssignedIds = new Set(realAssigned.map((p) => p.id));

  console.log(`  Total players: ${allPlayers.length}`);
  console.log(`  Real coach assignments (untouchable): ${realAssigned.length}`);

  const playerIdSet = new Set(allPlayers.map((p) => p.id));
  const allAtts = await fetchAllAttendances(playerIdSet);
  console.log(`  Total attendance rows: ${allAtts.length}`);

  // ── Build in-memory timelines using resolveAttendanceRung ─────────────────
  // Bulk approach: load all attendances once, resolve each, group by player.
  // Reuses resolveAttendanceRung from curriculumFlow.ts (no logic duplication).
  // This avoids ~540 separate DB round-trips that buildPlayerRungTimeline would
  // require when called per-player in a batch context.
  const timelinesByPlayer = new Map<string, { rank: number }[]>();
  for (const att of allAtts) {
    const rung = resolveAttendanceRung(
      { level: att.level, program_name: att.program_name },
      taxonomy
    );
    if (!rung) continue;
    const tl = timelinesByPlayer.get(att.player_id) ?? [];
    tl.push({ rank: rung.rank });
    timelinesByPlayer.set(att.player_id, tl);
  }

  // ── Determine eligible players + bucket assignments ────────────────────────
  type Assignment = {
    playerId:      string;
    clubId:        string;
    hash:          number;
    baseRank:      number;
    bucket:        Bucket;
    assignedRank:  number;
    assignedLevel: string;
    assignedAt:    string;
  };

  const assignments: Assignment[] = [];
  let skippedReal    = 0;
  let skippedNoTl    = 0;
  let skippedBucket  = 0;
  let skippedAlready = 0;

  const bucketCounts: Record<Bucket, number> = { aligned: 0, deluded: 0, ready: 0, skip: 0 };

  for (const player of allPlayers) {
    if (realAssignedIds.has(player.id)) { skippedReal++;    continue; }
    if (alreadySeededIds.has(player.id)) { skippedAlready++; continue; }

    const tl = timelinesByPlayer.get(player.id);
    if (!tl || tl.length === 0)          { skippedNoTl++;   continue; }

    const hash         = playerHash(player.id);
    const baseRank     = computeModalRank(tl);
    const { bucket, assignedRank } = assignBucket(hash, baseRank, maxRank);

    bucketCounts[bucket]++;

    if (bucket === "skip") { skippedBucket++; continue; }

    const assignedLevel = levelByRank.get(assignedRank);
    if (!assignedLevel) continue;   // shouldn't happen

    assignments.push({
      playerId:      player.id,
      clubId:        player.club_id,
      hash,
      baseRank,
      bucket,
      assignedRank,
      assignedLevel,
      assignedAt:    backdateISO(hash),
    });
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log(`\n── Eligibility ───────────────────────────────────────`);
  console.log(`  Skipped (real assignment, protected):  ${skippedReal}`);
  console.log(`  Skipped (no resolved attendance):      ${skippedNoTl}`);
  console.log(`  Skipped (already seeded):              ${skippedAlready}`);
  console.log(`  Skipped (bucket=skip, 95–99):          ${skippedBucket}`);
  console.log(`  Eligible (will receive assignment):    ${assignments.length}`);
  console.log(`\n── Bucket distribution ───────────────────────────────`);
  console.log(`  aligned  (0–69):  ${bucketCounts.aligned}`);
  console.log(`  deluded  (70–84): ${bucketCounts.deluded}`);
  console.log(`  ready    (85–94): ${bucketCounts.ready}`);
  console.log(`  skip     (95–99): ${bucketCounts.skip}`);

  console.log(`\n── 10 sample assignments ─────────────────────────────`);
  const samples = assignments.slice(0, 10);
  for (const a of samples) {
    console.log(
      `  ${a.playerId.slice(0, 8)}…  baseRank=${a.baseRank}` +
      `  bucket=${a.bucket.padEnd(8)}  assignedLevel="${a.assignedLevel}"` +
      `  assignedAt=${a.assignedAt.slice(0, 10)}`
    );
  }

  if (!APPLY) {
    console.log(`\n── DRY-RUN complete — no writes performed ────────────`);
    console.log(`  To apply: add --apply flag`);
    if (!levelHistoryExists) {
      console.log(`  ⚠ Also: run CURRICULUM_FLOW_001 + 002 SQL first`);
    }
    console.log();
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  console.log(`\n── Applying ${assignments.length} assignments… ────────────────────`);

  // Batch player updates: group by assigned level to minimise queries
  const byLevel = new Map<string, string[]>();
  for (const a of assignments) {
    const ids = byLevel.get(a.assignedLevel) ?? [];
    ids.push(a.playerId);
    byLevel.set(a.assignedLevel, ids);
  }

  let playerUpdateErrors = 0;
  for (const [level, ids] of byLevel) {
    // Update in chunks of WRITE_BATCH to avoid URL length limits on .in()
    for (let i = 0; i < ids.length; i += WRITE_BATCH) {
      const chunk = ids.slice(i, i + WRITE_BATCH);
      const { error } = await supabase
        .from("players")
        .update({ coach_assigned_level: level })
        .in("id", chunk);
      if (error) {
        console.error(`  ERROR updating players (level="${level}"): ${error.message}`);
        playerUpdateErrors++;
      }
    }
  }
  console.log(`  Players updated: ${assignments.length}  errors: ${playerUpdateErrors}`);

  // Batch level_history inserts
  const historyRows = assignments.map((a) => ({
    player_id:   a.playerId,
    club_id:     a.clubId,
    from_level:  null,
    to_level:    a.assignedLevel,
    from_rank:   null,
    to_rank:     a.assignedRank,
    source:      "synthetic" as const,
    assigned_at: a.assignedAt,
    note:        `SYNTHETIC dev seed — derived from modal booking rank, bucket=${a.bucket}`,
  }));

  let historyInsertErrors = 0;
  for (let i = 0; i < historyRows.length; i += WRITE_BATCH) {
    const batch = historyRows.slice(i, i + WRITE_BATCH);
    const { error } = await supabase.from("level_history").insert(batch);
    if (error) {
      console.error(`  ERROR inserting level_history batch ${i / WRITE_BATCH + 1}: ${error.message}`);
      historyInsertErrors++;
    }
  }
  console.log(`  level_history rows inserted: ${historyRows.length}  errors: ${historyInsertErrors}`);

  console.log(`\n── Apply complete ────────────────────────────────────`);
  console.log(`  To reverse: run wipeSyntheticCoachLevels.ts --apply`);
  console.log();
}

main().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
