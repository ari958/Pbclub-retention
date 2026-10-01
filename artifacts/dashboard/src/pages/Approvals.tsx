import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ApprovalCard, btn } from "@/components/ApprovalCard";
import { useToast } from "@/components/Toast";
import { useClub } from "@/lib/ClubContext";
import { snapshotBulk } from "@/lib/approvalGuards";
import { requestApprovalList } from "@/lib/approvalListRequest";
import { retentionApi, ApiError, DEFAULT_LOOKBACK_DAYS, LOOKBACK_DAY_OPTIONS, type ApprovalListStatus, type ApprovalsResponse, type Candidate } from "@/lib/retentionApi";

const D = { bg: "#161b22", card: "#0f1117", border: "#30363d", inner: "#1e2530", text: "#e6edf3", muted: "#8b949e", faint: "#6e7681",
  accent: "#E8A838", accentBg: "rgba(232,168,56,0.10)", orange: "#d4813a", orangeBg: "rgba(212,129,58,0.10)", redText: "#ff6b6b", redBg: "rgba(207,34,46,0.08)" };
const mono = "var(--font-mono)";
const POLL_MS = 10000;

export default function Approvals() {
  const club = useClub();
  const toast = useToast();
  const slug = club.slug;
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [lookbackDays, setLookbackDays] = useState<typeof LOOKBACK_DAY_OPTIONS[number]>(DEFAULT_LOOKBACK_DAYS);
  const [operator, setOperator] = useState("");
  const [filter, setFilter] = useState<ApprovalListStatus>("all");
  const [loadedFilter, setLoadedFilter] = useState<ApprovalListStatus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkKey, setBulkKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const seq = useRef(0);
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const [snap, setSnap] = useState<{
    ids: string[];
    bodies: Record<string, string>;
    excludedEditing: string[];
    candidates: Candidate[];
  } | null>(null);
  const [ksBusy, setKsBusy] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const setEditing = useCallback((id: string, on: boolean) => {
    setEditingIds((s) => { if (s.has(id) === on) return s; const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  }, []);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await requestApprovalList(slug, filter, retentionApi.list);
      if (my !== seq.current) return;
      setData(r); setLoadedFilter(filter); setLoadError(null); setUpdatedAt(new Date());
    } catch (e) {
      if (my === seq.current) setLoadError(e instanceof Error ? e.message : "Failed to load");
    } finally { if (my === seq.current) setLoading(false); }
  }, [slug, filter]);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const vis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [load]);

  // Drop selections that are no longer drafted.
  useEffect(() => {
    if (!data || (loadedFilter !== "all" && loadedFilter !== "drafted")) return;
    const drafted = new Set(data.candidates.filter((c) => c.status === "drafted").map((c) => c.id));
    setSelected((s) => { const n = new Set([...s].filter((id) => drafted.has(id))); return n.size === s.size ? s : n; });
  }, [data, loadedFilter]);

  const withBusy = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy((b) => new Set(b).add(id));
    try { await fn(); toast.success(ok); await load(); return true; }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error("This draft changed since you reviewed it. Nothing was approved. Review the refreshed text and approve again.");
        await load();
      } else toast.error(e instanceof Error ? e.message : "Action failed");
      return false;
    }
    finally { setBusy((b) => { const n = new Set(b); n.delete(id); return n; }); }
  };

  const needOperator = () => {
    if (!operator.trim()) { toast.error("Enter an operator name before approving"); return false; }
    return true;
  };

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await retentionApi.generate(slug, lookbackDays);
      const st = {
        created: r.created ?? r.stats?.created,
        skipped: r.skipped ?? r.stats?.skipped,
        needsContext: r.needs_context ?? r.stats?.needs_context,
        manualEdit: r.manual_edit ?? r.stats?.manual_edit,
        errors: r.errors ?? r.stats?.errors,
      };
      const errs = st.errors?.length ?? 0;
      const found = r.stats?.new_ltp_players ?? r.stats?.found;
      const msg = `${found === undefined ? "" : `New LTP players found: ${found}. `}Drafts created: ${st.created ?? 0}, skipped: ${st.skipped ?? 0}, needs context: ${st.needsContext ?? 0}, manual edit: ${st.manualEdit ?? 0}${errs ? `, errors: ${errs}` : ""}. Nothing was sent.`;
      if (errs) toast.info(msg); else toast.success(msg);
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Generate failed"); }
    finally { setGenerating(false); }
  };

  const regenerate = async (id: string) => {
    if (regeneratingId || busy.size > 0 || generating) return;
    setRegeneratingId(id);
    try {
      const result = await retentionApi.regenerate(slug, id);
      const detail = [
        result.reason,
        result.context.reason,
        ...(result.validation_errors ?? []),
        ...(result.context.validation_errors ?? []),
        ...(result.context.errors ?? []).map((error) => {
          if (typeof error === "string") return error;
          try { return JSON.stringify(error); } catch { return String(error); }
        }),
      ].filter((value): value is string => Boolean(value));
      if (result.status === "drafted") {
        toast.success("Draft regenerated. Review the updated text and context before approving.");
      } else {
        toast.info(`Regeneration finished with status ${result.status.replace("_", " ")}${detail.length ? `: ${detail.join("; ")}` : "."}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? `Could not regenerate this draft: ${e.message}` : "Could not regenerate this draft");
    } finally {
      try { await load(); } finally { setRegeneratingId(null); }
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, Candidate[]>();
    for (const c of data?.candidates ?? []) {
      if (filter !== "all" && c.status !== filter) continue;
      (m.get(c.playbook_key) ?? m.set(c.playbook_key, []).get(c.playbook_key)!).push(c);
    }
    return m;
  }, [data, filter]);

  const counts = useMemo(() => {
    if (data?.counts) return data.counts;
    if (!data || loadedFilter !== "all") return null;
    const result: Partial<Record<ApprovalListStatus, number>> = {
      all: data.candidates.length, drafted: 0, approved: 0, skipped: 0, sent: 0, needs_context: 0, manual_edit: 0,
    };
    for (const c of data.candidates) {
      result[c.status] = (result[c.status] ?? 0) + 1;
    }
    return result;
  }, [data, loadedFilter]);

  const bulkCands = snap?.candidates ?? [];

  const openBulk = (key: string) => {
    const snapshot = snapshotBulk(data?.candidates ?? [], selected, key, editingIds);
    setSnap({
      ...snapshot,
      candidates: (data?.candidates ?? []).filter((candidate) => snapshot.ids.includes(candidate.id)),
    });
    setBulkKey(key);
  };
  const closeBulk = () => { setBulkKey(null); setSnap(null); };

  const setKill = async (enabled: boolean) => {
    setKsBusy(true);
    try { await retentionApi.killSwitch(slug, enabled); toast.success(enabled ? "Sending paused" : "Sending resumed. Existing approvals will go out on schedule."); setConfirmResume(false); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Kill switch update failed"); }
    finally { setKsBusy(false); }
  };
  const ks = data?.mode.kill_switch;

  const confirmBulk = async () => {
    if (!bulkKey || !snap || !needOperator() || snap.ids.length === 0) return;
    setBulkBusy(true);
    try {
      const r = await retentionApi.bulk(slug, bulkKey, operator.trim(), snap.ids, snap.bodies);
      const n = r.approved ?? r.approved_count ?? 0;
      const errs = r.errors?.length ?? 0;
      const msg = `Approved ${n} of ${snap.ids.length}${errs ? `, ${errs} errors` : ""}`;
      if (errs) toast.info(msg); else toast.success(msg);
      closeBulk(); setSelected(new Set());
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { toast.error("One or more drafts changed since the list was opened. Nothing was approved. Close this dialog, review the refreshed text, and try again."); closeBulk(); await load(); }
      else toast.error(e instanceof Error ? e.message : "Bulk approval failed");
    }
    finally { setBulkBusy(false); }
  };

  const warnings = [...(data?.warnings ?? []), ...(data?.error ? [data.error] : [])];
  const couponFails = (data?.candidates ?? []).filter((c) => c.status === "drafted" && c.context.coupon_warning).length;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: D.bg }}>
      <Sidebar />
      <div style={{ marginLeft: 240, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <header style={{ height: 52, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px", borderBottom: `1px solid ${D.border}`, background: D.card, position: "sticky", top: 0, zIndex: 5 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>Approvals</span>
          <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: mono, fontSize: 11, color: D.faint }} data-testid="text-updated">
              {updatedAt ? `refreshed ${updatedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : ""}
            </span>
            <span data-testid="status-kill-switch" style={{ fontFamily: mono, fontSize: 10, color: ks === false ? "#2ea043" : D.redText }}>
              {ks === true ? "sending paused" : ks === false ? "sending enabled" : "kill switch unverifiable, sends blocked"}
            </span>
            {ks === false && <button style={btn(false, ksBusy)} disabled={ksBusy} onClick={() => setKill(true)} data-testid="button-pause-sending">Pause sending</button>}
            {ks === true && <button style={btn(false, ksBusy)} disabled={ksBusy} onClick={() => setConfirmResume(true)} data-testid="button-resume-sending">Resume sending</button>}
            <label style={{ display: "flex", alignItems: "center", gap: 6, color: D.muted, fontSize: 11 }}>
              Lookback
              <select
                aria-label="Draft generation lookback"
                data-testid="select-lookback-days"
                value={lookbackDays}
                disabled={generating || regeneratingId !== null}
                onChange={(event) => setLookbackDays(Number(event.target.value) as typeof LOOKBACK_DAY_OPTIONS[number])}
                style={{ background: D.card, color: D.text, border: `1px solid ${D.border}`, borderRadius: 5, padding: "6px 8px", fontSize: 12 }}
              >
                {LOOKBACK_DAY_OPTIONS.map((days) => <option key={days} value={days}>{days} days</option>)}
              </select>
            </label>
            <button style={btn(true, generating || regeneratingId !== null)} disabled={generating || regeneratingId !== null} onClick={generate} data-testid="button-generate">
              {generating ? "Creating drafts..." : "Generate drafts (nothing is sent)"}
            </button>
          </span>
        </header>

        <main style={{ flex: 1, overflowY: "auto", padding: "20px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
          {data && data.mode.sms_live === false && (
            <div role="alert" data-testid="banner-simulated" style={{ background: D.accentBg, border: "1px solid rgba(232,168,56,0.3)", borderRadius: 7, padding: "10px 14px", color: D.accent, fontSize: 12, lineHeight: 1.6 }}>
              Live sending is off. Approved texts are consumed by the queue as simulated sends and will not be delivered. Do not approve the acceptance-test texts until live sending and the operator test override are both on.
            </div>
          )}
          {(warnings.length > 0 || couponFails > 0 || (data && !data.schema_ready)) && (
            <div role="alert" data-testid="banner-warning" style={{ background: D.orangeBg, border: "1px solid rgba(212,129,58,0.3)", borderRadius: 7, padding: "10px 14px", color: D.orange, fontSize: 12, lineHeight: 1.6 }}>
              {data && !data.schema_ready && <div>Retention tables are unavailable (schema not ready). Approvals cannot be loaded or changed until the database is migrated.</div>}
              {couponFails > 0 && <div>{couponFails} draft{couponFails === 1 ? "" : "s"} failed the coupon check. The promo code may not work; review before approving.</div>}
              {warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
          {loadError && data && (
            <div role="alert" data-testid="banner-refresh-error" style={{ background: D.redBg, border: "1px solid rgba(207,34,46,0.2)", borderRadius: 7, padding: "10px 14px", color: D.redText, fontSize: 12 }}>
              List refresh failed: {loadError}
              <button style={{ ...btn(false), marginLeft: 10 }} onClick={() => { setLoading(true); load(); }} data-testid="button-refresh-retry">Retry</button>
            </div>
          )}

          {data && (
            <div data-testid="panel-mode" style={{ fontFamily: mono, fontSize: 11, color: D.faint, display: "flex", gap: 16, flexWrap: "wrap" }}>
              {data.mode.sms_live !== undefined && <span>live sending: {data.mode.sms_live ? "on" : "off"}</span>}
              {data.mode.test_override_configured !== undefined && <span>test override: {data.mode.test_override_configured ? "configured, texts go to the test number" : "not configured"}</span>}
              {data.mode.sms_live === false && (
                <span data-testid="text-simulated-mode" style={{ color: D.accent }}>Approved texts will be simulated, not delivered.</span>
              )}
              {ks === true && <span style={{ color: D.redText }}>Paused: nothing sends, including approved messages.</span>}
              {ks == null && <span style={{ color: D.redText }}>Kill switch state unknown: sends are blocked.</span>}
            </div>
          )}
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: "12px 16px", display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "0 0 240px" }}>
              <label htmlFor="operator" style={{ fontSize: 10, fontFamily: mono, color: D.faint, textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 6 }}>Operator name</label>
              <input id="operator" value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Your name" data-testid="input-operator"
                style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: 5, border: `1px solid ${operator.trim() ? D.border : "rgba(232,168,56,0.5)"}`, background: D.inner, color: D.text, fontSize: 13, outline: "none" }} />
            </div>
            <div style={{ flex: 1, minWidth: 240, fontSize: 12, color: D.faint, lineHeight: 1.6 }}>
              This name is recorded as approved_by on each message you approve. It is a label you type, not a sign-in; the dashboard has no user login yet. Approving schedules a send for the next allowed text window.
            </div>
          </div>

          <div style={{ display: "flex", borderBottom: `1px solid ${D.border}` }}>
            {(["all", "drafted", "approved", "skipped", "sent", "needs_context", "manual_edit"] as ApprovalListStatus[]).map((k) => (
              <button key={k} onClick={() => setFilter(k)} disabled={regeneratingId !== null} data-testid={`tab-${k}`}
                style={{ padding: "8px 14px", background: "transparent", border: "none", borderBottom: filter === k ? `2px solid ${D.accent}` : "2px solid transparent", color: filter === k ? D.text : D.muted, fontSize: 13, cursor: "pointer", marginBottom: -1 }}>
                 {k.replace("_", " ")}<span data-testid={`count-${k}`} style={{ fontFamily: mono, fontSize: 10, marginLeft: 6, color: D.faint }}>{counts?.[k] ?? "—"}</span>
              </button>
            ))}
          </div>

          {loading && !data ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[0, 1].map((i) => <div key={i} style={{ height: 150, borderRadius: 8, background: D.card, border: `1px solid ${D.border}`, opacity: 0.6 }} />)}
            </div>
          ) : loadError && !data ? (
            <div style={{ padding: 24, background: D.redBg, border: "1px solid rgba(207,34,46,0.2)", borderRadius: 8, color: D.redText, fontSize: 13 }}>
              Could not load approvals: {loadError}
              <div><button style={{ ...btn(), marginTop: 10 }} onClick={() => { setLoading(true); load(); }} data-testid="button-retry">Retry</button></div>
            </div>
          ) : groups.size === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center", color: D.faint, fontSize: 13, background: D.card, border: `1px dashed ${D.border}`, borderRadius: 8 }} data-testid="empty-approvals">
              {filter === "all" ? "No retention messages yet." : filter === "drafted" ? "No drafts." : `No ${filter.replace("_", " ")} messages.`}
            </div>
          ) : (
            [...groups.entries()].map(([key, list]) => {
              const pb = data?.playbooks.find((p) => p.key === key);
              const drafted = list.filter((c) => c.status === "drafted");
              const sel = drafted.filter((c) => selected.has(c.id));
              const groupEditing = list.some((c) => editingIds.has(c.id));
              return (
                <section key={key} data-testid={`group-${key}`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>{pb?.name ?? key}</span>
                    <span style={{ fontFamily: mono, fontSize: 10, color: D.faint }}>
                      {key}{pb && !pb.enabled ? " / disabled" : ""}{pb?.promo_code ? ` / code ${pb.promo_code}` : ""}{pb && pb.holdout_pct > 0 ? ` / holdout ${pb.holdout_pct}%` : ""}
                    </span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                      {drafted.length > 0 && (
                        <>
                          <button style={btn(false, regeneratingId !== null || busy.size > 0)} onClick={() => setSelected((s) => { const n = new Set(s); const all = drafted.every((c) => n.has(c.id)); drafted.forEach((c) => all ? n.delete(c.id) : n.add(c.id)); return n; })} disabled={regeneratingId !== null || busy.size > 0} data-testid={`button-select-${key}`}>
                            {drafted.every((c) => selected.has(c.id)) ? "Clear selection" : "Select all drafted"}
                          </button>
                          <button style={btn(true, sel.length === 0 || groupEditing || regeneratingId !== null || busy.size > 0)} disabled={sel.length === 0 || groupEditing || regeneratingId !== null || busy.size > 0} title={groupEditing ? "Finish or cancel open edits in this group first" : undefined} onClick={() => openBulk(key)} data-testid={`button-bulk-${key}`}>
                            Review bulk approval ({sel.length})
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                  {list.map((c) => (
                    <ApprovalCard key={c.id} onEditingChange={(on) => setEditing(c.id, on)} c={c} busy={busy.has(c.id) || busy.size > 0 || regeneratingId !== null || generating} selected={selected.has(c.id)}
                      onToggle={() => setSelected((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                      onSave={(b) => withBusy(c.id, () => retentionApi.edit(slug, c.id, b), c.status === "approved" ? "Saved. Approval reset; approve again to schedule." : c.status === "manual_edit" ? "Edit saved. Review the refreshed status before approving." : "Draft saved")}
                      onApprove={() => { if (!editingIds.has(c.id) && c.message && needOperator()) withBusy(c.id, () => retentionApi.approve(slug, c.id, operator.trim(), c.message?.body ?? ""), "Approved and scheduled"); }}
                      onSkip={() => withBusy(c.id, () => retentionApi.skip(slug, c.id), "Skipped")}
                      onRegenerate={() => regenerate(c.id)} regenerating={regeneratingId === c.id} />
                  ))}
                </section>
              );
            })
          )}
        </main>
      </div>

      {confirmResume && (
        <div role="dialog" aria-modal="true" data-testid="dialog-resume" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}>
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, width: 440, maxWidth: "100%", padding: 20 }}>
            <div style={{ fontWeight: 600, color: D.text, fontSize: 14, marginBottom: 8 }}>Resume sending?</div>
            <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.6 }}>Messages already approved and scheduled will send at their scheduled time. Nothing is approved automatically by resuming.</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button style={btn(false, ksBusy)} disabled={ksBusy} onClick={() => setConfirmResume(false)}>Cancel</button>
              <button style={btn(true, ksBusy)} disabled={ksBusy} onClick={() => setKill(false)} data-testid="button-resume-confirm">Resume sending</button>
            </div>
          </div>
        </div>
      )}

      {bulkKey && (
        <div role="dialog" aria-modal="true" data-testid="dialog-bulk" onClick={(e) => { if (e.target === e.currentTarget && !bulkBusy) closeBulk(); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}>
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, width: 520, maxWidth: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "16px 20px", borderBottom: `1px solid ${D.border}`, fontWeight: 600, color: D.text, fontSize: 14 }}>
              Approve {bulkCands.length} draft{bulkCands.length === 1 ? "" : "s"}?
            </div>
            <div style={{ padding: "14px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.6 }}>
                Only the drafts listed below will be approved, recorded as approved by <b style={{ color: D.text }}>{operator.trim() || "(enter operator name)"}</b>. Drafts created after this list was built are not included.
              </div>
              {bulkCands.some((c) => c.context.coupon_warning) && (
                <div style={{ fontSize: 12, color: D.redText, background: D.redBg, borderRadius: 5, padding: "8px 10px" }}>
                  Some listed drafts have a coupon warning.
                </div>
              )}
              {snap && snap.excludedEditing.length > 0 && (
                <div style={{ fontSize: 12, color: D.accent }}>{snap.excludedEditing.length} selected draft(s) with open edits were left out.</div>
              )}
              <div style={{ fontSize: 12, color: D.muted }}>The texts below are the exact versions captured when this dialog opened. If any changes before you confirm, the approval is rejected.</div>
              <div style={{ border: `1px solid ${D.border}`, borderRadius: 6 }} data-testid="list-bulk-ids">
                {bulkCands.map((c) => (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderBottom: `1px solid ${D.border}`, fontSize: 12, color: D.text }}>
                    <span style={{ flex: 1, paddingRight: 10 }}>{c.player?.name ?? c.context.player_first_name}{c.context.coupon_warning ? " (coupon warning)" : ""}<div style={{ color: D.muted, marginTop: 2 }}>{snap?.bodies[c.id]}</div></span>
                    <span style={{ fontFamily: mono, fontSize: 10, color: D.faint }}>{c.id}</span>
                  </div>
                ))}
              </div>
              {!operator.trim() && <div style={{ fontSize: 12, color: D.accent }}>Enter an operator name on the page first.</div>}
            </div>
            <div style={{ padding: "12px 20px", borderTop: `1px solid ${D.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={btn(false, bulkBusy)} disabled={bulkBusy} onClick={closeBulk} data-testid="button-bulk-cancel">Cancel</button>
              <button style={btn(true, bulkBusy || !operator.trim() || bulkCands.length === 0)} disabled={bulkBusy || !operator.trim() || bulkCands.length === 0} onClick={confirmBulk} data-testid="button-bulk-confirm">
                {bulkBusy ? "Approving..." : `Approve ${bulkCands.length} listed`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
