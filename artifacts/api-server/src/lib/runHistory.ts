import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { supabase } from "./supabaseClient";
import { logger } from "./logger";

export type RunStatus = "success" | "partial" | "failed";
export interface PlayerOutcome {
  player_id: string | null;
  player_name: string;
  outcome: "drafted" | "skipped" | "error";
  reason: string;
}
export interface SyncStep {
  name: string; started_at: string; finished_at: string | null;
  status: RunStatus | "skipped" | null; counts: Record<string, number>;
  error: string | null; generation_run_id?: string;
}
const requestContext = new AsyncLocalStorage<{ trigger: string; operator: string | null }>();
const generationContext = new AsyncLocalStorage<{
  clubId: string; outcomes: Map<string, PlayerOutcome>;
  candidatePlayers: Map<string, { id: string; name?: string | null }>;
  playbookKey: string | null;
}>();
const syncContext = new AsyncLocalStorage<{
  id: string; steps: SyncStep[]; failed: boolean; current?: SyncStep; failedStep?: string;
  row: object; writes: Promise<unknown>;
}>();
const pendingWrites = new Set<Promise<unknown>>();
function detachedWrite(write: Promise<unknown>) {
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
}
export async function flushRunHistoryForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("History flush is test-only");
  while (pendingWrites.size) await Promise.all([...pendingWrites]);
}
function syncSnapshot() {
  const scope = syncContext.getStore();
  if (!scope) return;
  const snapshot = structuredClone(scope.row);
  scope.writes = scope.writes.then(() => persist("nightly_sync_runs", snapshot));
  detachedWrite(scope.writes);
}

const triggers: Record<string, string> = {
  "/api/retention/generate": "Generate",
  "/api/retention/regenerate-batch": "Rebuild LTP",
  "/api/retention/retry-context": "Retry context batch",
  "/api/retention/test-tools/draft-step2": "Test step-2 drafts",
};
/** Request identity comes from the authenticated server session, not the body. */
export const runHistoryRequestContext: RequestHandler = (req, res, next) => {
  const path = req.originalUrl.split("?")[0];
  const label = triggers[path] ?? (path.endsWith("/reshuffle") ? "Reshuffle"
    : path.endsWith("/regenerate") ? "Regenerate"
    : path.endsWith("/retry-context") ? "Retry context"
    : path.includes("/test-tools/candidates/") ? "Test reset and regenerate" : "Generate");
  requestContext.run({ trigger: `button:${label}`, operator: res.locals.operator?.actor ?? null }, next);
};

async function persist(table: string, row: object) {
  // Bound logging I/O and absorb both SDK errors and exceptions. A final upsert
  // uses the same ID even if the initial write failed: never duplicate a run.
  try {
    const { error } = await supabase.from(table).upsert(structuredClone(row), { onConflict: "id" })
      .abortSignal(AbortSignal.timeout(1500));
    if (error) throw error;
    return true;
  } catch (error) {
    logger.warn({ table, error }, "Run history logging unavailable; original operation is unchanged");
    return false;
  }
}

export function recordPlayerOutcome(playerId: string | null, name: string | null | undefined,
  outcome: PlayerOutcome["outcome"], reason: string) {
  const context = generationContext.getStore();
  if (!context) return;
  const key = playerId ?? `run-error:${context.outcomes.size}`;
  const previous = context.outcomes.get(key);
  context.outcomes.set(key, {
    player_id: playerId, player_name: name ?? previous?.player_name ?? (playerId ? "Name unavailable" : "Run"),
    outcome, reason,
  });
}

export function recordPlayerName(id: string, name: string | null | undefined) {
  const outcome = generationContext.getStore()?.outcomes.get(id);
  if (outcome && name) outcome.player_name = name;
}
export function recordCandidatePlayer(candidateId: string, playerId: string, name?: string | null) {
  const context = generationContext.getStore();
  context?.candidatePlayers.set(candidateId, { id: playerId, name });
  if (context && !context.outcomes.has(playerId)) {
    recordPlayerOutcome(playerId, name, "skipped", "Not selected for drafting");
  }
  recordPlayerName(playerId, name);
}
export function recordGenerationPlaybook(key: string | null) {
  const context = generationContext.getStore();
  if (context) context.playbookKey = key;
}

const plainReasons: Record<string, string> = {
  duplicate: "Already drafted", already_returned: "Booked or attended since Learn to Play",
  test_player: "Test player", opted_out: "SMS opted out", sms_not_opted_in: "No SMS opt-in",
  missing_player: "Player record unavailable", missing_phone: "No phone number",
  holdout: "Experiment holdout", invalid_trigger: "Learn to Play session could not be verified",
  out_of_window: "Outside the selected Learn to Play window",
  no_matching_programs: "No open spots in a suitable suggested session",
  invalid_coupon: "Promo code invalid", coupon_invalid: "Promo code invalid",
  no_next_program: "No open spots in a suitable suggested session",
  no_phone: "No phone number", no_sms_consent: "No SMS opt-in",
  marketing_consent: "No SMS opt-in", already_booked: "Booked since Learn to Play",
};
export function plainOutcomeReason(reason: unknown): string {
  const text = typeof reason === "string" && reason ? reason : "No reason supplied";
  return plainReasons[text] ?? text.replaceAll("_", " ");
}

