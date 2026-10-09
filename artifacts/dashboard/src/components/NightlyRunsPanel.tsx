import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getGetNightlyRunsQueryKey, useGetNightlyRuns } from "@workspace/api-client-react";
import { RUN_COLORS, RUN_QUERY, dayKey, errText, fmtDateTime, fmtDuration, isHistoryUnavailable, statusMeta } from "@/lib/runFormat";

const mono = "var(--font-mono)";
const S = { card: "#0f1117", border: "#30363d", inner: "#1e2530", text: "#e6edf3", muted: "#8b949e" };

export function NightlyRunsPanel({ slug }: { slug: string }) {
  const params = { slug };
  const q = useGetNightlyRuns(params, { query: { ...RUN_QUERY, queryKey: getGetNightlyRunsQueryKey(params) } });
  const [open, setOpen] = useState(false);
  const [openRuns, setOpenRuns] = useState<Set<string>>(new Set());
  const data = q.data;
  const tz = data?.timezone ?? "UTC";
  const runs = useMemo(() => [...(data?.runs ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 14), [data]);

  let line: { text: string; color: string };
  let unavailable = false;
  if (q.isLoading) line = { text: "Loading nightly sync status...", color: RUN_COLORS.gray };
  else if (q.isError) {
    unavailable = isHistoryUnavailable(q.error);
    line = { text: unavailable ? "Sync history unavailable. Apply migration 029." : `Sync history could not be loaded: ${errText(q.error)}`, color: RUN_COLORS.red };
  } else {
    const today = dayKey(Date.now(), tz);
    const latest = runs.find((r) => dayKey(r.started_at, tz) === today);
    if (!latest) line = { text: `Nightly sync has not run today${data?.scheduled_time ? ` (scheduled ${data.scheduled_time} ${tz})` : ""}`, color: RUN_COLORS.gray };
    else {
      const m = statusMeta(latest.status);
      line = { text: `Nightly sync ${m.label.toLowerCase()} today, started ${fmtDateTime(latest.started_at, tz)}`, color: m.color };
    }
  }

  return (
    <section data-testid="panel-nightly-runs" style={{ marginBottom: 14, background: S.card, border: `1px solid ${S.border}`, borderRadius: 8 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={q.isError || q.isLoading} data-testid="button-toggle-nightly-runs"
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "transparent", border: "none", cursor: q.isError ? "default" : "pointer", textAlign: "left" }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: line.color, flexShrink: 0 }} />
        <span data-testid="status-nightly-sync" style={{ color: line.color, fontSize: 12, fontWeight: 600, flex: 1 }}>{line.text}</span>
        {!q.isError && !q.isLoading && <span style={{ fontFamily: mono, fontSize: 10, color: S.muted }}>{open ? "hide" : "last 14 runs"}</span>}
      </button>
      {q.isError && !unavailable && (
        <div style={{ padding: "0 14px 10px" }}><button type="button" onClick={() => q.refetch()} data-testid="button-retry-nightly-runs" style={{ background: S.inner, border: `1px solid ${S.border}`, color: S.text, borderRadius: 5, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Retry</button></div>
      )}
      {open && !q.isError && (
        <div style={{ borderTop: `1px solid ${S.border}` }}>
          {runs.length === 0 && <div style={{ padding: 14, fontSize: 12, color: S.muted }}>History is available and no sync runs are recorded yet.</div>}
          {runs.map((r) => {
            const m = statusMeta(r.status);
            const isOpen = openRuns.has(r.id);
            return (
              <div key={r.id} data-testid={`row-nightly-run-${r.id}`} style={{ borderBottom: `1px solid ${S.inner}` }}>
                <button type="button" aria-expanded={isOpen} onClick={() => setOpenRuns((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}
                  style={{ width: "100%", display: "flex", gap: 12, alignItems: "center", padding: "8px 14px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", fontSize: 12, color: S.text, flexWrap: "wrap" }}>
                  <span style={{ color: m.color, fontWeight: 600, minWidth: 64 }}>{m.label}</span>
                  <span style={{ fontFamily: mono, fontSize: 11 }}>{fmtDateTime(r.started_at, tz)}</span>
                  <span style={{ fontFamily: mono, fontSize: 11, color: S.muted }}>{r.trigger} / {fmtDuration(r.started_at, r.finished_at)} / {r.steps.length} steps</span>
                </button>
                {isOpen && (
                  <div style={{ padding: "0 14px 10px 26px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {r.steps.length === 0 && <div style={{ fontSize: 11, color: S.muted }}>No steps recorded.</div>}
                    {r.steps.map((st, i) => {
                      const sm = statusMeta(st.status);
                      const counts = Object.entries(st.counts ?? {});
                      return (
                        <div key={`${st.name}-${i}`} data-testid={`step-nightly-${r.id}-${i}`} style={{ background: S.inner, borderRadius: 6, padding: "8px 10px", fontSize: 11, display: "flex", flexDirection: "column", gap: 4 }}>
                          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                            <span style={{ color: S.text, fontWeight: 600 }}>{st.name}</span>
                            <span style={{ color: sm.color }}>{sm.label}</span>
                            <span style={{ fontFamily: mono, color: S.muted }}>{fmtDateTime(st.started_at, tz)} / {fmtDuration(st.started_at, st.finished_at)}</span>
                          </div>
                          {counts.length > 0 && <div style={{ fontFamily: mono, color: S.muted, display: "flex", gap: 12, flexWrap: "wrap" }}>{counts.map(([k, v]) => <span key={k}>{k}: {v}</span>)}</div>}
                          {st.error && <div style={{ color: st.status === "skipped" ? S.muted : RUN_COLORS.red, overflowWrap: "anywhere" }}>{st.status === "skipped" ? "Skipped: " : "Error: "}{st.error}</div>}
                          {st.generation_run_id && <Link to={`/c/${slug}/approvals?generation_run=${encodeURIComponent(st.generation_run_id)}`} data-testid={`link-generation-run-${st.generation_run_id}`} style={{ color: "#E8A838" }}>View generation run</Link>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
