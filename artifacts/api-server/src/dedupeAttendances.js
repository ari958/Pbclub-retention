import { createClient } from "@supabase/supabase-js";

// Uses service role key if available, falls back to anon key.
// The executing role needs SELECT and DELETE on the attendances table.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const PAGE_SIZE = 1000;  // rows fetched per page
const DELETE_BATCH = 500; // ids deleted per request

/**
 * Deduplicate the attendances table.
 *
 * Strategy: stream through all rows sorted by (player_id, program_name, attended_at, id).
 * Because duplicates share the first three fields and are sorted by id, they appear
 * consecutively — so a single linear pass identifies which ids to delete (all but the
 * first in each group). Deletes are issued in batches of DELETE_BATCH.
 *
 * @param {(msg: string) => void} log
 * @returns {Promise<{ scanned: number, duplicatesFound: number, deleted: number, errors: number }>}
 */
export async function dedupeAttendances(log = console.log) {
  log("[dedupe] Starting attendance deduplication…");

  // ── Pass 1: scan all rows and collect duplicate ids ──────────────────────

  const duplicateIds = [];
  let lastKey = null;
  let offset = 0;
  let scanned = 0;
  let page = 0;

  while (true) {
    page++;
    log(`[dedupe] Scanning page ${page} (offset=${offset})…`);

    const { data, error } = await supabase
      .from("attendances")
      .select("id, player_id, program_name, attended_at")
      .order("player_id")
      .order("program_name")
      .order("attended_at")
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch attendances at offset ${offset}: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned++;
      const key = `${row.player_id}|${row.program_name}|${row.attended_at}`;

      if (key === lastKey) {
        // Same composite key as previous row → duplicate; mark for deletion
        duplicateIds.push(row.id);
      } else {
        // New group → this is the keeper; move the boundary forward
        lastKey = key;
      }
    }

    log(`[dedupe] Page ${page}: scanned ${data.length} rows, ${duplicateIds.length} duplicates found so far`);

    if (data.length < PAGE_SIZE) break; // last page
    offset += PAGE_SIZE;
  }

  log(`[dedupe] Scan complete — scanned=${scanned}, duplicates to delete=${duplicateIds.length}`);

  if (duplicateIds.length === 0) {
    log("[dedupe] No duplicates found. Table is already clean.");
    return { scanned, duplicatesFound: 0, deleted: 0, errors: 0 };
  }

  // ── Pass 2: delete duplicates in batches ─────────────────────────────────

  let deleted = 0;
  let errors = 0;
  const totalBatches = Math.ceil(duplicateIds.length / DELETE_BATCH);

  for (let b = 0; b < totalBatches; b++) {
    const batch = duplicateIds.slice(b * DELETE_BATCH, (b + 1) * DELETE_BATCH);

    const { error: delError } = await supabase
      .from("attendances")
      .delete()
      .in("id", batch);

    if (delError) {
      log(`[dedupe] ERROR deleting batch ${b + 1}/${totalBatches}: ${delError.message}`);
      errors++;
    } else {
      deleted += batch.length;
      log(`[dedupe] Deleted batch ${b + 1}/${totalBatches} (${batch.length} rows) — total deleted: ${deleted}`);
    }
  }

  log(`[dedupe] Done — scanned=${scanned} | duplicatesFound=${duplicateIds.length} | deleted=${deleted} | batchErrors=${errors}`);
  return { scanned, duplicatesFound: duplicateIds.length, deleted, errors };
}
