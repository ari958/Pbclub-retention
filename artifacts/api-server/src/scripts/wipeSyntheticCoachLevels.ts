/**
 * wipeSyntheticCoachLevels.ts — reverses the synthetic dev seed.
 *
 * Removes all level_history rows with source='synthetic' and nulls the
 * corresponding players.coach_assigned_level — but ONLY if the current
 * value still matches the synthetic assignment (guards against a real coach
 * reassigning a player after the seed).
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/wipeSyntheticCoachLevels.ts
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/wipeSyntheticCoachLevels.ts --apply
 *
 * ⚠ MUST be run before any production cutover. See CURRICULUM_FLOW_README.md.
 */

import { supabase } from "../lib/supabaseClient.js";

const APPLY = process.argv.includes("--apply");
const PAGE  = 1000;
const WRITE_BATCH = 100;

// ─── Paginated fetch of synthetic level_history rows ─────────────────────────

type SyntheticRow = {
  id:         number;
  player_id:  string;
  to_level:   string;
};

async function fetchSyntheticRows(): Promise<SyntheticRow[]> {
  const rows: SyntheticRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("level_history")
      .select("id, player_id, to_level")
      .eq("source", "synthetic")
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    rows.push(...(data as SyntheticRow[]));
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  Synthetic Coach Level Wipe — ${APPLY ? "APPLY MODE" : "DRY-RUN"}`);
  console.log(`  Run: ${new Date().toISOString()}`);
  if (!APPLY) console.log("  (pass --apply to write)");
  console.log("════════════════════════════════════════════════════════\n");

  // ── Check level_history table exists ──────────────────────────────────────
  let syntheticRows: SyntheticRow[];
  try {
    syntheticRows = await fetchSyntheticRows();
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? String(err);
    if (msg.includes("relation") || msg.includes("table") || msg.includes("schema cache")) {
      console.log("  level_history table does not exist yet — nothing to wipe.");
      console.log("  Run CURRICULUM_FLOW_001 in the Supabase SQL Editor first.");
      return;
    }
    throw err;
  }

  if (syntheticRows.length === 0) {
    console.log("  No synthetic rows found — nothing to do.");
    return;
  }

  console.log(`  Synthetic level_history rows found: ${syntheticRows.length}`);

  // ── Collect affected player IDs and their synthetic to_level ─────────────
  // One synthetic row per player (idempotency guarantee from seed script),
  // but we handle duplicates gracefully.
  const syntheticByPlayer = new Map<string, { rowId: number; toLevel: string }>();
  for (const row of syntheticRows) {
    if (!syntheticByPlayer.has(row.player_id)) {
      syntheticByPlayer.set(row.player_id, { rowId: row.id, toLevel: row.to_level });
    }
  }

  const affectedPlayerIds = [...syntheticByPlayer.keys()];

  // ── Load current coach_assigned_level for affected players ────────────────
  const currentLevels = new Map<string, string | null>();
  for (let i = 0; i < affectedPlayerIds.length; i += PAGE) {
    const chunk = affectedPlayerIds.slice(i, i + PAGE);
    const { data, error } = await supabase
      .from("players")
      .select("id, coach_assigned_level")
      .in("id", chunk);
    if (error) throw new Error(`Failed to load player levels: ${error.message}`);
    for (const row of data ?? []) {
      currentLevels.set(row.id as string, row.coach_assigned_level as string | null);
    }
  }

  // ── Classify players ──────────────────────────────────────────────────────
  const toNull:    string[] = [];  // safe to null
  const protected_: string[] = [];  // real reassignment — leave alone

  for (const [playerId, { toLevel }] of syntheticByPlayer) {
    const current = currentLevels.get(playerId);
    if (current === toLevel) {
      toNull.push(playerId);
    } else {
      protected_.push(playerId);
    }
  }

  const syntheticRowIds = syntheticRows.map((r) => r.id);

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n── Plan ──────────────────────────────────────────────`);
  console.log(`  level_history rows to DELETE:    ${syntheticRowIds.length}`);
  console.log(`  players.coach_assigned_level to NULL: ${toNull.length}`);
  console.log(`  players PROTECTED (real reassignment detected): ${protected_.length}`);

  if (protected_.length > 0) {
    console.log(`  Protected player IDs (first 5):`);
    protected_.slice(0, 5).forEach((id) => console.log(`    ${id}`));
  }

  if (!APPLY) {
    console.log(`\n── DRY-RUN complete — no writes performed ────────────`);
    console.log(`  To apply: add --apply flag`);
    console.log();
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  console.log(`\n── Applying wipe… ────────────────────────────────────`);

  // 1. Null coach_assigned_level on safe players (grouped in batches)
  let playerNullErrors = 0;
  for (let i = 0; i < toNull.length; i += WRITE_BATCH) {
    const chunk = toNull.slice(i, i + WRITE_BATCH);
    const { error } = await supabase
      .from("players")
      .update({ coach_assigned_level: null })
      .in("id", chunk);
    if (error) {
      console.error(`  ERROR nulling players batch ${i / WRITE_BATCH + 1}: ${error.message}`);
      playerNullErrors++;
    }
  }
  console.log(`  Players nulled: ${toNull.length}  errors: ${playerNullErrors}`);

  // 2. Delete synthetic level_history rows
  let deleteErrors = 0;
  for (let i = 0; i < syntheticRowIds.length; i += WRITE_BATCH) {
    const chunk = syntheticRowIds.slice(i, i + WRITE_BATCH);
    const { error } = await supabase
      .from("level_history")
      .delete()
      .in("id", chunk);
    if (error) {
      console.error(`  ERROR deleting level_history batch ${i / WRITE_BATCH + 1}: ${error.message}`);
      deleteErrors++;
    }
  }
  console.log(`  level_history rows deleted: ${syntheticRowIds.length}  errors: ${deleteErrors}`);

  console.log(`\n── Wipe complete ─────────────────────────────────────`);
  console.log(`  ${protected_.length} players were protected (real reassignment — check manually if needed)`);
  console.log();
}

main().catch((err) => {
  console.error("Wipe script failed:", err);
  process.exit(1);
});
