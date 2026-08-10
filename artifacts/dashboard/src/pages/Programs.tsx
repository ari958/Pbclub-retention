/**
 * Programs — Programming Agent dashboard.
 *
 * Two views:
 *   "Upcoming risk"   — events whose rule checkpoints fire within 96h,
 *                       sorted by nearest trigger, showing both agent and
 *                       native PodPlay predictions.
 *   "Decision log"    — historical programming_decisions rows, newest first.
 *
 * Read-only. No action buttons (Phase 2 shadow evaluation only).
 */
import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";

// ── Constants ─────────────────────────────────────────────────────────────────

const C = {
  bg:       "#0d1117",
  surface:  "#161b22",
  surface2: "#1c2129",
  border:   "#21262d",
  text:     "#e6edf3",
  textSub:  "#8b949e",
  textDim:  "#484f58",
  accent:   "#e8a838",
  green:    "#3fb950",
  red:      "#f85149",
  blue:     "#58a6ff",
  orange:   "#d29922",
  mono:     "var(--font-mono, 'JetBrains Mono', monospace)",
  sans:     "var(--font-sans, system-ui, sans-serif)",
};

const API = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day:   "numeric",
    hour:  "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  }) + " ET";
}

function fmtHours(h: number): string {
  if (h < 0) return `${Math.abs(Math.round(h))}h ago`;
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${Math.round(h)}h`;
}

function DecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return <span style={{ color: C.textDim, fontFamily: C.mono, fontSize: 11 }}>—</span>;
  const color =
    decision === "CANCEL"    ? C.red :
    decision === "ALERT"     ? C.orange :
    decision === "NO_ACTION" ? C.green : C.textSub;
  const label =
    decision === "CANCEL"    ? "CANCEL" :
    decision === "ALERT"     ? "ALERT" :
    decision === "NO_ACTION" ? "OK" : decision;
  return (
    <span style={{
      fontFamily: C.mono,
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.06em",
      color,
      background: `${color}22`,
      padding: "2px 6px",
      borderRadius: 4,
    }}>{label}</span>
  );
}

function NativeBadge({ wouldCancel }: { wouldCancel: boolean | null }) {
  if (wouldCancel === null) return <span style={{ color: C.textDim, fontFamily: C.mono, fontSize: 11 }}>—</span>;
  return (
    <span style={{
      fontFamily: C.mono,
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.06em",
      color:      wouldCancel ? C.red : C.green,
      background: wouldCancel ? `${C.red}22` : `${C.green}22`,
      padding: "2px 6px",
      borderRadius: 4,
    }}>{wouldCancel ? "CANCEL" : "OK"}</span>
  );
}

function UrgencyDot({ hours }: { hours: number }) {
  const color =
    hours <= 0    ? C.red :
    hours <= 12   ? C.orange :
    hours <= 48   ? "#e8a838" : C.textDim;
  return (
    <span style={{
      display: "inline-block",
      width: 6, height: 6,
      borderRadius: "50%",
      background: color,
      flexShrink: 0,
      marginRight: 6,
      marginTop: 1,
    }} />
  );
}

// ── Upcoming Risk view ────────────────────────────────────────────────────────

function UpcomingRiskView({ clubId }: { clubId: string }) {
  const [rows, setRows]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evalMsg, setEvalMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/programming/upcoming-risk?clubId=${clubId}`);
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setRows(d.rows ?? []);
      setUpdatedAt(d.evaluated_at ?? null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [clubId]);

  useEffect(() => { load(); }, [load]);

  async function runEvaluator() {
    setEvaluating(true);
    setEvalMsg(null);
    try {
      const r = await fetch(`${API}/programming/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubId }),
      });
      const d = await r.json();
      if (r.status === 202) {
        setEvalMsg("Evaluator started — decisions will appear in the log after it finishes.");
      } else if (r.status === 409) {
        setEvalMsg("Evaluator already running.");
      } else {
        setEvalMsg(d.error ?? "Unknown response");
      }
    } catch (e: any) {
      setEvalMsg(e.message);
    } finally {
      setEvaluating(false);
    }
  }

  if (loading) {
    return (
      <div style={{ color: C.textDim, fontSize: 13, padding: "40px 0" }}>
        Loading upcoming events…
      </div>
    );
  }

  if (error) {
    // If 400 (clubId missing) or table doesn't exist, show setup message
    const isSetup = error.includes("42P01") || error.includes("does not exist") || error.includes("programming_rules");
    if (isSetup) {
      return <SchemaNotice />;
    }
    return (
      <div style={{ color: C.red, fontSize: 13, padding: "20px 0" }}>
        Error: {error}
      </div>
    );
  }

  return (
    <div>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        {updatedAt && (
          <span style={{ fontSize: 11, color: C.textDim, fontFamily: C.mono }}>
            as of {fmtTime(updatedAt)}
          </span>
        )}
        <button
          onClick={load}
          style={{
            background: "none", border: `1px solid ${C.border}`,
            color: C.textSub, fontSize: 11, padding: "4px 10px",
            borderRadius: 6, cursor: "pointer",
          }}
        >
          Refresh
        </button>
        <button
          onClick={runEvaluator}
          disabled={evaluating}
          style={{
            background: evaluating ? C.surface2 : C.accent,
            border: "none",
            color: evaluating ? C.textDim : "#0d1117",
            fontSize: 11, fontWeight: 600, padding: "4px 12px",
            borderRadius: 6, cursor: evaluating ? "default" : "pointer",
          }}
        >
          {evaluating ? "Starting…" : "Run Evaluator"}
        </button>
        {evalMsg && (
          <span style={{ fontSize: 11, color: C.textSub }}>{evalMsg}</span>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No upcoming events matched by any rule"
          subtitle="Enable a programming_rule with checkpoints ≤96h to see events here."
        />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["", "Event", "Program", "Start", "Trigger", "Signups", "Threshold", "Agent", "Native"].map((h, i) => (
                  <th key={i} style={{
                    padding: "6px 10px",
                    textAlign: "left",
                    fontFamily: C.mono,
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: "0.06em",
                    color: C.textDim,
                    whiteSpace: "nowrap",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const fired = row.trigger_fired;
                const urgent = !fired && row.hours_until_trigger <= 12;
                return (
                  <tr key={i} style={{
                    borderBottom: `1px solid ${C.border}`,
                    background: i % 2 === 0 ? "transparent" : C.surface2,
                    opacity: fired ? 0.7 : 1,
                  }}>
                    <td style={{ padding: "8px 4px 8px 10px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <UrgencyDot hours={row.hours_until_trigger} />
                      </div>
                    </td>
                    <td style={{ padding: "8px 10px", maxWidth: 240 }}>
                      <div style={{ color: C.text, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {row.event_name ?? row.event_id.slice(0, 8)}
                      </div>
                      <div style={{ color: C.textDim, fontFamily: C.mono, fontSize: 10, marginTop: 2 }}>
                        {row.event_id.slice(0, 8)}
                      </div>
                    </td>
                    <td style={{ padding: "8px 10px", color: C.textSub, whiteSpace: "nowrap" }}>
                      {row.archetype_name ?? "—"}
                    </td>
                    <td style={{ padding: "8px 10px", color: C.textSub, whiteSpace: "nowrap" }}>
                      {fmtTime(row.event_start_time)}
                      <div style={{ color: C.textDim, fontFamily: C.mono, fontSize: 10, marginTop: 2 }}>
                        in {fmtHours(row.hours_until_start)}
                      </div>
                    </td>
                    <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                      <div style={{
                        color: urgent ? C.orange : fired ? C.textDim : C.textSub,
                        fontFamily: C.mono, fontSize: 11,
                        fontWeight: urgent ? 600 : 400,
                      }}>
                        {fired
                          ? `FIRED ${fmtHours(row.hours_until_trigger)}`
                          : `−${fmtHours(row.hours_until_trigger)}`}
                      </div>
                      <div style={{ color: C.textDim, fontSize: 10, marginTop: 2 }}>
                        {row.rule_name}
                      </div>
                    </td>
                    <td style={{ padding: "8px 10px", color: C.text, fontFamily: C.mono, textAlign: "center" }}>
                      {row.last_signup_count !== null
                        ? <span style={{ fontWeight: 600 }}>{row.last_signup_count}</span>
                        : <span style={{ color: C.textDim }}>—</span>}
                    </td>
                    <td style={{ padding: "8px 10px", color: C.textSub, fontFamily: C.mono, textAlign: "center" }}>
                      {row.checkpoint_min_signups}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "center" }}>
                      {row.last_decision
                        ? <DecisionBadge decision={row.last_decision} />
                        : <span style={{ color: C.textDim, fontFamily: C.mono, fontSize: 10 }}>not run</span>}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "center" }}>
                      {row.native_threshold !== null ? (
                        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.textSub }}>
                          {row.native_threshold} @ {row.native_hours_before}h
                        </span>
                      ) : (
                        <span style={{ color: C.textDim, fontFamily: C.mono, fontSize: 10 }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Decision Log view ─────────────────────────────────────────────────────────

function DecisionLogView({ clubId }: { clubId: string }) {
  const [decisions, setDecisions] = useState<any[]>([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [page, setPage]           = useState(0);
  const PAGE_SIZE = 50;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `${API}/programming/decisions?clubId=${clubId}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      );
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setDecisions(d.decisions ?? []);
      setTotal(d.count ?? 0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [clubId, page]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div style={{ color: C.textDim, fontSize: 13, padding: "40px 0" }}>Loading decisions…</div>;
  }

  if (error) {
    const isSetup = error.includes("42P01") || error.includes("does not exist") || error.includes("programming_decisions");
    if (isSetup) return <SchemaNotice />;
    return <div style={{ color: C.red, fontSize: 13, padding: "20px 0" }}>Error: {error}</div>;
  }

  if (decisions.length === 0 && total === 0) {
    return (
      <EmptyState
        icon="list"
        title="No decisions recorded yet"
        subtitle="Run the evaluator from the Upcoming Risk tab once rules are configured."
      />
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 12, color: C.textDim }}>
        {total} decision{total !== 1 ? "s" : ""}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Evaluated", "Event", "Checkpoint", "Signups / Cap", "Agent", "Native Cancel", "Mode", "Executed"].map((h, i) => (
                <th key={i} style={{
                  padding: "6px 10px",
                  textAlign: "left",
                  fontFamily: C.mono,
                  fontSize: 10,
                  fontWeight: 500,
                  letterSpacing: "0.06em",
                  color: C.textDim,
                  whiteSpace: "nowrap",
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {decisions.map((d: any, i: number) => (
              <tr key={d.id} style={{
                borderBottom: `1px solid ${C.border}`,
                background: i % 2 === 0 ? "transparent" : C.surface2,
              }}>
                <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                  <div style={{ color: C.textSub, fontFamily: C.mono, fontSize: 11 }}>
                    {fmtTime(d.evaluated_at)}
                  </div>
                </td>
                <td style={{ padding: "8px 10px", maxWidth: 220 }}>
                  <div style={{ color: C.text, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {d.event_name ?? d.event_id?.slice(0, 8)}
                  </div>
                  {d.event_start_time && (
                    <div style={{ color: C.textDim, fontSize: 10, marginTop: 2 }}>
                      {fmtTime(d.event_start_time)}
                    </div>
                  )}
                </td>
                <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                  <div style={{ color: C.textSub, fontFamily: C.mono, fontSize: 11 }}>
                    cp {d.checkpoint_index} @ −{d.checkpoint_offset_hours}h
                  </div>
                  <div style={{ color: C.textDim, fontSize: 10, marginTop: 2 }}>
                    min {d.checkpoint_min_signups}
                  </div>
                </td>
                <td style={{ padding: "8px 10px", fontFamily: C.mono, textAlign: "center" }}>
                  <span style={{
                    color: d.signup_count < d.checkpoint_min_signups ? C.red : C.green,
                    fontWeight: 600,
                  }}>
                    {d.signup_count}
                  </span>
                  <span style={{ color: C.textDim }}> / {d.total_teams}</span>
                </td>
                <td style={{ padding: "8px 10px", textAlign: "center" }}>
                  <DecisionBadge decision={d.decision} />
                </td>
                <td style={{ padding: "8px 10px", textAlign: "center" }}>
                  <NativeBadge wouldCancel={d.native_would_cancel} />
                </td>
                <td style={{ padding: "8px 10px" }}>
                  <span style={{
                    fontFamily: C.mono,
                    fontSize: 10,
                    color: d.mode === "shadow" ? C.textDim : C.accent,
                    background: d.mode === "shadow" ? `${C.textDim}18` : `${C.accent}22`,
                    padding: "2px 6px",
                    borderRadius: 4,
                  }}>{d.mode}</span>
                </td>
                <td style={{ padding: "8px 10px", textAlign: "center" }}>
                  <span style={{ fontFamily: C.mono, fontSize: 10, color: d.executed ? C.green : C.textDim }}>
                    {d.executed ? "yes" : "no"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{ ...paginationBtn, opacity: page === 0 ? 0.4 : 1 }}
          >← Prev</button>
          <span style={{ color: C.textDim, fontSize: 11, fontFamily: C.mono }}>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={(page + 1) * PAGE_SIZE >= total}
            style={{ ...paginationBtn, opacity: (page + 1) * PAGE_SIZE >= total ? 0.4 : 1 }}
          >Next →</button>
        </div>
      )}
    </div>
  );
}

const paginationBtn: React.CSSProperties = {
  background: "none",
  border: `1px solid ${C.border}`,
  color: C.textSub,
  fontSize: 11,
  padding: "4px 10px",
  borderRadius: 6,
  cursor: "pointer",
};

// ── Shared components ─────────────────────────────────────────────────────────

function SchemaNotice() {
  return (
    <div style={{
      marginTop: 48,
      background: C.surface2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "24px 28px",
      maxWidth: 560,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 8 }}>
        Schema migration required
      </div>
      <div style={{ fontSize: 12, color: C.textSub, lineHeight: 1.7 }}>
        The <code style={{ fontFamily: C.mono, color: C.accent }}>programming_rules</code> and{" "}
        <code style={{ fontFamily: C.mono, color: C.accent }}>programming_decisions</code> tables
        don't exist yet. Run the migration in your Supabase SQL editor:
      </div>
      <code style={{
        display: "block",
        marginTop: 12,
        fontFamily: C.mono,
        fontSize: 11,
        color: C.blue,
        background: C.bg,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "10px 14px",
        wordBreak: "break-all",
      }}>
        artifacts/api-server/migrations/004_programming_tables.sql
      </code>
    </div>
  );
}

function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  const paths: Record<string, string> = {
    clock: "M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 5v5l4 2",
    list:  "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  };
  return (
    <div style={{ marginTop: 64, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
        stroke={C.textDim} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={paths[icon] ?? paths.list} />
      </svg>
      <div style={{ fontSize: 14, fontWeight: 500, color: C.textSub }}>{title}</div>
      <div style={{ fontSize: 12, color: C.textDim, textAlign: "center", maxWidth: 340, lineHeight: 1.6 }}>
        {subtitle}
      </div>
    </div>
  );
}

// ── Root page ─────────────────────────────────────────────────────────────────

// ── Promotion Queue view ──────────────────────────────────────────────────────

function PromoteBadge() {
  return (
    <span style={{
      fontFamily: C.mono, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
      color: C.accent, background: `${C.accent}22`, padding: "2px 7px", borderRadius: 4,
    }}>PROMOTE</span>
  );
}

function fmtDaysAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d === 0) return "today";
  if (d === 1) return "1d ago";
  return `${d}d ago`;
}

function FunnelBar({ label, total, count, prev, tooltipNote }: {
  label: string; total: number; count: number; prev?: number; tooltipNote?: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const removed = prev != null ? prev - count : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
      <div style={{ width: 160, fontSize: 11, color: C.textSub, flexShrink: 0, textAlign: "right" }}>{label}</div>
      <div style={{ flex: 1, maxWidth: 240, background: C.surface2, borderRadius: 3, height: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, background: C.accent, height: "100%", borderRadius: 3 }} />
      </div>
      <div style={{ width: 44, fontFamily: C.mono, fontSize: 11, color: C.text, textAlign: "right", flexShrink: 0 }}>
        {count.toLocaleString()}
      </div>
      {removed > 0 && (
        <div style={{ width: 72, fontFamily: C.mono, fontSize: 10, color: C.red, flexShrink: 0 }}>
          −{removed.toLocaleString()}
        </div>
      )}
      {tooltipNote && (
        <div style={{ fontSize: 9, fontFamily: C.mono, color: C.textDim, flexShrink: 0 }}>
          {tooltipNote}
        </div>
      )}
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 30 ? C.green : score >= 10 ? C.accent : C.textSub;
  return (
    <span style={{ fontFamily: C.mono, fontSize: 11, fontWeight: 600, color }}>
      {score}
    </span>
  );
}

function WarmBadge({ ws }: { ws: number | undefined }) {
  if (ws == null) return <span style={{ color: C.textDim, fontFamily: C.mono, fontSize: 11 }}>—</span>;
  const color = ws >= 4 ? C.green : ws >= 1 ? C.blue : C.textDim;
  return <span style={{ fontFamily: C.mono, fontSize: 11, color }}>{ws}</span>;
}

function ReasonPill({ label }: { label: string }) {
  return (
    <span style={{
      display: "inline-block",
      fontFamily: C.mono, fontSize: 9, letterSpacing: "0.04em",
      color: C.textSub, background: C.surface2,
      border: `1px solid ${C.border}`,
      padding: "1px 5px", borderRadius: 3, marginRight: 3, marginBottom: 3,
    }}>{label}</span>
  );
}

function QueueDetailView({ decisionId, clubId, onBack }: { decisionId: string; clubId: string; onBack: () => void }) {
  const [data, setData]       = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/programming/promotion-candidates/${decisionId}?clubId=${clubId}&rebuild=false`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [decisionId, clubId]);

  if (loading) return <div style={{ color: C.textDim, fontSize: 13, padding: "40px 0" }}>Building candidate list…</div>;
  if (error)   return <div style={{ color: C.red, fontSize: 13, padding: "20px 0" }}>Error: {error}</div>;
  if (!data)   return null;

  const f = data.funnel ?? {};
  const fTotal = f.total_players ?? 0;
  const eligible: any[]   = (data.candidates ?? []).filter((c: any) => c.eligible);
  const ineligible: any[] = (data.candidates ?? []).filter((c: any) => !c.eligible);

  // Group ineligible by reason category
  const exclusionGroups: Record<string, number> = {};
  for (const c of ineligible) {
    const r = c.ineligible_reason ?? "unknown";
    const category =
      r.startsWith("contact_cooldown")  ? "contact budget: cooldown window" :
      r.startsWith("contact_30d_cap")   ? "contact budget: 30-day cap reached" :
      r.startsWith("long_dormant")      ? "long dormant 91+d — win-back only" :
      r.startsWith("level")             ? "level out of range" : r.slice(0, 50);
    exclusionGroups[category] = (exclusionGroups[category] ?? 0) + 1;
  }
  const topExclusions = Object.entries(exclusionGroups).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      {/* Back */}
      <button onClick={onBack} style={{
        background: "none", border: "none", color: C.blue, fontSize: 12,
        cursor: "pointer", padding: 0, marginBottom: 20, display: "flex", alignItems: "center", gap: 4,
      }}>
        ← Back to queue
      </button>

      {/* Event header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <PromoteBadge />
          <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{data.event_name}</span>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: C.textSub }}>
          <span>{fmtTime(data.event_start)}</span>
          <span style={{ fontFamily: C.mono }}>
            {data.current_signups}/{data.capacity} booked
          </span>
          {data.admission_rating && (
            <span style={{ fontFamily: C.mono }}>
              level {data.admission_rating.min}–{data.admission_rating.max}
            </span>
          )}
        </div>
      </div>

      {/* ── The funnel ── */}
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "18px 20px", marginBottom: 24,
      }}>
        <div style={{
          fontFamily: C.mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em",
          color: C.textDim, textTransform: "uppercase", marginBottom: 14,
        }}>Funnel</div>
        <FunnelBar label="all members"        total={fTotal} count={f.total_players ?? 0} />
        <FunnelBar label="not already booked" total={fTotal} count={f.after_already_booked ?? 0} prev={f.total_players} />
        <FunnelBar label="level fit"           total={fTotal} count={f.after_level_fit ?? 0} prev={f.after_already_booked} />
        <FunnelBar label="not long-dormant"   total={fTotal} count={f.after_long_dormant ?? 0} prev={f.after_level_fit}
          tooltipNote="91+d excluded → win-back motion" />
        <FunnelBar label="contact budget"     total={fTotal} count={f.after_contact_budget ?? 0} prev={f.after_long_dormant}
          tooltipNote={`cooldown=${f.contact_budget_settings?.cooldown_days ?? 7}d · max ${f.contact_budget_settings?.max_per_30_days ?? 2}/30d`} />
        {/* Segment breakdown (visibility only — all segments are eligible) */}
        {f.segment_counts && (f.segment_counts.lapsing > 0 || f.segment_counts.recent_dormant > 0) && (
          <div style={{ marginTop: 6, marginBottom: 2, marginLeft: 170, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {f.segment_counts.lapsing > 0 && (
              <span style={{ fontFamily: C.mono, fontSize: 9, color: C.accent, background: `${C.accent}18`, padding: "2px 7px", borderRadius: 3 }}>
                lapsing ×{f.segment_counts.lapsing}
              </span>
            )}
            {f.segment_counts.recent_dormant > 0 && (
              <span style={{ fontFamily: C.mono, fontSize: 9, color: C.blue, background: `${C.blue}18`, padding: "2px 7px", borderRadius: 3 }}>
                recent-dormant ×{f.segment_counts.recent_dormant}
              </span>
            )}
            {f.segment_counts.active > 0 && (
              <span style={{ fontFamily: C.mono, fontSize: 9, color: C.textDim, padding: "2px 7px", borderRadius: 3 }}>
                active ×{f.segment_counts.active}
              </span>
            )}
          </div>
        )}
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
          <FunnelBar label="eligible"      total={fTotal} count={f.eligible_final ?? 0} />
          <FunnelBar label="SMS-reachable" total={fTotal} count={f.sms_reachable ?? 0} />
        </div>
      </div>

      {/* ── Ranked candidates ── */}
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "18px 20px", marginBottom: 24,
      }}>
        <div style={{
          fontFamily: C.mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em",
          color: C.textDim, textTransform: "uppercase", marginBottom: 14,
        }}>
          {eligible.length} Eligible Candidates
          {f.sms_reachable > 0 && (
            <span style={{ color: C.textSub, fontWeight: 400 }}> · {f.sms_reachable} SMS-reachable</span>
          )}
        </div>
        {eligible.length === 0 ? (
          <div style={{ color: C.textDim, fontSize: 12 }}>No eligible candidates for this decision.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["#", "Name", "Segment", "Score", "Base", "Recency", "Warm", "Last Contact", "SMS", "Signals"].map((h, i) => (
                    <th key={i} style={{
                      padding: "5px 8px", textAlign: "left",
                      fontFamily: C.mono, fontSize: 10, fontWeight: 500,
                      letterSpacing: "0.06em", color: C.textDim, whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {eligible.map((c: any, i: number) => {
                  const r = c.reasons ?? {};
                  const signals: string[] = [];
                  if (r.slot_dow_match)   signals.push("DOW✓");
                  if (r.slot_hour_match)  signals.push("hour✓");
                  if (r.buddy_already_signed_up) signals.push(`buddy×${r.buddy_already_signed_up}`);
                  if (r.flagged_contacted_48h) signals.push("48h⚠");
                  if (r.archetype_signal && r.archetype_signal.includes("+")) signals.push(`arch:${r.archetype_signal}`);
                  const wsBuilt = r.warm_score_built ?? r.warm_score;
                  const seg = r.retention_segment ?? null;
                  const segColor =
                    seg === "lapsing"        ? C.accent :
                    seg === "recent_dormant" ? C.blue   :
                    seg === "active"         ? C.green  : C.textDim;
                  const segLabel =
                    seg === "lapsing"        ? "lapsing" :
                    seg === "recent_dormant" ? "dormant" :
                    seg === "active"         ? "active"  :
                    seg === "unknown"        ? "new"     : "—";
                  return (
                    <tr key={i} style={{
                      borderBottom: `1px solid ${C.border}`,
                      background: i % 2 === 0 ? "transparent" : C.surface2,
                    }}>
                      <td style={{ padding: "7px 8px", fontFamily: C.mono, fontSize: 11, color: C.textDim }}>{c.rank}</td>
                      <td style={{ padding: "7px 8px", color: C.text, fontWeight: 500 }}>
                        {c.player_name}
                      </td>
                      <td style={{ padding: "7px 8px" }}>
                        <span style={{
                          fontFamily: C.mono, fontSize: 9, fontWeight: 600,
                          color: segColor, background: `${segColor}22`,
                          padding: "2px 6px", borderRadius: 3,
                        }}>{segLabel}</span>
                        {r.days_since_visit != null && (
                          <div style={{ fontSize: 9, color: C.textDim, fontFamily: C.mono, marginTop: 2 }}>
                            {r.days_since_visit}d ago
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "7px 8px" }}><ScoreBadge score={c.score} /></td>
                      <td style={{ padding: "7px 8px", fontFamily: C.mono, fontSize: 11, color: C.textSub }}>
                        {r.base_score ?? "—"}
                      </td>
                      <td style={{ padding: "7px 8px", fontFamily: C.mono, fontSize: 11 }}>
                        {r.recency_adjustment != null
                          ? <span style={{ color: r.recency_adjustment > 0 ? C.green : C.textDim }}>
                              {r.recency_adjustment > 0 ? `+${r.recency_adjustment}` : "0"}
                            </span>
                          : <span style={{ color: C.textDim }}>—</span>
                        }
                      </td>
                      <td style={{ padding: "7px 8px" }}><WarmBadge ws={wsBuilt} /></td>
                      <td style={{ padding: "7px 8px", fontFamily: C.mono, fontSize: 11, color: C.textSub, whiteSpace: "nowrap" }}>
                        {fmtDaysAgo(r.last_contact_date)}
                      </td>
                      <td style={{ padding: "7px 8px" }}>
                        <span style={{ fontFamily: C.mono, fontSize: 11, color: c.sms_opt_in ? C.green : C.textDim }}>
                          {c.sms_opt_in ? "yes" : "no"}
                        </span>
                      </td>
                      <td style={{ padding: "7px 8px" }}>
                        {signals.map((s, j) => <ReasonPill key={j} label={s} />)}
                        {r.churn_risk && r.churn_risk !== "low" && (
                          <ReasonPill label={`churn:${r.churn_risk}`} />
                        )}
                        {r.warm_score_program_type && (
                          <ReasonPill label={`type:${r.warm_score_program_type}`} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Excluded — collapsed by default ── */}
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 8, overflow: "hidden",
      }}>
        <button
          onClick={() => setShowExcluded(v => !v)}
          style={{
            width: "100%", background: "none", border: "none",
            padding: "14px 20px", cursor: "pointer",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}
        >
          <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: C.textDim, textTransform: "uppercase" }}>
            {ineligible.length.toLocaleString()} Excluded
          </span>
          <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textSub }}>{showExcluded ? "▲ hide" : "▼ show"}</span>
        </button>
        {showExcluded && (
          <div style={{ padding: "0 20px 18px" }}>
            <div style={{ fontSize: 11, color: C.textSub, marginBottom: 12 }}>
              Grouped by exclusion reason. These players were seen but held back deliberately.
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Reason", "Count"].map((h, i) => (
                    <th key={i} style={{
                      padding: "5px 8px", textAlign: i === 0 ? "left" : "right",
                      fontFamily: C.mono, fontSize: 10, fontWeight: 500,
                      letterSpacing: "0.06em", color: C.textDim,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topExclusions.map(([reason, count], i) => (
                  <tr key={i} style={{
                    borderBottom: `1px solid ${C.border}`,
                    background: i % 2 === 0 ? "transparent" : C.surface2,
                  }}>
                    <td style={{ padding: "7px 8px", color: C.textSub }}>{reason}</td>
                    <td style={{ padding: "7px 8px", fontFamily: C.mono, fontSize: 11, color: C.text, textAlign: "right" }}>
                      {count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function PromotionQueueView({ clubId }: { clubId: string }) {
  const [queue, setQueue]               = useState<any[]>([]);
  const [channelStats, setChannelStats] = useState<any>(null);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);
  const [selectedId, setSelectedId]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/programming/queue?clubId=${clubId}`);
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const d = await r.json();
      setQueue(d.queue ?? []);
      setChannelStats(d.channel_stats ?? null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [clubId]);

  useEffect(() => { load(); }, [load]);

  if (selectedId) {
    return (
      <QueueDetailView
        decisionId={selectedId}
        clubId={clubId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  if (loading) return <div style={{ color: C.textDim, fontSize: 13, padding: "40px 0" }}>Loading queue…</div>;
  if (error)   return <div style={{ color: C.red, fontSize: 13, padding: "20px 0" }}>Error: {error}</div>;

  if (queue.length === 0) {
    return (
      <EmptyState
        icon="list"
        title="No PROMOTE decisions in queue"
        subtitle="Run the evaluator from the Upcoming Risk tab. PROMOTE decisions appear here once a clinic falls below threshold."
      />
    );
  }

  return (
    <div>
      {/* ── Club-level channel health ─────────────────────────────────────── */}
      {channelStats && (
        <div style={{
          display: "flex", gap: 24, padding: "12px 18px",
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 8, marginBottom: 20, flexWrap: "wrap",
        }}>
          <div>
            <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: "0.06em", color: C.textDim, textTransform: "uppercase", marginBottom: 3 }}>
              Promotional sends (30d)
            </div>
            <div style={{ fontFamily: C.mono, fontSize: 22, fontWeight: 700, color: channelStats.total_promo_contacts_30d > 50 ? C.red : C.text }}>
              {channelStats.total_promo_contacts_30d.toLocaleString()}
            </div>
          </div>
          <div>
            <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: "0.06em", color: C.textDim, textTransform: "uppercase", marginBottom: 3 }}>
              Distinct players contacted
            </div>
            <div style={{ fontFamily: C.mono, fontSize: 22, fontWeight: 700, color: C.text }}>
              {channelStats.distinct_players_contacted.toLocaleString()}
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: C.textDim, fontFamily: C.mono }}>
              {channelStats.total_promo_contacts_30d === 0
                ? "Channel unused — ledger is empty"
                : channelStats.total_promo_contacts_30d <= 20
                  ? "Channel utilisation looks healthy"
                  : "Monitor for over-use"}
            </span>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: 11, color: C.textDim }}>
          {queue.length} open promotion{queue.length !== 1 ? "s" : ""}
        </span>
        <button onClick={load} style={{
          background: "none", border: `1px solid ${C.border}`,
          color: C.textSub, fontSize: 11, padding: "4px 10px",
          borderRadius: 6, cursor: "pointer",
        }}>Refresh</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["", "Session", "Starts", "Signups", "Eligible", "SMS-ready", "Decided"].map((h, i) => (
                <th key={i} style={{
                  padding: "6px 10px", textAlign: "left",
                  fontFamily: C.mono, fontSize: 10, fontWeight: 500,
                  letterSpacing: "0.06em", color: C.textDim, whiteSpace: "nowrap",
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {queue.map((row: any, i: number) => {
              const h = row.hours_until_start ?? 0;
              const urgency = h <= 0 ? C.red : h <= 12 ? C.orange : h <= 48 ? C.accent : C.textDim;
              return (
                <tr
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  style={{
                    borderBottom: `1px solid ${C.border}`,
                    background: i % 2 === 0 ? "transparent" : C.surface2,
                    cursor: "pointer",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = `${C.accent}11`)}
                  onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? "transparent" : C.surface2)}
                >
                  <td style={{ padding: "8px 4px 8px 10px" }}>
                    <PromoteBadge />
                  </td>
                  <td style={{ padding: "8px 10px", maxWidth: 260 }}>
                    <div style={{ color: C.text, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {row.event_name ?? row.event_id?.slice(0, 8)}
                    </div>
                    <div style={{ color: C.textDim, fontSize: 10, marginTop: 2, fontFamily: C.mono }}>
                      {row.rule_name}
                    </div>
                  </td>
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                    <div style={{ color: C.textSub }}>{fmtTime(row.event_start_time)}</div>
                    <div style={{ fontFamily: C.mono, fontSize: 10, color: urgency, marginTop: 2 }}>
                      {h > 0 ? `in ${fmtHours(h)}` : `${Math.abs(Math.round(h))}h ago`}
                    </div>
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: C.mono, textAlign: "center" }}>
                    <span style={{ color: C.red, fontWeight: 600 }}>{row.signup_count}</span>
                    <span style={{ color: C.textDim }}> / {row.total_teams}</span>
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: C.mono, textAlign: "center" }}>
                    {row.has_candidates ? (
                      <span style={{ color: row.eligible_count > 0 ? C.text : C.textDim, fontWeight: 600 }}>
                        {row.eligible_count}
                      </span>
                    ) : (
                      <span style={{ color: C.textDim }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px", fontFamily: C.mono, textAlign: "center" }}>
                    {row.has_candidates ? (
                      <span style={{ color: row.sms_reachable_count > 0 ? C.green : C.textDim, fontWeight: 600 }}>
                        {row.sms_reachable_count}
                      </span>
                    ) : (
                      <span style={{ color: C.textDim }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                    <div style={{ color: C.textSub, fontFamily: C.mono, fontSize: 11 }}>
                      {fmtTime(row.evaluated_at)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
        Click a row to see the full funnel and ranked candidates.
        Eligible / SMS-ready counts are from the most recent candidate build — click a row and rebuild if they look stale.
      </div>
    </div>
  );
}

// ── Shared components ─────────────────────────────────────────────────────────

type Tab = "queue" | "upcoming" | "log";

export default function Programs() {
  const { slug } = useParams<{ slug: string }>();
  const [tab, setTab] = useState<Tab>("queue");
  const [clubId, setClubId] = useState<string | null>(null);
  const [loadingClub, setLoadingClub] = useState(true);

  // Resolve clubId from slug
  useEffect(() => {
    if (!slug) return;
    fetch(`${API}/clubs?slug=${slug}`)
      .then((r) => r.json())
      .then((d) => {
        const id = d?.id ?? d?.clubs?.[0]?.id ?? null;
        setClubId(id);
      })
      .catch(() => {})
      .finally(() => setLoadingClub(false));
  }, [slug]);

  // Fallback: use env var club ID
  useEffect(() => {
    if (!loadingClub && !clubId) {
      const fallback = import.meta.env.VITE_DEFAULT_CLUB_ID ?? null;
      setClubId(fallback);
    }
  }, [loadingClub, clubId]);

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, fontFamily: C.sans }}>
      <Sidebar />
      <main style={{ marginLeft: 240, flex: 1, padding: "48px 40px", maxWidth: 1100 }}>
        {/* Eyebrow */}
        <div style={{
          fontFamily: C.mono,
          fontSize: 10,
          fontWeight: 500,
          color: C.textDim,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 16,
        }}>
          Programming Agent
        </div>

        {/* Title */}
        <div style={{
          fontSize: 22,
          fontWeight: 700,
          color: C.text,
          letterSpacing: "-0.02em",
          marginBottom: 4,
        }}>
          Programs
        </div>
        <div style={{ fontSize: 13, color: C.textSub, marginBottom: 28 }}>
          Shadow evaluation — decisions are recorded but never executed.
        </div>

        {/* Tab bar */}
        <div style={{
          display: "flex",
          gap: 0,
          borderBottom: `1px solid ${C.border}`,
          marginBottom: 28,
        }}>
          {(["queue", "upcoming", "log"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: "none",
                border: "none",
                borderBottom: tab === t ? `2px solid ${C.accent}` : "2px solid transparent",
                color: tab === t ? C.text : C.textSub,
                fontSize: 13,
                fontWeight: tab === t ? 600 : 400,
                padding: "8px 18px",
                cursor: "pointer",
                marginBottom: -1,
                transition: "color 0.15s",
              }}
            >
              {t === "queue" ? "Promotion Queue" : t === "upcoming" ? "Upcoming Risk" : "Decision Log"}
            </button>
          ))}
        </div>

        {/* Content */}
        {loadingClub ? (
          <div style={{ color: C.textDim, fontSize: 13 }}>Resolving club…</div>
        ) : !clubId ? (
          <div style={{ color: C.textDim, fontSize: 13 }}>
            Could not resolve club ID. Set <code style={{ fontFamily: C.mono }}>VITE_DEFAULT_CLUB_ID</code> or navigate via{" "}
            <code style={{ fontFamily: C.mono }}>/c/:slug</code>.
          </div>
        ) : tab === "queue" ? (
          <PromotionQueueView clubId={clubId} />
        ) : tab === "upcoming" ? (
          <UpcomingRiskView clubId={clubId} />
        ) : (
          <DecisionLogView clubId={clubId} />
        )}
      </main>
    </div>
  );
}
