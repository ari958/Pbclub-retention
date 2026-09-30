import { useEffect, useState } from "react";
import { canApprove } from "@/lib/approvalGuards";
import type { Candidate } from "@/lib/retentionApi";

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
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", borderBottom: `1px solid ${D.border}`, fontSize: 12 }}>
      <span style={{ color: D.faint, fontFamily: mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", paddingTop: 2 }}>{k}</span>
      <span style={{ color: warn ? D.redText : D.text, textAlign: "right", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = { drafted: D.accent, approved: D.green, skipped: D.faint, sent: D.green };

export function ApprovalCard({ c, busy, selected, onToggle, onSave, onApprove, onSkip, onEditingChange }: {
  onEditingChange: (editing: boolean) => void;
  c: Candidate; busy: boolean; selected: boolean; onToggle: () => void;
  onSave: (body: string) => Promise<boolean>; onApprove: () => void; onSkip: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => { onEditingChange(editing); }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onEditingChange(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const x = c.context;
  const body = c.message?.body ?? "";
  const open = c.status === "drafted" || c.status === "approved";
  const pendingApproved = c.status === "approved";
  const np = x.next_program;

  return (
    <div data-testid={`card-candidate-${c.id}`} style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${D.border}`, background: D.inner }}>
        {c.status === "drafted" && (
          <input type="checkbox" checked={selected} onChange={onToggle} data-testid={`check-candidate-${c.id}`} aria-label="Include in bulk approval" />
        )}
        <span style={{ fontWeight: 600, fontSize: 13, color: D.text }}>{c.player?.name ?? x.player_first_name}</span>
        <span style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 3, border: `1px solid ${D.border}`, color: STATUS_COLOR[c.status] }} data-testid={`status-candidate-${c.id}`}>
          {c.status === "sent" && c.message?.simulated ? "sent (simulated)" : c.status}
        </span>
        {c.message?.simulated && (
          <span data-testid={`badge-simulated-${c.id}`} style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 3, background: D.accentBg, color: D.accent, border: "1px solid rgba(232,168,56,0.3)" }}>
            Simulated - not delivered
          </span>
        )}
        <span style={{ fontFamily: mono, fontSize: 10, color: D.faint, marginLeft: "auto" }}>{c.id.slice(0, 8)}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <div style={{ padding: 16, borderRight: `1px solid ${D.border}` }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: D.faint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Draft text</div>
          {editing ? (
            <>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} data-testid={`input-body-${c.id}`}
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
                <button style={btn()} onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </>
          ) : (
            <div data-testid={`text-body-${c.id}`} style={{ fontSize: 13, color: D.text, lineHeight: 1.65, whiteSpace: "pre-wrap", background: D.inner, border: `1px solid ${D.border}`, borderRadius: 6, padding: "10px 12px" }}>{body || "(no text)"}</div>
          )}
        </div>

        <div style={{ padding: 16 }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: D.faint, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Stored context facts</div>
          <Fact k="First name" v={x.player_first_name} />
          <Fact k="Trigger" v={`${x.trigger.name} on ${x.trigger.date}`} />
          <Fact k="Next program" v={np ? `${np.name}, ${np.date} ${np.time}` : "none found"} />
          {np && <Fact k="Spots left" v={np.spots_remaining ?? "unknown"} />}
          {np && <Fact k="Signup link" v={<span style={{ fontFamily: mono, fontSize: 11 }}>{np.signup_url}</span>} />}
          <Fact k="Classmates signed up" v={`${x.classmates_signed_up} (count only)`} />
          <Fact k="Already booked" v={x.already_booked ? "yes" : "no"} />
          {x.booked_event && <Fact k="Booked event" v={`${x.booked_event.name}, ${x.booked_event.date} ${x.booked_event.time}`} />}
          <Fact k="Promo" v={x.promo ? `${x.promo.code} - ${x.promo.offer_text}` : "none"} />
          {x.coupon_warning && <Fact k="Coupon warning" v={x.coupon_warning} warn />}
          <Fact k="Evaluated" v={fmt(x.evaluated_at)} />
        </div>
      </div>

      {x.coupon_warning && (
        <div style={{ padding: "8px 16px", fontSize: 12, color: D.redText, background: D.redBg, borderTop: `1px solid ${D.border}` }}>
          Coupon check failed: {x.coupon_warning}. Verify the code in the draft before approving.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: `1px solid ${D.border}`, flexWrap: "wrap" }}>
        {open && !editing && (
          <button style={btn(false, busy)} disabled={busy} data-testid={`button-edit-${c.id}`} onClick={() => { setDraft(body); setEditing(true); }}>Edit</button>
        )}
        {c.status === "drafted" && (
          <button style={btn(true, busy || editing)} disabled={busy || !canApprove(c, editing ? new Set([c.id]) : new Set())}
            title={editing ? "Save or cancel the edit first" : undefined} data-testid={`button-approve-${c.id}`} onClick={onApprove}>Approve</button>
        )}
        {editing && c.status === "drafted" && <span style={{ fontSize: 11, color: D.accent }}>Save or cancel the edit, then review the saved text to approve.</span>}
        {open && (
          <button style={btn(false, busy)} disabled={busy} data-testid={`button-skip-${c.id}`} onClick={onSkip}>Skip</button>
        )}
        <span style={{ marginLeft: "auto", fontFamily: mono, fontSize: 11, color: D.faint }} data-testid={`text-approval-${c.id}`}>
          {c.message?.approved_at && <>approved by {c.message.approved_by ?? "-"} at {fmt(c.message.approved_at)}</>}
          {c.message?.scheduled_send_at && !c.message.sent_at && <> / scheduled {fmt(c.message.scheduled_send_at)}</>}
          {c.message?.sent_at && <> / {c.message.simulated ? "simulated, not delivered" : "sent"} {fmt(c.message.sent_at)}</>}
        </span>
      </div>
    </div>
  );
}
