import { useState } from "react";
import { Link } from "react-router-dom";
import { envelopeRunIds } from "@/lib/retryContextEnvelope";
import { retentionApi, type Candidate } from "@/lib/retentionApi";
import type { RunResult } from "./RunResultBanner";

export function LtpTestTools({ candidate, slug, actor, onChanged, onRunResult }: {
  candidate: Candidate; slug: string; actor: string; onChanged: () => Promise<void>;
  onRunResult?: (result: RunResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [runIds, setRunIds] = useState<string[]>([]);
  const stepOne = candidate.step === 1 && candidate.status === "sent"
    && candidate.message?.retention_delivery_kind === "test";
  const stepTwo = candidate.step === 2 && candidate.status === "drafted" && candidate.context.ltp_test_mode === true;
  const resettable = candidate.status === "sent" && candidate.message?.simulated === true;
  if (candidate.playbook_key !== "ltp_followup" || (!resettable && candidate.sequence_status !== "active") || (!stepOne && !stepTwo && !resettable)) return null;
  const run = async (action: "backdate" | "draft" | "simulate_booking" | "dispatch_check" | "reset_simulated") => {
    if (!actor.trim()) { setResult("Enter your operator name above before using test tools."); return; }
    setBusy(true); setResult(null); setRunIds([]);
    try {
      const response = action === "draft"
        ? await retentionApi.draftTestStep2(slug, [candidate.id])
        : await retentionApi.ltpTestAction(slug, candidate.id, action, actor.trim());
      setResult(JSON.stringify(response, null, 2));
      setRunIds(envelopeRunIds(response as { run_id?: string | null; run_ids?: string[] }));
      if (action === "draft" || action === "reset_simulated") {
        onRunResult?.({ tone: "info", message: "Test draft generation finished. Nothing was approved or sent.",
          runIds: envelopeRunIds(response as { run_id?: string | null; run_ids?: string[] }) });
      }
      await onChanged();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Test action failed";
      const ids = (error as { runId?: string | null })?.runId ? [(error as { runId: string }).runId] : [];
      setResult(message); setRunIds(ids);
      if (action === "draft" || action === "reset_simulated") onRunResult?.({ tone: "error", message, runIds: ids });
    }
    finally { setBusy(false); }
  };
  return <section style={{ padding: 16, borderTop: "1px solid #30363d", fontSize: 12 }} data-testid={`ltp-test-tools-${candidate.id}`}>
    <strong>Test-only step 2 tools</strong>
    <p>Requires a verified test step-1 send and the configured test override. These actions never approve, schedule, or send.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {resettable && <button disabled={busy} onClick={() => void run("reset_simulated")}>Reset never-delivered simulation and rebuild draft</button>}
      {stepOne && <>
        <button disabled={busy} onClick={() => void run("backdate")}>Backdate test eligibility</button>
        <button disabled={busy} onClick={() => void run("draft")}>Draft test step 2</button>
      </>}
      {stepTwo && <>
        <button disabled={busy} onClick={() => {
          // The flag belongs to the source step-1 candidate; it is resolved
          // server-side from this step-2 sequence, never from a player name.
          void run("simulate_booking");
        }}>Simulate booking</button>
        <button disabled={busy} onClick={() => void run("dispatch_check")}>Check dispatch without sending</button>
      </>}
    </div>
    {result && <>
      <pre style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }} role="status">{result}</pre>
      <div style={{ display: "flex", gap: 12 }}>
        {runIds.map((id) => <Link key={id} to={`?generation_run=${encodeURIComponent(id)}`} data-testid={`link-view-run-${id}`} style={{ color: "#E8A838" }}>View details</Link>)}
        <button type="button" onClick={() => { setResult(null); setRunIds([]); }} data-testid={`button-dismiss-test-result-${candidate.id}`}>Dismiss</button>
      </div>
    </>}
  </section>;
}