function summarizeResult(result: any) {
  for (const item of result?.drafts ?? result?.results ?? (result?.candidate_id ? [result] : [])) {
    const status = item.status;
    const player = generationContext.getStore()?.candidatePlayers.get(item.candidate_id);
    recordPlayerOutcome(item.player_id ?? player?.id ?? null, item.player_name ?? player?.name,
      status === "drafted" ? "drafted" : status === "skipped" ? "skipped" : "error",
      status === "drafted" ? "Draft ready for review; nothing approved or sent"
        : `${status === "needs_context" ? "Needs context: " : status === "manual_edit" ? "Manual edit needed: " : ""}${plainOutcomeReason(item.reason ?? item.context?.reason ?? item.error)}`);
  }
  for (const item of result?.failures ?? []) {
    const player = generationContext.getStore()?.candidatePlayers.get(item.candidate_id);
    recordPlayerOutcome(item.player_id ?? player?.id ?? null, item.player_name ?? player?.name, "error", plainOutcomeReason(item.error));
  }
  // Errors without an attributable player must still be counted and visible.
  for (const error of result?.errors ?? []) {
    const text = typeof error === "string" ? error : JSON.stringify(error);
    const identifier = text.match(/^([a-f0-9-]{36}):/)?.[1] ?? null;
    const playerId = identifier ? generationContext.getStore()?.candidatePlayers.get(identifier)?.id ?? identifier : null;
    const existing = playerId ? generationContext.getStore()?.outcomes.get(playerId) : null;
    if (existing?.outcome !== "error") recordPlayerOutcome(playerId, null, "error", plainOutcomeReason(text));
  }
}

