import { useEffect, useState } from "react";
import { canApprove } from "@/lib/approvalGuards";
import type { Candidate } from "@/lib/retentionApi";
import { approvalVariantPresentation } from "@/lib/approvalVariant";
import { isRetryContextEligible } from "@/lib/retryContextEligibility";
import { canApproveLtpCandidate, canReshuffleLtpCandidate, formatLtpAttendanceDate, formatLtpNextProgramFact, formatLtpSessionWhen, formatLtpTriggerFact, isLtpCandidate } from "@/lib/ltpPhraseSlots";

const D = { card: "#0f1117", border: "#30363d", inner: "#1e2530", text: "#e6edf3", muted: "#8b949e", faint: "#6e7681",
  accent: "#E8A838", accentBg: "rgba(232,168,56,0.10)", green: "#2ea043", greenBg: "rgba(46,160,67,0.10)", redText: "#ff6b6b", redBg: "rgba(207,34,46,0.08)" };
const mono = "var(--font-mono)";

export const btn = (primary = false, disabled = false): React.CSSProperties => ({
  padding: "5px 12px", borderRadius: 5, fontSize: 12, fontWeight: 500, fontFamily: "var(--font-sans)",
  border: `1px solid ${primary ? "rgba(232,168,56,0.4)" : D.border}`,
  background: primary ? D.accentBg : D.inner, color: primary ? D.accent : D.muted,
  cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1,
});

