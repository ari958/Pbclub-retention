/**
 * One-time backfill: populate event_name and podplay_type for existing
 * event_fill rows that were recorded before migration 005.
 *
 * Requires migration 005 to have been applied first:
 *   artifacts/api-server/migrations/005_event_fill_columns.sql
 *
 * Resumable: skips rows where event_name is already non-null.
 *
 *   npx tsx src/scripts/backfillEventFillMetadata.ts
 */

import { supabase } from "../lib/supabaseClient";
import { logger } from "../lib/logger";

const SLEEP_MS   = 100;
const PAGE_SIZE  = 500;

const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=".repeat(70));
  console.log("Event Fill — backfill event_name + podplay_type");
  console.log("=".repeat(70));

  // Load club API config
  const { data: club, error: clubErr } = await supabase
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .eq("id", CLUB_ID)
    .maybeSingle();
  if (clubErr || !club?.platform_subdomain) {
    throw new Error("Club not found or misconfigured");
  }
  const apiKey  = club.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";
  const apiBase = `https://${club.platform_subdomain}.podplay.app/apis/v2`;

  // Snapshot all IDs that need backfilling (event_name IS NULL) before any
  // writes. Paginating a mutable result set (filtering by IS NULL while
  // updating rows) shifts remaining records into already-consumed page offsets,
  // silently skipping them. Collecting IDs first into an in-memory set avoids
  // this: the query window is stable and subsequent pages are never affected by
  // concurrent updates.
  const rows: { event_id: string }[] = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from("event_fill")
      .select("event_id")
      .eq("club_id", CLUB_ID)
      .is("event_name", null)
      .order("event_id")          // stable cursor order
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw new Error(`load rows: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as any[]));
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  // De-duplicate (shouldn't be needed, but be safe)
  const seen = new Set<string>();
  const uniqueRows = rows.filter(r => {
    if (seen.has(r.event_id)) return false;
    seen.add(r.event_id);
    return true;
  });

  console.log(`\nRows to backfill: ${uniqueRows.length}`);
  if (uniqueRows.length === 0) {
    console.log("Nothing to do — all rows already have event_name.");
    return;
  }

  let updated = 0, errors = 0, skipped = 0;

  for (let i = 0; i < uniqueRows.length; i++) {
    const { event_id } = uniqueRows[i];
    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${uniqueRows.length}  updated=${updated}  errors=${errors}`);
    }

    try {
      const res = await fetch(`${apiBase}/events/${event_id}`, {
        headers: { "x-api-key": apiKey },
      });
      if (res.status === 404) {
        skipped++;
        await sleep(SLEEP_MS);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status}`);

      const ev: any = await res.json();
      const { error: updateErr } = await supabase
        .from("event_fill")
        .update({
          event_name:   ev.name    ?? null,
          podplay_type: ev.customType ?? null,
        })
        .eq("event_id", event_id);

      if (updateErr) throw new Error(updateErr.message);
      updated++;
    } catch (err: any) {
      errors++;
      logger.warn({ event_id, err: err.message }, "[backfillEventFillMetadata] error");
    }

    await sleep(SLEEP_MS);
  }

  console.log("\n" + "=".repeat(70));
  console.log("Done:");
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped} (404 not found)`);
  console.log(`  Errors:   ${errors}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