export async function withGenerationRun<T>(clubId: string, playbookKey: string | null,
  defaultTrigger: string, operation: () => Promise<T>): Promise<T & { run_id: string | null }> {
  // Regenerate's internal retry path is part of the same run, not a second row.
  if (generationContext.getStore()?.clubId === clubId) return operation() as Promise<T & { run_id: string | null }>;
  const id = randomUUID();
  const scope = syncContext.getStore();
  const context = scope ? { trigger: "nightly", operator: null } : requestContext.getStore()
    ?? { trigger: `button:${defaultTrigger}`, operator: null };
  const row = { id, club_id: clubId, playbook_key: playbookKey, ...context,
    started_at: new Date().toISOString(), finished_at: null as string | null,
    status: null as RunStatus | null, evaluated: 0, drafted: 0, skipped: 0, errors: 0,
    details: { outcomes: [] as PlayerOutcome[] } };
  if (scope?.current) scope.current.generation_run_id = id;
  // Logging does not wait in the operation's critical path. Serialize snapshots
  // so a delayed initial write can never overwrite the completed record.
  const initialWrite = persist("retention_generation_runs", row);
  detachedWrite(initialWrite);
  return generationContext.run({ clubId, outcomes: new Map(), candidatePlayers: new Map(), playbookKey }, async () => {
    let value: T | undefined, failure: unknown, threw = false;
    try { value = await operation(); }
    catch (error) {
      threw = true; failure = error;
      let attributed = false;
      for (const outcome of generationContext.getStore()!.outcomes.values()) {
        if (outcome.reason === "Not selected for drafting") {
          attributed = true;
          outcome.outcome = "error";
          outcome.reason = `Generation stopped: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (!attributed) recordPlayerOutcome(null, null, "error", error instanceof Error ? error.message : String(error));
    }
    if (!threw) {
      try { summarizeResult(value); }
      catch (error) { logger.warn({ error }, "Run result summary unavailable; original result preserved"); }
    }
    row.details.outcomes = [...generationContext.getStore()!.outcomes.values()];
    row.playbook_key = generationContext.getStore()!.playbookKey;
    row.evaluated = row.details.outcomes.filter(outcome => outcome.player_id !== null).length;
    row.drafted = row.details.outcomes.filter(outcome => outcome.outcome === "drafted").length;
    row.skipped = row.details.outcomes.filter(outcome => outcome.outcome === "skipped").length;
    row.errors = row.details.outcomes.filter(outcome => outcome.outcome === "error").length;
    row.status = threw ? "failed" : row.errors ? row.drafted || row.skipped ? "partial" : "failed" : "success";
    row.finished_at = new Date().toISOString();
    const completed = structuredClone(row);
    detachedWrite(initialWrite.then(() => persist("retention_generation_runs", completed)));
    logger.info({ run_id: id, club_id: clubId, trigger: row.trigger, status: row.status,
      evaluated: row.evaluated, drafted: row.drafted, skipped: row.skipped, errors: row.errors },
    "Draft generation run completed");
    if (threw) {
      if (failure && typeof failure === "object" && Object.isExtensible(failure)) Object.assign(failure, { run_id: id });
      throw failure;
    }
    return Object.assign({}, value, { run_id: id });
  });
}

function numericCounts(result: any): Record<string, number> {
  const source = result?.stats ?? result ?? {};
  const counts = Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === "number" && Number.isFinite(value))) as Record<string, number>;
  if (Array.isArray(result?.results)) counts.drafts_created = result.results.filter((r: any) => r.status === "drafted").length;
  if (Array.isArray(result?.errors)) counts.errors = result.errors.length;
  if (Array.isArray(result?.failures)) counts.errors = result.failures.length;
  for (const [key, value] of Object.entries(result?.podplay ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) counts[`podplay_${key}`] = value;
  }
  return counts;
}
export async function observeSyncStep<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const context = syncContext.getStore();
  if (!context) return operation();
  const step: SyncStep = { name, started_at: new Date().toISOString(), finished_at: null, status: null, counts: {}, error: null };
  context.steps.push(step); context.current = step;
  syncSnapshot();
  try {
    const value = await operation();
    step.counts = numericCounts(value);
    step.status = step.error || step.counts.errors || step.counts.error_count ? "partial" : "success";
    const errors = (value as any)?.errors ?? (value as any)?.failures;
    if (Array.isArray(errors) && errors.length) step.error = errors.map((e: any) => typeof e === "string" ? e : e.error ?? JSON.stringify(e)).join("; ");
    return value;
  } catch (error) {
    step.status = "failed"; step.error = error instanceof Error ? error.message : String(error);
    context.failedStep = name;
    throw error;
  } finally { step.finished_at = new Date().toISOString(); context.current = undefined; syncSnapshot(); }
}
export function recordSyncStepError(message: string) {
  const step = syncContext.getStore()?.current;
  if (!step) return;
  step.error = step.error ? `${step.error}; ${message}` : message;
}
export function recordSyncStepMessage(message: string) {
  if (/\b(?:error|fatal|failed|failure)\b/i.test(message)) recordSyncStepError(message);
}
export function recordSkippedSyncStep(name: string, reason: string) {
  const now = new Date().toISOString();
  syncContext.getStore()?.steps.push({ name, started_at: now, finished_at: now, status: "skipped", counts: {}, error: reason });
  syncSnapshot();
}
export function markNightlyFailed(error: unknown, stepName?: string) {
  const context = syncContext.getStore();
  if (!context) return;
  context.failed = true;
  if (stepName) {
    context.failedStep = stepName;
    const step = [...context.steps].reverse().find(item => item.name === stepName);
    if (step) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : String(error);
      return;
    }
    const now = new Date().toISOString();
    context.steps.push({ name: stepName, started_at: now, finished_at: now,
      status: "failed", counts: {}, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!context.failedStep) {
    context.failedStep = "Startup/finalization";
    const now = new Date().toISOString();
    context.steps.push({ name: context.failedStep, started_at: now, finished_at: now,
      status: "failed", counts: {}, error: error instanceof Error ? error.message : String(error) });
  }
}
export function nightlyFailureDescription() {
  const context = syncContext.getStore();
  return `Nightly sync failed at ${context?.failedStep ?? "startup"}. Check sync history and job logs.`;
}
export function nightlyFailureKey() {
  return `nightly-run-failed:${syncContext.getStore()?.id ?? new Date().toISOString().slice(0, 10)}`;
}
const nightlyStepNames = [
  "Player import and DUPR refresh", "Event/attendance sync", "Retention step-1 drafts",
  "LTP step-2 drafts", "Confidence recomputation", "Buddy pairs", "Churn scores",
  "Legacy milestones", "Legacy monthly recap", "Event fill", "Program ratings", "Player timing",
];
export async function withNightlyRun<T>(clubId: string, trigger: "scheduled" | "manual", operation: () => Promise<T>): Promise<T> {
  const row = { id: randomUUID(), club_id: clubId, trigger, started_at: new Date().toISOString(),
    finished_at: null as string | null, status: null as RunStatus | null, steps: [] as SyncStep[] };
  const initialWrite = persist("nightly_sync_runs", row);
  detachedWrite(initialWrite);
  return syncContext.run({ id: row.id, steps: row.steps, failed: false, row, writes: initialWrite }, async () => {
    try { return await operation(); }
    catch (error) {
      markNightlyFailed(error);
      if (error && typeof error === "object" && Object.isExtensible(error)) Object.assign(error, {
        nightly_run_id: row.id, nightly_failed_step: syncContext.getStore()?.failedStep,
      });
      throw error;
    }
    finally {
      const context = syncContext.getStore()!;
      if (context.failed) {
        const observed = new Set(row.steps.map(step => step.name));
        for (const name of nightlyStepNames) {
          if (!observed.has(name)) recordSkippedSyncStep(name, "Not run because the nightly chain stopped");
        }
      }
      row.status = context.failed ? "failed" : row.steps.some(step => step.status === "failed" || step.status === "partial") ? "partial" : "success";
      row.finished_at = new Date().toISOString();
      syncSnapshot();
      logger.info({ run_id: row.id, club_id: clubId, trigger, status: row.status, steps: row.steps }, "Nightly sync run completed");
    }
  });
}
