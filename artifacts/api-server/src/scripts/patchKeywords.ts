/**
 * One-time keyword patch for match_rules jsonb in the programs table.
 * Idempotent: skips if keyword already present.
 *
 * Patches applied:
 *   - Path to Intermediate: add "path to 4.0"
 *
 * NOT applied (deliberate):
 *   - Workshop "fitness hiit" / "fitness" — Fitness HIIT stays unclassified
 *     pending a dedicated archetype decision (see runbook §13).
 *
 *   npx tsx src/scripts/patchKeywords.ts
 */

import { createClient } from "@supabase/supabase-js";

const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";

async function patch(
  sb: ReturnType<typeof createClient>,
  canonicalName: string,
  keywordToAdd: string,
) {
  const { data, error } = await (sb as any)
    .from("programs")
    .select("id, canonical_name, match_rules")
    .eq("club_id", CLUB_ID)
    .eq("canonical_name", canonicalName)
    .maybeSingle() as { data: { id: string; canonical_name: string; match_rules: { keywords?: string[]; require_podplay_types?: string[] } } | null; error: any };

  if (error || !data) {
    console.error(`❌ Not found: "${canonicalName}" —`, error?.message ?? "no row");
    return false;
  }

  const rules = data.match_rules;
  const kws: string[] = rules.keywords ?? [];

  if (kws.includes(keywordToAdd)) {
    console.log(`  ✓ "${canonicalName}" already has "${keywordToAdd}" — skipping`);
    return true;
  }

  const updatedRules = { ...rules, keywords: [...kws, keywordToAdd] };
  const { error: upErr } = await (sb as any)
    .from("programs")
    .update({ match_rules: updatedRules })
    .eq("id", data.id);

  if (upErr) {
    console.error(`❌ Update failed for "${canonicalName}":`, upErr.message);
    return false;
  }

  console.log(`  ✅ "${canonicalName}" keywords now: [${updatedRules.keywords.join(", ")}]`);
  return true;
}

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  console.log("Applying keyword patches…\n");

  const ok = await patch(sb as any, "Path to Intermediate", "path to 4.0");

  console.log(`\n${ok ? "✅ Patch complete." : "❌ Patch failed — check errors above."}`);
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
