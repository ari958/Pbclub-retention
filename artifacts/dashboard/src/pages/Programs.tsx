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

type Tab = "upcoming" | "log";

export default function Programs() {
  const { slug } = useParams<{ slug: string }>();
  const [tab, setTab] = useState<Tab>("upcoming");
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
          {(["upcoming", "log"] as Tab[]).map((t) => (
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
              {t === "upcoming" ? "Upcoming Risk" : "Decision Log"}
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
        ) : tab === "upcoming" ? (
          <UpcomingRiskView clubId={clubId} />
        ) : (
          <DecisionLogView clubId={clubId} />
        )}
      </main>
    </div>
  );
}
