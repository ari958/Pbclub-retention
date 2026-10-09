import { useEffect, useMemo, useState } from "react";
import { getGetGenerationRunsQueryKey, useGetGenerationRuns } from "@workspace/api-client-react";
import { RUN_COLORS, RUN_QUERY, errText, fmtDateTime, fmtDuration, isHistoryUnavailable, statusMeta } from "@/lib/runFormat";

const mono = "var(--font-mono)";
const S = { card: "#0f1117", border: "#30363d", inner: "#1e2530", text: "#e6edf3", muted: "#8b949e", accent: "#E8A838" };
const OC: Record<string, string> = { drafted: RUN_COLORS.green, skipped: RUN_COLORS.gray, error: RUN_COLORS.red };

export function GenerationRunsPanel({ slug, focusId }: { slug: string; focusId: string | null }) {
  const params = { slug };
  const list = useGetGenerationRuns(params, { query: { ...RUN_QUERY, queryKey: getGetGenerationRunsQueryKey(params) } });
  const fp = { slug, run_id: focusId ?? undefined };
  const inList = !!focusId && !!list.data?.runs.some((r) => r.id === focusId);
  const focus = useGetGenerationRuns(fp, { query: { ...RUN_QUERY, enabled: !!focusId && !!list.data && !inList, queryKey: getGetGenerationRunsQueryKey(fp) } });
  const tz = list.data?.timezone ?? focus.data?.timezone ?? "UTC";
  const runs = useMemo(() => {
    const m = new Map<string, NonNullable<typeof list.data>["runs"][number]>();
    for (const r of [...(list.data?.runs ?? []), ...(focus.data?.runs ?? []).filter((r) => r.id === focusId)]) m.set(r.id, r);
    return [...m.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }, [list.data, focus.data, focusId]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const found = !!focusId && runs.some((r) => r.id === focusId);

  useEffect(() => {
    if (!focusId || !found) return;
    setOpen((s) => (s.has(focusId) ? s : new Set(s).add(focusId)));
    const t = setTimeout(() => document.getElementById(`generation-run-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    return () => clearTimeout(t);
  }, [focusId, found]);

  const unavailable = list.isError && isHistoryUnavailable(list.error);
  return (
    <section data-testid="panel-generation-runs" aria-label="Recent generation runs" style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 8 }}>
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${S.border}`, fontWeight: 600, fontSize: 13, color: S.text }}>Recent generation runs</div>
      {list.isLoading && <div style={{ padding: 16, height: 60, opacity: 0.5 }} />}
      {list.isError && (
        <div role="alert" data-testid="error-generation-runs" style={{ padding: "12px 16px", fontSize: 12, color: RUN_COLORS.red }}>
          {unavailable ? "Generation history unavailable. Apply migration 029." : `Generation history could not be loaded: ${errText(list.error)}`}
          {!unavailable && <button type="button" onClick={() => list.refetch()} data-testid="button-retry-generation-runs" style={{ marginLeft: 10, background: S.inner, border: `1px solid ${S.border}`, color: S.text, borderRadius: 5, padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>Retry</button>}
        </div>
      )}
      {focusId && !found && !list.isLoading && !focus.isLoading && (
        <div role="alert" data-testid="text-run-not-found" style={{ padding: "10px 16px", fontSize: 12, color: S.accent }}>
          {focus.isError ? (isHistoryUnavailable(focus.error) ? "Generation history unavailable. Apply migration 029." : `Run ${focusId.slice(0, 8)} could not be loaded: ${errText(focus.error)}`) : `Run ${focusId.slice(0, 8)} was not found for this club.`}
        </div>
      )}
      {list.data && runs.length === 0 && !focusId && <div data-testid="empty-generation-runs" style={{ padding: "14px 16px", fontSize: 12, color: S.muted }}>History is available. No generation runs are recorded for this club yet.</div>}
      {runs.map((r) => {
        const m = statusMeta(r.status);
        const isOpen = open.has(r.id);
        const outs = r.details?.outcomes ?? [];
        return (
          <div key={r.id} id={`generation-run-${r.id}`} data-testid={`row-generation-run-${r.id}`} style={{ borderBottom: `1px solid ${S.inner}`, outline: r.id === focusId ? `1px solid ${S.accent}` : "none" }}>
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}
              style={{ width: "100%", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "8px 16px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", fontSize: 12, color: S.text }}>
              <span style={{ color: m.color, fontWeight: 600, minWidth: 64 }}>{m.label}</span>
              <span style={{ fontFamily: mono, fontSize: 11 }}>{fmtDateTime(r.started_at, tz)}</span>
              <span style={{ fontFamily: mono, fontSize: 11, color: S.muted }}>{r.trigger} / {r.playbook_key ?? "all playbooks"} / {r.operator ?? "no operator"}</span>
              <span style={{ fontFamily: mono, fontSize: 11, color: S.muted }}>evaluated {r.evaluated}, drafted {r.drafted}, skipped {r.skipped}, errors {r.errors}</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 16px 10px 28px", fontSize: 11, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontFamily: mono, color: S.muted }}>Duration {fmtDuration(r.started_at, r.finished_at)} / run {r.id}</div>
                {outs.length === 0 && <div style={{ color: S.muted }}>No player outcomes recorded.</div>}
                {outs.map((o, i) => (
                  <div key={`${o.player_id ?? "x"}-${i}`} data-testid={`outcome-${r.id}-${i}`} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ color: S.text, minWidth: 120 }}>{o.player_name}</span>
                    <span style={{ color: OC[o.outcome] ?? S.muted, minWidth: 56 }}>{o.outcome}</span>
                    <span style={{ color: S.muted, overflowWrap: "anywhere" }}>{o.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
