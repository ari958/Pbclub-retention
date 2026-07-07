/**
 * Dry-run: classify today's PodPlay events against seeded archetypes and
 * print the rated catalog to console for eyeball inspection.
 *
 * Run AFTER the migration has been applied:
 *   npx tsx src/scripts/dryRunCatalog.ts
 */

import { createClient } from "@supabase/supabase-js";
import { loadArchetypes, classifyEvent, isDailyPeak, isPeakSeason, getLevelFromTags } from "../lib/classifyEvent";

const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const RATING_START = new Date("2026-02-01T05:00:00.000Z");

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log("=".repeat(70));
  console.log("PB Club — Program Catalog Dry Run");
  console.log("=".repeat(70));

  // 1. Load archetypes
  const archetypes = await loadArchetypes(CLUB_ID);
  console.log(`\n✓ Loaded ${archetypes.length} archetypes\n`);

  // 2. Fetch club PodPlay config
  const { data: club, error: clubErr } = await sb
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .eq("id", CLUB_ID)
    .maybeSingle();

  if (clubErr || !club?.platform_subdomain) {
    console.error("❌ Cannot fetch club config:", clubErr?.message ?? "no platform_subdomain");
    process.exit(1);
  }

  const apiKey = club.platform_api_key ?? process.env.PODPLAY_API_KEY ?? "";
  const apiBase = `https://${club.platform_subdomain}.podplay.app/apis/v2`;

  // 3. Fetch upcoming events
  console.log(`Fetching events from PodPlay...`);
  const evRes = await fetch(`${apiBase}/events`, { headers: { "x-api-key": apiKey } });
  if (!evRes.ok) {
    console.error("❌ PodPlay fetch failed:", evRes.status, await evRes.text());
    process.exit(1);
  }
  const evData = await evRes.json() as { items?: any[] };
  const allEvents = evData.items ?? [];
  console.log(`  Total raw events: ${allEvents.length}`);

  // 4. Filter and classify
  type SlotAcc = { fillRates: number[]; eventIds: Set<string> };
  const byArchetype = new Map<string, Map<string, SlotAcc>>();
  for (const a of archetypes) byArchetype.set(a.id, new Map());

  let classified = 0, skipped = 0;

  for (const ev of allEvents) {
    if (ev.isCanceled || ev.status !== "PUBLISHED") { skipped++; continue; }
    if (!ev.startTime || new Date(ev.startTime) < RATING_START) { skipped++; continue; }

    const result = classifyEvent(
      { name: ev.name, podplayType: ev.customType ?? "", tags: ev.tags ?? [], startTime: ev.startTime },
      archetypes,
    );
    if (result.isExcluded) { skipped++; continue; }

    classified++;
    const capacity = (ev.totalTeams ?? 0) * (ev.teamSize ?? 1);
    if (capacity <= 0) continue;

    const fillRate = (ev.signups?._total ?? 0) / capacity;
    const dp = isDailyPeak(ev.startTime);
    const s = isPeakSeason(ev.startTime) ? "peak" : "off_peak";
    const slotKey = `${dp ? "peak" : "offpk"}_${s}`;

    const slotMap = byArchetype.get(result.archetypeId)!;
    if (!slotMap.has(slotKey)) slotMap.set(slotKey, { fillRates: [], eventIds: new Set() });
    const slot = slotMap.get(slotKey)!;
    slot.fillRates.push(fillRate);
    slot.eventIds.add(ev.id);
  }

  console.log(`  Classified: ${classified}  Skipped: ${skipped}\n`);

  // 5. Print existing ratings from DB (if any) + live fill summary
  const { data: dbRatings } = await sb
    .from("program_ratings")
    .select("*")
    .eq("club_id", CLUB_ID);
  const hasDbRatings = (dbRatings?.length ?? 0) > 0;

  console.log("─".repeat(70));
  console.log("ARCHETYPE CATALOG");
  console.log("─".repeat(70));

  for (const arch of archetypes) {
    const slotMap = byArchetype.get(arch.id)!;
    const totalEvents = [...slotMap.values()].reduce((acc, s) => acc + s.eventIds.size, 0);
    const allRates = [...slotMap.values()].flatMap((s) => s.fillRates);
    const meanFill = allRates.length
      ? (allRates.reduce((a, b) => a + b, 0) / allRates.length * 100).toFixed(1)
      : "—";

    console.log(
      `\n[${arch.canonical_type === "clinic" ? "CLINIC   " : "OPEN PLAY"}] ${arch.canonical_name}` +
        `  (priority ${arch.match_priority}${arch.overrides_podplay_type ? ", overrides type" : ""})`,
    );
    console.log(`  Upcoming events in window: ${totalEvents}   Mean fill: ${meanFill}${allRates.length ? "%" : ""}`);

    for (const [slotKey, slot] of [...slotMap.entries()].sort()) {
      if (!slot.fillRates.length) continue;
      const mean = (slot.fillRates.reduce((a, b) => a + b, 0) / slot.fillRates.length * 100).toFixed(1);
      console.log(`    ${slotKey.padEnd(18)} n=${slot.eventIds.size}  fill=${mean}%`);
    }

    if (hasDbRatings) {
      const archRatings = (dbRatings ?? []).filter((r: any) => r.program_id === arch.id);
      if (archRatings.length) {
        console.log("  DB ratings:");
        for (const r of archRatings) {
          console.log(
            `    daily_peak=${String(r.daily_peak).padEnd(5)} season=${r.season.padEnd(8)}` +
              `  fill=${r.fill_rate ?? "—"}  n=${r.event_count}` +
              `  velocity=${r.median_velocity_days ?? "—"}d  new_share=${r.new_player_share ?? "—"}`,
          );
        }
      }
    }
  }

  // 6. Unclassified event names for inspection
  const unclassified: { name: string; type: string }[] = [];
  for (const ev of allEvents) {
    if (ev.isCanceled || ev.status !== "PUBLISHED") continue;
    if (!ev.startTime || new Date(ev.startTime) < RATING_START) continue;
    const r = classifyEvent({ name: ev.name, podplayType: ev.customType ?? "", tags: ev.tags ?? [] }, archetypes);
    if (r.isExcluded && !r.reason.startsWith("excluded type") && !r.reason.startsWith("excluded event name")) {
      unclassified.push({ name: ev.name, type: ev.customType ?? "" });
    }
  }

  if (unclassified.length > 0) {
    console.log("\n⚠️  UNMATCHED (no archetype, not excluded by type/name):");
    for (const u of unclassified) console.log(`   "${u.name}" [${u.type}]`);
  } else {
    console.log("\n✅  No unmatched events.");
  }

  console.log("\n" + "=".repeat(70));
  console.log("Dry run complete. Run migration, then `computeProgramRatings` to populate DB.");
}

main().catch((err) => { console.error(err); process.exit(1); });
