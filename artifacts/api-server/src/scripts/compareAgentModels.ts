/**
 * compareAgentModels.ts
 *
 * Side-by-side eval of claude-sonnet-4-6 vs claude-opus-4-7 on real players.
 *
 * Usage:
 *   pnpm tsx src/scripts/compareAgentModels.ts [N]
 *
 * N = number of players to test (default 10). Each player gets 2 calls (one per model)
 * for a total of 2N calls, paced at 4s between calls to stay under the 20 req/min limit.
 *
 * Requires the dev server to be running and NODE_ENV=development (for _model override).
 * Outputs a CSV table to stdout and a summary to stdout after.
 * Progress lines go to stderr so they don't pollute piped CSV output.
 */

import { createClient } from "@supabase/supabase-js";

// ─── Config ───────────────────────────────────────────────────────────────────

const N = parseInt(process.argv[2] ?? "10", 10);
if (isNaN(N) || N < 1) {
  console.error("Usage: pnpm tsx src/scripts/compareAgentModels.ts [N]");
  process.exit(1);
}

const BASE_URL = "http://localhost/api/agent/run";
const MODELS   = ["claude-sonnet-4-6", "claude-opus-4-7"] as const;
type Model     = typeof MODELS[number];

const TOKEN_RATES: Record<Model, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3,  output: 15 }, // USD per million tokens
  "claude-opus-4-7":   { input: 5,  output: 25 },
};

const SLEEP_BETWEEN_MS = 4_000;

// ─── Supabase (read-only usage — picks player IDs only) ──────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ─── Player selection ─────────────────────────────────────────────────────────

async function pickPlayers(n: number): Promise<string[]> {
  const allIds: string[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendances")
      .select("player_id")
      .not("player_id", "is", null)
      .range(offset, offset + 999);
    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.player_id) allIds.push(row.player_id as string);
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  const unique = [...new Set(allIds)];
  // Fisher-Yates shuffle
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique.slice(0, n);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CallResult {
  player_id:            string;
  model:                string;
  latency_ms:           number;
  input_tokens:         number;
  output_tokens:        number;
  cost_usd:             number;
  message:              string;
  recommended_programs: string[];
}

// ─── Agent call ───────────────────────────────────────────────────────────────

function computeCost(model: string, input: number, output: number): number {
  const rate = TOKEN_RATES[model as Model] ?? { input: 3, output: 15 };
  return (input / 1_000_000) * rate.input + (output / 1_000_000) * rate.output;
}

async function callAgent(playerId: string, model: string): Promise<CallResult> {
  const t0  = Date.now();
  const res = await fetch(BASE_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ player_id: playerId, _model: model }),
    signal:  AbortSignal.timeout(60_000),
  });
  const latency_ms = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json() as Record<string, unknown>;

  // Hard assert — a mismatch means results would be attributed to the wrong model
  if (body.model_used !== model) {
    throw new Error(
      `Model mismatch: requested "${model}" but response has model_used="${body.model_used}". ` +
      `Aborting — CSV would be misleading.`
    );
  }

  const input_tokens  = (body.input_tokens  as number) ?? 0;
  const output_tokens = (body.output_tokens as number) ?? 0;

  return {
    player_id:            playerId,
    model,
    latency_ms,
    input_tokens,
    output_tokens,
    cost_usd:             computeCost(model, input_tokens, output_tokens),
    message:              (body.message as string) ?? "",
    recommended_programs: (body.recommended_programs as string[]) ?? [],
  };
}

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function csv(v: unknown): string {
  const s = String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(`Picking ${N} players with attendance records…\n`);
  const players = await pickPlayers(N);
  if (players.length === 0) {
    console.error("No players found with attendance records.");
    process.exit(1);
  }
  process.stderr.write(`Got ${players.length} player(s). Running ${players.length * MODELS.length} calls (4s between)…\n\n`);

  const results: CallResult[] = [];
  const errors:  string[]     = [];
  let callIndex = 0;
  const totalCalls = players.length * MODELS.length;

  for (const pid of players) {
    for (const model of MODELS) {
      if (callIndex > 0) await sleep(SLEEP_BETWEEN_MS);   // between, not before
      callIndex++;

      process.stderr.write(`[${callIndex}/${totalCalls}] player=${pid.slice(0, 8)}… model=${model}\n`);

      try {
        const result = await callAgent(pid, model);
        results.push(result);
        process.stderr.write(`  → ${result.latency_ms}ms  in=${result.input_tokens} out=${result.output_tokens}  $${result.cost_usd.toFixed(6)}\n`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Model mismatch is always fatal
        if (msg.includes("model_used")) throw err;
        process.stderr.write(`  → ERROR: ${msg}\n`);
        errors.push(`player=${pid} model=${model}: ${msg}`);
      }
    }
  }

  // ── CSV output ──────────────────────────────────────────────────────────────
  console.log("player_id,model,latency_ms,input_tokens,output_tokens,cost_usd,message,recommended_programs");
  for (const r of results) {
    console.log([
      csv(r.player_id),
      csv(r.model),
      r.latency_ms,
      r.input_tokens,
      r.output_tokens,
      r.cost_usd.toFixed(6),
      csv(r.message),
      csv(r.recommended_programs.join("; ")),
    ].join(","));
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n--- SUMMARY ---");

  const summaries: { model: string; avgLatency: number; avgIn: number; avgOut: number; totalCost: number; n: number }[] = [];

  for (const model of MODELS) {
    const rows = results.filter((r) => r.model === model);
    if (rows.length === 0) {
      console.log(`\n${model}: no successful calls`);
      continue;
    }
    const avgLatency = rows.reduce((s, r) => s + r.latency_ms, 0) / rows.length;
    const avgIn      = rows.reduce((s, r) => s + r.input_tokens, 0) / rows.length;
    const avgOut     = rows.reduce((s, r) => s + r.output_tokens, 0) / rows.length;
    const totalCost  = rows.reduce((s, r) => s + r.cost_usd, 0);
    const costPer1k  = (totalCost / rows.length) * 1_000;
    summaries.push({ model, avgLatency, avgIn, avgOut, totalCost, n: rows.length });
    console.log(`\n${model}:`);
    console.log(`  calls:       ${rows.length}`);
    console.log(`  avg latency: ${avgLatency.toFixed(0)} ms`);
    console.log(`  avg tokens:  ${avgIn.toFixed(0)} in / ${avgOut.toFixed(0)} out`);
    console.log(`  total cost:  $${totalCost.toFixed(6)}`);
    console.log(`  proj @1k/mo: $${costPer1k.toFixed(4)}`);
  }

  // Dollar delta
  const s4 = summaries.find((s) => s.model === "claude-sonnet-4-6");
  const op = summaries.find((s) => s.model === "claude-opus-4-7");
  if (s4 && op) {
    const sonnetPerCall = s4.totalCost / s4.n;
    const opusPerCall   = op.totalCost / op.n;
    const delta1k       = (opusPerCall - sonnetPerCall) * 1_000;
    console.log(`\nOpus premium over Sonnet @ 1,000 calls/month: +$${delta1k.toFixed(2)}`);
  }

  if (errors.length > 0) {
    console.log(`\n--- ERRORS (${errors.length}) ---`);
    for (const e of errors) console.log(`  ${e}`);
  }

  console.log(`\nTotal calls attempted: ${totalCalls}  succeeded: ${results.length}  errored: ${errors.length}`);
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

main().catch((err: unknown) => {
  console.error("FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