function fmt(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "-" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Fact({ k, v, warn }: { k: string; v: React.ReactNode; warn?: boolean }) {
  return (
    <div className="approval-fact" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", borderBottom: `1px solid ${D.border}`, fontSize: 12 }}>
      <span style={{ color: D.faint, fontFamily: mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", paddingTop: 2 }}>{k}</span>
      <span className="approval-fact-value" style={{ color: warn ? D.redText : D.text, textAlign: "right", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  drafted: D.accent, approved: D.green, skipped: D.faint, sent: D.green,
  needs_context: D.redText, manual_edit: D.accent,
};

function formatIssue(issue: unknown): string {
  if (typeof issue === "string") return issue;
  if (issue === null || issue === undefined) return "Unknown error";
  try { return JSON.stringify(issue) ?? String(issue); } catch { return String(issue); }
}

export function ApprovalCard({ c, busy, selected, onToggle, onSave, onApprove, onSkip, onRegenerate, regenerating, onEditingChange, onRetryContext, retryContextReady, sequenceSchemaReady, onReshuffle, reshuffling, onLtpBatchRegenerate, testTools }: {
  onEditingChange: (editing: boolean) => void;
  c: Candidate; busy: boolean; selected: boolean; onToggle: () => void;
  onSave: (body: string) => Promise<boolean>; onApprove: () => void; onSkip: () => void;
  onRegenerate: () => void; regenerating: boolean;
  onRetryContext: () => void; retryContextReady: boolean;
  sequenceSchemaReady: boolean;
  onReshuffle: () => void;
  reshuffling: boolean;
  onLtpBatchRegenerate: () => void;
  testTools?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => { onEditingChange(editing); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onEditingChange(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (c.status !== "drafted" && c.status !== "manual_edit") setEditing(false);
  }, [c.status]);
  const x = c.context;
  const variant = approvalVariantPresentation(x.variant);
  const body = c.status === "manual_edit"
    ? x.generated_preview ?? c.message?.body ?? ""
    : c.message?.body ?? "";
  const open = c.status === "drafted";
  const editable = open || c.status === "manual_edit";
  const pendingApproved = c.status === "approved";
  const ltpCandidate = isLtpCandidate(c);
  const np = x.next_program;
  const ltpAttendanceDate = formatLtpAttendanceDate(c);
  const requiredNoProgramDate = ltpCandidate
    ? ltpAttendanceDate ? `on ${ltpAttendanceDate}` : "NOW (required; missing from stored context)"
    : x.date_phrase ?? "NOW (required; missing from stored context)";
  const missingNoProgramDate = ltpCandidate ? !ltpAttendanceDate : !x.date_phrase;
  const issues = [...(x.errors ?? []), ...(x.validation_errors ?? [])];
  const playerName = c.player?.name ?? x.player_first_name ?? "Unknown player";
  const retryContextEligible = isRetryContextEligible(c.status, x.reason);
  const step = c.step ?? x.ltp_text?.step ?? 1;
  const legacyLtpDraft = ltpCandidate && c.status === "drafted" && !x.ltp_text && x.reason !== "session_changed";
  const approvableLtp = canApproveLtpCandidate(c, sequenceSchemaReady);
  const resharplableLtp = canReshuffleLtpCandidate(c, sequenceSchemaReady);
  const sequenceStatusColor = c.sequence_status === "active" ? D.green : D.faint;
  const sessionChanged = ltpCandidate && x.reason === "session_changed";
  const sessionTimeChanged = sessionChanged && x.session_change?.reason === "start_time_changed";

  return (
    <div className="approval-card" data-testid={`card-candidate-${c.id}`} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div className="approval-card-header" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${D.border}`, background: D.inner }}>
        {c.status === "drafted" && (
          <input type="checkbox" checked={selected} onChange={onToggle} disabled={busy || (ltpCandidate && !approvableLtp)} data-testid={`check-candidate-${c.id}`} aria-label="Include in bulk approval" title={legacyLtpDraft ? "Rebuild this model-built draft as a slot-based step-one text before approval" : undefined} />
        )}
        <span style={{ fontWeight: 600, fontSize: 13, color: D.text }}>{playerName}</span>
        <span style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 3, border: `1px solid ${D.border}`, color: STATUS_COLOR[c.status] }} data-testid={`status-candidate-${c.id}`}>
          {c.status === "sent" && c.message?.simulated ? "sent (simulated)" : c.status.replace("_", " ")}
        </span>
        <span data-testid={`variant-candidate-${c.id}`} style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: D.accentBg, color: D.accent, border: "1px solid rgba(232,168,56,0.3)" }}>
          {variant.label}
        </span>
        {ltpCandidate && (
          <>
            <span data-testid={`badge-ltp-step-${c.id}`} style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: D.inner, color: D.text, border: `1px solid ${D.border}` }}>
              Step {step}
            </span>
            <span data-testid={`badge-ltp-sequence-${c.id}`} style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: D.inner, color: sequenceStatusColor, border: `1px solid ${D.border}` }}>
              {c.sequence_status ?? "sequence unavailable"}
            </span>
          </>
        )}
        {x.stale === true && (
          <span data-testid={`badge-stale-${c.id}`} style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: D.accentBg, color: D.accent, border: "1px solid rgba(232,168,56,0.3)" }}>
            Stale test draft · {x.lookback_days ?? "unknown"}-day test lookback
          </span>
        )}
        {c.message?.simulated && (
          <span data-testid={`badge-simulated-${c.id}`} style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: D.accentBg, color: D.accent, border: "1px solid rgba(232,168,56,0.3)" }}>
            Simulated - not delivered
          </span>
        )}
        <span style={{ fontFamily: mono, fontSize: 10, color: D.faint, marginLeft: "auto" }}>{c.id.slice(0, 8)}</span>
      </div>

      <div className="approval-card-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <div className="approval-card-copy" style={{ padding: 16, borderRight: `1px solid ${D.border}` }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: D.faint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>{c.status === "manual_edit" ? "Invalid preview - manual edit required" : "Draft text"}</div>
          {editing ? (
            <>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} disabled={busy} data-testid={`input-body-${c.id}`}
                style={{ width: "100%", boxSizing: "border-box", padding: 10, borderRadius: 5, border: `1px solid ${D.border}`, background: D.inner, color: D.text, fontFamily: "var(--font-sans)", fontSize: 13, lineHeight: 1.6 }} />
              <div style={{ fontSize: 11, color: D.faint, fontFamily: mono, marginTop: 4 }}>{draft.length} chars / {Math.max(1, Math.ceil(draft.length / 160))} SMS</div>
              {pendingApproved && (
                <div style={{ marginTop: 8, fontSize: 12, color: D.accent, background: D.accentBg, border: "1px solid rgba(232,168,56,0.25)", borderRadius: 5, padding: "8px 10px", lineHeight: 1.5 }}>
                  This draft is approved{c.message?.scheduled_send_at ? ` and scheduled for ${fmt(c.message.scheduled_send_at)}` : ""}. Saving an edit resets the approval and clears the schedule. It will need to be approved again.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button style={btn(true, busy || !draft.trim())} disabled={busy || !draft.trim()} data-testid={`button-save-${c.id}`}
                  onClick={async () => { if (await onSave(draft.trim())) setEditing(false); }}>
                  {pendingApproved ? "Save and reset approval" : "Save edit"}
                </button>
                <button style={btn(false, busy)} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <div data-testid={`text-body-${c.id}`} style={{ fontSize: 13, color: D.text, lineHeight: 1.65, whiteSpace: "pre-wrap", background: D.inner, border: `1px solid ${D.border}`, borderRadius: 6, padding: "10px 12px" }}>{body || "(no text)"}</div>
          )}
        </div>

        {ltpCandidate && step === 2 && (
          <div data-testid={`panel-ltp-step-one-${c.id}`} style={{ gridColumn: "1 / -1", borderTop: `1px solid ${D.border}`, padding: 16 }}>
            <div style={{ fontFamily: mono, fontSize: 10, color: D.faint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 7 }}>
              Step 1 text · sent {c.step1_sent_at ? fmt(c.step1_sent_at) : "timestamp unavailable"}
            </div>
            <div data-testid={`text-ltp-step-one-${c.id}`} style={{ fontSize: 13, color: c.step1_text ? D.text : D.redText, lineHeight: 1.65, whiteSpace: "pre-wrap", background: D.inner, border: `1px solid ${D.border}`, borderRadius: 6, padding: "10px 12px" }}>
              {c.step1_text ?? "Step 1 text is unavailable; review its sequence before approval."}
            </div>
          </div>
        )}

        <div style={{ padding: 16 }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: D.faint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Stored context facts</div>
          <Fact k="First name" v={x.player_first_name ?? "unavailable"} />
          <Fact k="Trigger" v={formatLtpTriggerFact(c)} />
          <Fact k="Next program" v={variant.kind === "no_program" ? "No suggestion" : formatLtpNextProgramFact(c)} />
          {variant.kind === "no_program" && (
            <Fact k="Booking URL" v={x.booking_url
              ? <a href={x.booking_url} target="_blank" rel="noopener noreferrer" style={{ color: D.accent }}>{x.booking_url}</a>
              : "unavailable"} />
          )}
          {variant.kind !== "no_program" && np && <Fact k="Spots left" v={np.spots_remaining ?? "unknown"} />}
          {variant.kind !== "no_program" && np && <Fact k="Signup link" v={<span style={{ fontFamily: mono, fontSize: 11 }}>{np.signup_url}</span>} />}
          <Fact k="Classmates signed up" v={variant.kind === "no_program" ? "No next program to count" : `${x.classmates_signed_up ?? "unknown"} (count only)`} />
          <Fact k="Already booked" v={variant.kind === "no_program" || x.already_booked == null ? "unknown" : x.already_booked ? "yes" : "no"} />
          {x.booked_event && <Fact k="Booked event" v={`${x.booked_event.name}, ${x.booked_event.date} ${x.booked_event.time}`} />}
          <Fact k="Promo" v={x.promo ? `${x.promo.code} - ${x.promo.offer_text}` : "none"} />
          {x.coupon_warning && <Fact k="Coupon warning" v={x.coupon_warning} warn />}
          {variant.kind === "no_program"
            ? <Fact k="Required date phrase" v={requiredNoProgramDate} warn={missingNoProgramDate} />
            : x.date_phrase && <Fact k="Required date phrase" v={x.date_phrase} />}
          {variant.kind === "no_program" && <Fact k="No-program message" v="Thank the player for attending Learn to Play, then invite them to book now." />}
          {(x.send_date_et || x.send_date) && <Fact k="Intended send date (ET)" v={x.send_date_et ?? x.send_date!} />}
          <Fact k="Evaluated" v={fmt(x.evaluated_at)} />
        </div>
      </div>

      {sessionChanged && (
        <div role="alert" data-testid={`banner-session-changed-${c.id}`} style={{ padding: "12px 16px", color: D.redText, background: D.redBg, borderTop: `1px solid ${D.border}`, fontSize: 12, lineHeight: 1.6 }}>
          <strong>{sessionTimeChanged ? "Session time changed, regenerate before approving" : "Session changed, regenerate before approving"}</strong>
          {sessionTimeChanged && <div>Previously: {formatLtpSessionWhen(x.session_change?.old_start_time ?? "") ?? "unavailable"} ET · Current: {formatLtpSessionWhen(x.session_change?.new_start_time ?? "") ?? "unavailable"} ET</div>}
          <div>The prior approval has been cleared. Regenerate the draft, review the updated session, and approve it again before it can send.</div>
        </div>
      )}
      {(c.status === "needs_context" || c.status === "manual_edit" || x.reason || issues.length > 0) && (
        <div data-testid={`panel-context-issues-${c.id}`} role="note" style={{ padding: "10px 16px", fontSize: 12, color: c.status === "needs_context" ? D.redText : D.accent, background: c.status === "needs_context" ? D.redBg : D.accentBg, borderTop: `1px solid ${D.border}`, lineHeight: 1.55 }}>
          <strong>{c.status === "needs_context" ? "Context required" : c.status === "manual_edit" ? "Manual edit required" : "Context and validation details"}</strong>
          {x.reason && <div data-testid={`text-reason-${c.id}`}>Reason: {x.reason}</div>}
          {issues.length > 0 && (
            <ul data-testid={`list-context-errors-${c.id}`} style={{ margin: "5px 0 0", paddingLeft: 18 }}>
              {issues.map((issue, index) => <li key={index}>{formatIssue(issue)}</li>)}
            </ul>
          )}
          {c.status === "manual_edit" && <div>Correct the text and save it for review. Approval is available only if the saved candidate returns to drafted status.</div>}
        </div>
      )}

      {x.coupon_warning && (
        <div style={{ padding: "8px 16px", fontSize: 12, color: D.redText, background: D.redBg, borderTop: `1px solid ${D.border}` }}>
          Coupon check failed: {x.coupon_warning}. Verify the code in the draft before approving.
        </div>
      )}

      <div className="approval-card-footer" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: `1px solid ${D.border}`, flexWrap: "wrap" }}>
        {editable && !editing && (
          <button style={btn(false, busy)} disabled={busy} data-testid={`button-edit-${c.id}`} onClick={() => { setDraft(body); setEditing(true); }}>Edit</button>
        )}
        {c.status === "drafted" && (
          <button style={btn(true, busy || editing || (ltpCandidate && !approvableLtp))} disabled={busy || !canApprove(c, editing ? new Set([c.id]) : new Set()) || (ltpCandidate && !approvableLtp)}
            title={editing ? "Save or cancel the edit first" : undefined} data-testid={`button-approve-${c.id}`} onClick={onApprove}>Approve</button>
        )}
        {editing && c.status === "drafted" && <span style={{ fontSize: 11, color: D.accent }}>Save or cancel the edit, then review the saved text to approve.</span>}
        {open && (
          <button style={btn(false, busy)} disabled={busy} data-testid={`button-skip-${c.id}`} onClick={onSkip}>Skip</button>
        )}
        {ltpCandidate && c.status === "drafted" && step === 1 && !x.ltp_text && !sessionChanged && sequenceSchemaReady && (
          <button style={btn(false, busy || editing)} disabled={busy || editing} data-testid={`button-rebuild-ltp-${c.id}`} onClick={onLtpBatchRegenerate}>
            Rebuild step 1 cohort
          </button>
        )}
        {resharplableLtp && (
          <button style={btn(false, busy || editing || reshuffling)} disabled={busy || editing || reshuffling} data-testid={`button-reshuffle-ltp-${c.id}`} onClick={onReshuffle}>
            {reshuffling ? "Reshuffling..." : "Reshuffle"}
          </button>
        )}
        {!ltpCandidate && c.status === "drafted" && (
          <button style={btn(false, busy || editing)} disabled={busy || editing} data-testid={`button-regenerate-${c.id}`} onClick={onRegenerate}>
            {regenerating ? "Regenerating..." : "Regenerate"}
          </button>
        )}
        {sessionChanged && c.status === "drafted" && sequenceSchemaReady && (
          <button style={btn(false, busy || editing)} disabled={busy || editing} data-testid={`button-regenerate-session-${c.id}`} onClick={onRegenerate}>
            {regenerating ? "Regenerating..." : "Regenerate"}
          </button>
        )}
        {legacyLtpDraft && (
          <span data-testid={`notice-ltp-legacy-${c.id}`} role="note" style={{ width: "100%", color: D.accent, fontSize: 11 }}>
            This pre-sequence draft is blocked from approval until its slot-based sequence text is rebuilt. Migration does not approve or send texts.
          </span>
        )}
        {ltpCandidate && c.status === "drafted" && !sequenceSchemaReady && (
          <span role="note" data-testid={`notice-ltp-sequence-schema-${c.id}`} style={{ width: "100%", color: D.accent, fontSize: 11 }}>
            Migration 013 is not ready. LTP approvals, rebuilding, and reshuffling are disabled.
          </span>
        )}
        {ltpCandidate && c.status === "drafted" && sequenceSchemaReady && !approvableLtp && !legacyLtpDraft && !sessionChanged && (
          <span role="note" data-testid={`notice-ltp-approval-blocked-${c.id}`} style={{ width: "100%", color: D.accent, fontSize: 11 }}>
            This LTP draft is not eligible for approval{c.context.reason ? `: ${c.context.reason}` : c.sequence_status !== "active" ? `: sequence is ${c.sequence_status ?? "unavailable"}` : c.step !== c.context.ltp_text?.step ? ": step marker is inconsistent" : ": required slot-based context is incomplete"}.
            Rebuild the active step-one cohort and review the refreshed text before approving.
          </span>
        )}
        {retryContextEligible && (
          <button
            style={btn(false, busy || !retryContextReady)}
            disabled={busy || !retryContextReady}
            title={!retryContextReady ? "Apply migration 012 before retrying context" : undefined}
            data-testid={`button-retry-context-${c.id}`}
            onClick={onRetryContext}
          >
            Retry context
          </button>
        )}
        <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 11, color: D.faint }} data-testid={`text-approval-${c.id}`}>
          {c.message?.approved_at && <>approved by {c.message.approved_by ?? "-"} at {fmt(c.message.approved_at)}</>}
          {c.message?.scheduled_send_at && !c.message.sent_at && <> / scheduled {fmt(c.message.scheduled_send_at)}</>}
          {c.message?.sent_at && <> / {c.message.simulated ? "simulated, not delivered" : "sent"} {fmt(c.message.sent_at)}</>}
        </span>
      </div>
      {testTools}
    </div>
  );
}
