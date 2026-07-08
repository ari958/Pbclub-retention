/**
 * Re-fetch PodPlay event details for event_fill rows where archetype_id IS NULL
 * and re-classify using the current (patched) archetype keyword rules.
 *
 * Run after any keyword patch to the programs.match_rules table.
 * Idempotent: only processes null archetype_id rows (already-classified rows untouched).
 *
 *   npx tsx src/scripts/reclassifyEventFill.ts
 */

import { supabase } from "../lib/supabaseClient";
import { loadArchetypes, classifyEvent } from "../lib/classifyEvent";

const CLUB_ID  = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const SLEEP_MS = 75;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("=".repeat(70));
  console.log("Reclassify event_fill rows with archetype_id IS NULL");
  console.log("=".repeat(70));

  // 1. Load archetypes (with updated keywords)
  const archetypes = await loadArchetypes(CLUB_ID);
  console.log(`\nArchetypes loaded: ${archetypes.length}`);

  // 2. Club PodPlay config
  const { data: club } = await supabase
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .eq("id", CLUB_ID)
    .maybeSingle();
  if (!club?.platform_subdomain) { console.error("No platform_subdomain"); process.exit(1); }
  const apiBase = `https://${club.platform_subdomain}.podplay.app/apis/v2`;
  const apiKey  = club.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";

  // 3. Find unclassified rows
  const { data: rows, error } = await supabase
    .from("event_fill")
    .select("event_id")
    .eq("club_id", CLUB_ID)
    .eq("is_canceled", false)
    .is("archetype_id", null);
  if (error) { console.error("Query failed:", error.message); process.exit(1); }

  console.log(`Unclassified rows to process: ${rows?.length ?? 0}\n`);
  if (!rows?.length) { console.log("Nothing to do."); return; }

  let updated = 0, stillUnmatched = 0, errors = 0;
  const matchedNames: string[] = [];
  const unmatchedNames: string[] = [];

  for (const row of rows) {
    try {
      const res = await fetch(`${apiBase}/events/${row.event_id}`, { headers: { "x-api-key": apiKey } });
      if (!res.ok) { errors++; await sleep(SLEEP_MS); continue; }
      const ev: any = await res.json();

      const result = classifyEvent(
        { name: ev.name ?? "", podplayType: ev.customType ?? "", tags: ev.tags ?? [] },
        archetypes,
      );

      if (result.isExcluded || !result.archetypeId) {
        stillUnmatched++;
        unmatchedNames.push(`"${ev.name}" [${ev.customType}]`);
        await sleep(SLEEP_MS);
        continue;
      }

      const { error: upErr } = await supabase
        .from("event_fill")
        .update({ archetype_id: result.archetypeId })
        .eq("event_id", row.event_id);

      if (upErr) { errors++; console.error(`Update failed ${row.event_id}:`, upErr.message); }
      else {
        updated++;
        const archName = archetypes.find(a => a.id === result.archetypeId)?.canonical_name ?? result.archetypeId;
        matchedNames.push(`"${ev.name}" → ${archName}`);
      }
    } catch (err: any) {
      errors++;
      console.error(`Error on ${row.event_id}:`, err.message);
    }
    await sleep(SLEEP_MS);
  }

  console.log("\n" + "=".repeat(70));
  console.log(`Updated:          ${updated}`);
  console.log(`Still unmatched:  ${stillUnmatched}`);
  console.log(`Errors:           ${errors}`);

  if (matchedNames.length) {
    console.log("\n✅ Newly classified:");
    matchedNames.forEach(n => console.log(`   ${n}`));
  }
  if (unmatchedNames.length) {
    console.log("\n⚠ Still unclassified (expected — deliberate exclusions):");
    unmatchedNames.forEach(n => console.log(`   ${n}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
