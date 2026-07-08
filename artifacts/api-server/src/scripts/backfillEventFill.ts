/**
 * One-time backfill: fetch capacity + final signups for all past PodPlay events
 * in the attendances table since 2026-02-01 and persist to event_fill.
 *
 * Resumable: already-recorded event_ids are skipped automatically.
 * Re-running is safe and continues from where it left off.
 *
 *   npx tsx src/scripts/backfillEventFill.ts
 */

import { syncEventFill } from "../lib/eventFillSync";

const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";

async function main() {
  console.log("=".repeat(70));
  console.log("PB Club — Event Fill Backfill");
  console.log("=".repeat(70));
  console.log(`Started: ${new Date().toISOString()}\n`);

  const stats = await syncEventFill(
    CLUB_ID,
    (msg) => console.log(`  ${msg}`),
    { mode: "backfill", sleepMs: 75 },
  );

  console.log("\n" + "=".repeat(70));
  console.log("Backfill complete:");
  console.log(`  Fetched & recorded:      ${stats.fetched}`);
  console.log(`  Skipped (already in DB): ${stats.skipped_already_recorded}`);
  console.log(`  Skipped (future):        ${stats.skipped_future}`);
  console.log(`  Skipped (no capacity):   ${stats.skipped_no_capacity}`);
  console.log(`  Skipped (canceled):      ${stats.skipped_canceled}`);
  console.log(`  Skipped (no archetype):  ${stats.skipped_no_archetype}`);
  console.log(`  Errors:                  ${stats.errors}`);
  console.log(`\nFinished: ${new Date().toISOString()}`);

  if (stats.errors > 0) {
    console.log("\n⚠️  Errors occurred — re-run to retry failed IDs.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
