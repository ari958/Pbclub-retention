import { useState } from "react";
import { retentionApi, type Candidate } from "@/lib/retentionApi";

export function LtpTestTools({ candidate, slug, actor, onChanged }: {
  candidate: Candidate; slug: string; actor: string; onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const stepOne = candidate.step === 1 && candidate.status === "sent"
    && candidate.message?.retention_delivery_kind === "test";
  const stepTwo = candidate.step === 2 && candidate.status === "drafted" && candidate.context.ltp_test_mode === true;
  const resettable = candidate.status === "sent" && candidate.message?.simulated === true;
  if (candidate.playbook_key !== "ltp_followup" || (!resettable && candidate.sequence_status !== "active") || (!stepOne && !stepTwo && !resettable)) return null;
  const run = async (action: "backdate" | "draft" | "simulate_booking" | "dispatch_check" | "reset_simulated") => {
    if (!actor.trim()) { setResult("Enter your operator name above before using test tools."); return; }
    setBusy(true); setResult(null);
    try {
      const response = action === "draft"
        ? await retentionApi.draftTestStep2(slug, [candidate.id])
        : await retentionApi.ltpTestAction(slug, candidate.id, action, actor.trim());
      setResult(JSON.stringify(response, null, 2));
      await onChanged();
    } catch (error) { setResult(error instanceof Error ? error.message : "Test action failed"); }
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
    {result && <pre style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }} role="status">{result}</pre>}
  </section>;
}
