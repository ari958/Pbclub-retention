import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ApprovalCard, btn } from "@/components/ApprovalCard";
import { LtpSequenceConfigEditor } from "@/components/LtpSequenceConfigEditor";
import { useToast } from "@/components/Toast";
import { useClub } from "@/lib/ClubContext";
import { snapshotBulk } from "@/lib/approvalGuards";
import { requestApprovalList } from "@/lib/approvalListRequest";
import { isRetryContextEligible } from "@/lib/retryContextEligibility";
import { combineRetryContextEnvelopes } from "@/lib/retryContextEnvelope";
import { retentionApi, ApiError, DEFAULT_LOOKBACK_DAYS, LOOKBACK_DAY_OPTIONS, type ApprovalListStatus, type ApprovalsResponse, type Candidate, type LtpSequenceConfig, type RetryContextEnvelope } from "@/lib/retentionApi";
import { canApproveLtpCandidate, canReshuffleLtpCandidate, isLtpCandidate } from "@/lib/ltpPhraseSlots";

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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
  const [retryContextBusy, setRetryContextBusy] = useState(false);
  const [retryContextReport, setRetryContextReport] = useState<RetryContextEnvelope | null>(null);
  const [ltpBatchBusy, setLtpBatchBusy] = useState(false);
  const [ltpReshufflingId, setLtpReshufflingId] = useState<string | null>(null);
  const [ltpConfigBusyKey, setLtpConfigBusyKey] = useState<string | null>(null);
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
    if (!ltpSequenceReady) {
      toast.info("Apply migration 013 before generating LTP drafts. No drafts were created.");
      return;
    }
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

  const retryContext = async (ids: string[], single = false) => {
    if (retryContextBusy || busy.size > 0 || regeneratingId || generating || !data?.retry_context_ready) return;
    const retryableIds = ids.filter((id) => {
      const candidate = data.candidates.find((item) => item.id === id);
      return candidate && isRetryContextEligible(candidate.status, candidate.context.reason);
    });
    if (retryableIds.length === 0 || (single && retryableIds.length !== 1)) return;

    setRetryContextReport(null);
    setRetryContextBusy(true);
    setBusy((current) => new Set([...current, ...retryableIds]));
    try {
      let report: RetryContextEnvelope;
      if (single) {
        report = await retentionApi.retryContext(slug, retryableIds[0]);
      } else {
        const reports: RetryContextEnvelope[] = [];
        for (let offset = 0; offset < retryableIds.length; offset += 50) {
          const chunk = retryableIds.slice(offset, offset + 50);
          reports.push(await retentionApi.retryContextBatch(slug, chunk));
        }
        report = combineRetryContextEnvelopes(reports);
      }
      setRetryContextReport(report);
      const statusCounts = report.results.reduce<Record<string, number>>((counts, result) => {
        counts[result.status] = (counts[result.status] ?? 0) + 1;
        return counts;
      }, {});
      toast.info(`Context retry finished: ${Object.entries(statusCounts).map(([status, count]) => `${count} ${status.replace("_", " ")}`).join(", ") || "no results"}. See results and PodPlay telemetry below.`);
    } catch (e) {
      toast.error(e instanceof Error ? `Could not retry context: ${e.message}` : "Could not retry context");
    } finally {
      try { await load(); }
      finally {
        setBusy((current) => { const next = new Set(current); retryableIds.forEach((id) => next.delete(id)); return next; });
        setRetryContextBusy(false);
      }
    }
  };

  const regenerateLtpBatch = async (ids: string[]) => {
    if (!data?.sequence_schema_ready || ltpBatchBusy || ltpReshufflingId || ltpConfigBusyKey
      || regeneratingId || generating || busy.size > 0 || retryContextBusy || ids.length === 0) return;
    setLtpBatchBusy(true);
    setSelected(new Set());
    try {
      const result = await retentionApi.regenerateLtpBatch(slug, ids);
      const statusCounts = result.results.reduce<Record<string, number>>((counts, candidate) => {
        counts[candidate.status] = (counts[candidate.status] ?? 0) + 1;
        return counts;
      }, {});
      const failures = result.failures?.length ?? 0;
      const statuses = Object.entries(statusCounts).map(([status, count]) => `${count} ${status.replace("_", " ")}`).join(", ") || "no candidates rebuilt";
      const message = `LTP cohort rebuild: ${statuses}${failures ? `, ${failures} failures` : ""}. Drafts only; no approvals or sends.`;
      if (failures || result.results.some((candidate) => candidate.status !== "drafted")) toast.info(message);
      else toast.success(message);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? `Could not rebuild the drafted LTP cohort: ${e.message}` : "Could not rebuild the drafted LTP cohort");
      await load();
    } finally {
      setLtpBatchBusy(false);
    }
  };

  const reshuffleLtp = async (candidate: Candidate) => {
    if (!data?.sequence_schema_ready || !canReshuffleLtpCandidate(candidate, true)
      || ltpReshufflingId || ltpBatchBusy || regeneratingId || busy.size > 0) return;
    setLtpReshufflingId(candidate.id);
    try {
      const result = await retentionApi.reshuffleLtp(slug, candidate.id);
      if (result.status === "drafted") toast.success("LTP phrase slots reshuffled. Review the new draft; it remains unapproved and unsent.");
      else toast.info(`Reshuffle returned ${result.status.replace("_", " ")}${result.reason ? `: ${result.reason}` : ""}. Review the updated candidate.`);
    } catch (e) {
      toast.error(e instanceof Error ? `Could not reshuffle this LTP draft: ${e.message}` : "Could not reshuffle this LTP draft");
    } finally {
      try { await load(); }
      finally { setLtpReshufflingId(null); }
    }
  };

  const updateLtpConfig = async (key: string, config: LtpSequenceConfig): Promise<boolean> => {
    if (!data?.sequence_schema_ready || ltpConfigBusyKey) return false;
    setLtpConfigBusyKey(key);
    try {
      await retentionApi.updatePlaybookSequenceConfig(slug, key, config);
      toast.success("Stored LTP phrase configuration saved. Existing drafted message text is unchanged.");
      await load();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? `Could not save LTP phrase configuration: ${e.message}` : "Could not save LTP phrase configuration");
      return false;
    } finally {
      setLtpConfigBusyKey(null);
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
    const ltpIds = snap.candidates.filter(isLtpCandidate).map((candidate) => candidate.id);
    if (ltpIds.length > 0) {
      const current = new Map((data?.candidates ?? []).map((candidate) => [candidate.id, candidate]));
      if (!ltpSequenceReady || ltpIds.some((id) => {
        const candidate = current.get(id);
        return !candidate || !canApproveLtpCandidate(candidate, true);
      })) {
        toast.error("One or more LTP drafts are no longer active, ready, or slot-based. Nothing was approved. Refresh the list and review the sequence again.");
        closeBulk();
        await load();
        return;
      }
    }
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
  const ltpSequenceReady = data?.sequence_schema_ready === true;
  const ltpPlaybook = data?.playbooks.find((playbook) => playbook.key === "ltp_followup");

  return (
    <div className="approvals-page" style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: D.bg }}>
      <style>{`
        @media (max-width: 640px) {
          .approvals-page { width: 100%; height: 100dvh !important; flex-direction: column !important; overflow: hidden; }
          .approvals-sidebar-nav { display: block !important; flex: 0 0 auto; width: 100%; }
          .approvals-mobile-menu { display: block !important; width: 100%; min-height: 44px; padding: 10px 14px; border: 0; border-bottom: 1px solid ${D.border}; background: ${D.card}; color: ${D.text}; text-align: left; font: 12px var(--font-mono); cursor: pointer; }
          .approvals-sidebar-nav > aside { display: none !important; }
          .approvals-sidebar-nav.is-open > aside { display: flex !important; position: static !important; top: auto !important; left: auto !important; width: 100% !important; min-width: 0 !important; height: auto !important; max-height: 52dvh; overflow-y: auto; border-right: 0 !important; border-bottom: 1px solid ${D.border}; }
          .approvals-shell { width: 100%; min-width: 0; margin-left: 0 !important; flex: 1 1 auto !important; overflow: hidden; }
          .approvals-header { height: auto !important; min-height: 52px; align-items: flex-start !important; flex-direction: column; justify-content: flex-start !important; gap: 9px; padding: 10px 14px !important; position: relative !important; }
          .approvals-header-actions { width: 100%; max-width: 100%; display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 8px !important; }
          .approvals-header-actions > * { max-width: 100%; }
          .approvals-content { min-width: 0; overflow-x: hidden !important; padding: 14px !important; gap: 12px !important; }
          .approvals-content > * { min-width: 0; max-width: 100%; box-sizing: border-box; }
          .approvals-status-tabs { flex-wrap: wrap; }
          .approvals-status-tabs button { padding: 8px 9px !important; }
          .approval-group-actions { width: 100%; margin-left: 0 !important; flex-wrap: wrap; }
          .approval-group-actions button { max-width: 100%; white-space: normal; }
          .approval-card { width: 100%; min-width: 0; }
          .approval-card-header { min-width: 0; flex-wrap: wrap; }
          .approval-card-grid { min-width: 0; grid-template-columns: minmax(0, 1fr) !important; }
          .approval-card-copy { min-width: 0; border-right: 0 !important; border-bottom: 1px solid ${D.border}; }
          .approval-card-footer { min-width: 0; }
          .approval-card-footer button { max-width: 100%; white-space: normal; }
          .approval-card-footer > span { max-width: 100%; overflow-wrap: anywhere; }
          .approval-fact-value { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
          .approvals-content a { overflow-wrap: anywhere; word-break: break-word; }
          .approvals-content textarea, .approvals-content input, .approvals-content select { max-width: 100%; }
          .approvals-content details > summary { overflow-wrap: anywhere; }
        }
        @media (min-width: 641px) {
          .approvals-sidebar-nav { display: contents; }
          .approvals-mobile-menu { display: none; }
        }
      `}</style>
      <div className={`approvals-sidebar-nav${mobileNavOpen ? " is-open" : ""}`}>
        <button
          type="button"
          className="approvals-mobile-menu"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((open) => !open)}
        >
          {mobileNavOpen ? "Close navigation" : "Menu · Navigation"}
        </button>
        <Sidebar />
      </div>
      <div className="approvals-shell" style={{ marginLeft: 240, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <header className="approvals-header" style={{ height: 52, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px", borderBottom: `1px solid ${D.border}`, background: D.card, position: "sticky", top: 0, zIndex: 5 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>Approvals</span>
          <span className="approvals-header-actions" style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
                disabled={!ltpSequenceReady || generating || regeneratingId !== null || ltpBatchBusy}
                title={!ltpSequenceReady ? "Apply migration 013 before generating LTP drafts" : undefined}
                onChange={(event) => setLookbackDays(Number(event.target.value) as typeof LOOKBACK_DAY_OPTIONS[number])}
                style={{ background: D.card, color: D.text, border: `1px solid ${D.border}`, borderRadius: 5, padding: "6px 8px", fontSize: 12 }}
              >
                {LOOKBACK_DAY_OPTIONS.map((days) => <option key={days} value={days}>{days} days</option>)}
              </select>
            </label>
            <button style={btn(true, !ltpSequenceReady || generating || regeneratingId !== null || ltpBatchBusy)} disabled={!ltpSequenceReady || generating || regeneratingId !== null || ltpBatchBusy} title={!ltpSequenceReady ? "Apply migration 013 before generating LTP drafts" : undefined} onClick={generate} data-testid="button-generate">
              {generating ? "Creating drafts..." : "Generate drafts (nothing is sent)"}
            </button>
          </span>
        </header>

        <main className="approvals-content" style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "20px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
          {data && data.mode.sms_live === false && (
            <div role="alert" data-testid="banner-simulated" style={{ background: D.accentBg, border: "1px solid rgba(232,168,56,0.3)", borderRadius: 7, padding: "10px 14px", color: D.accent, fontSize: 12, lineHeight: 1.6 }}>
              Live sending is off. Approved texts are consumed by the queue as simulated sends and will not be delivered. Do not approve the acceptance-test texts until live sending and the operator test override are both on.
            </div>
          )}
          {(warnings.length > 0 || couponFails > 0 || (data && (!data.schema_ready || !data.retry_context_ready || !ltpSequenceReady))) && (
            <div role="alert" data-testid="banner-warning" style={{ background: D.orangeBg, border: "1px solid rgba(212,129,58,0.3)", borderRadius: 7, padding: "10px 14px", color: D.orange, fontSize: 12, lineHeight: 1.6 }}>
              {data && !data.schema_ready && <div>Retention tables are unavailable (schema not ready). Approvals cannot be loaded or changed until the database is migrated.</div>}
              {data && !data.retry_context_ready && <div>Migration 012 is missing or not ready. Retry context is disabled until the retry-context schema is migrated.</div>}
              {data && !ltpSequenceReady && <div data-testid="warning-ltp-sequence-unready">Migration 013 is missing or not ready. LTP step approvals, active-sequence phrase reshuffling, cohort rebuild, and phrase-configuration edits remain disabled. Other playbooks are unaffected.</div>}
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

          {ltpPlaybook && (
            <section aria-label="Shared global LTP playbook configuration" data-testid="panel-ltp-global-config" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: D.muted }}>
                Shared configuration for {ltpPlaybook.name}. Phrase edits affect future builds and regenerations; saved draft text stays unchanged. The step 2 gap applies to future eligibility checks, including active sequences.
              </div>
              <LtpSequenceConfigEditor
                playbook={ltpPlaybook}
                schemaReady={ltpSequenceReady}
                busy={ltpConfigBusyKey === ltpPlaybook.key}
                onSave={updateLtpConfig}
              />
            </section>
          )}

          <div className="approvals-status-tabs" style={{ display: "flex", borderBottom: `1px solid ${D.border}` }}>
            {(["all", "drafted", "approved", "skipped", "sent", "needs_context", "manual_edit"] as ApprovalListStatus[]).map((k) => (
              <button key={k} onClick={() => setFilter(k)} disabled={regeneratingId !== null} data-testid={`tab-${k}`}
                style={{ padding: "8px 14px", background: "transparent", border: "none", borderBottom: filter === k ? `2px solid ${D.accent}` : "2px solid transparent", color: filter === k ? D.text : D.muted, fontSize: 13, cursor: "pointer", marginBottom: -1 }}>
                 {k.replace("_", " ")}<span data-testid={`count-${k}`} style={{ fontFamily: mono, fontSize: 10, marginLeft: 6, color: D.faint }}>{counts?.[k] ?? "—"}</span>
              </button>
            ))}
          </div>

          {retryContextReport && (
            <section data-testid="panel-retry-context-report" aria-live="polite" style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontWeight: 600, color: D.text, fontSize: 13 }}>Context retry results</div>
              <div data-testid="list-retry-context-results" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {retryContextReport.results.map((result) => (
                  <div key={result.candidate_id} style={{ display: "flex", gap: 10, color: D.muted, fontSize: 12 }}>
                    <span style={{ fontFamily: mono, color: D.faint }}>{result.candidate_id.slice(0, 8)}</span>
                    <span style={{ color: result.status === "drafted" ? "#2ea043" : result.status === "needs_context" ? D.redText : D.accent }}>{result.status.replace("_", " ")}</span>
                    {result.reason && <span>{result.reason}</span>}
                  </div>
                ))}
              </div>
              {(retryContextReport.failures?.length ?? 0) > 0 && (
                <div data-testid="list-retry-context-failures" role="alert" style={{ border: "1px solid rgba(255,107,107,0.3)", borderRadius: 5, padding: "8px 10px", background: D.redBg, display: "flex", flexDirection: "column", gap: 5 }}>
                  <strong style={{ color: D.redText, fontSize: 12 }}>Candidate retries not persisted</strong>
                  {retryContextReport.failures?.map((failure) => (
                    <div key={`${failure.candidate_id}-${failure.http_status}`} style={{ color: D.redText, fontSize: 11 }}>
                      <span style={{ fontFamily: mono }}>{failure.candidate_id.slice(0, 8)}</span>
                      {" · "}{failure.error} (HTTP {failure.http_status})
                    </div>
                  ))}
                </div>
              )}
              <div data-testid="panel-podplay-telemetry" style={{ display: "flex", flexWrap: "wrap", gap: 12, fontFamily: mono, fontSize: 11, color: D.faint }}>
                <span>Total calls: {retryContextReport.podplay.total_calls}</span>
                <span>Listing: {retryContextReport.podplay.listing_calls}</span>
                <span>Signup: {retryContextReport.podplay.signup_calls}</span>
                <span>Trigger: {retryContextReport.podplay.trigger_calls}</span>
                <span>Coupon: {retryContextReport.podplay.coupon_calls}</span>
                <span>Rate limits: {retryContextReport.podplay.rate_limit_count}</span>
              </div>
              {retryContextReport.podplay.retries.length > 0 && (
                <ul data-testid="list-podplay-retries" style={{ margin: 0, paddingLeft: 18, color: D.faint, fontFamily: mono, fontSize: 10 }}>
                  {retryContextReport.podplay.retries.map((retry, index) => (
                    <li key={`${retry.path}-${retry.attempt}-${index}`}>
                      {retry.path} · attempt {retry.attempt} · retry {retry.retry_number} · waited {retry.wait_ms} ms · status {retry.status}
                    </li>
                  ))}
                </ul>
              )}
              {retryContextReport.podplay.retries.length === 0 && <div style={{ color: D.faint, fontSize: 11 }}>No PodPlay retry attempts.</div>}
              {!retryContextReport.schema_ready && <div role="alert" style={{ color: D.redText, fontSize: 12 }}>The retry response reported that the required retention schemas are not ready.</div>}
            </section>
          )}

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
              const selectableDrafted = drafted.filter((c) => canApproveLtpCandidate(c, ltpSequenceReady));
              const retryable = list.filter((c) => isRetryContextEligible(c.status, c.context.reason));
              const sel = selectableDrafted.filter((c) => selected.has(c.id));
              const groupEditing = list.some((c) => editingIds.has(c.id));
              const ltpStepOneDrafts = key === "ltp_followup" && data
                ? data.candidates.filter((c) => c.playbook_key === key
                  && c.status === "drafted"
                  && (c.step ?? c.context.ltp_text?.step ?? 1) === 1
                  && c.sequence_status === "active")
                : [];
              const canShowLtpBatch = key === "ltp_followup"
                && (loadedFilter === "all" || loadedFilter === "drafted")
                && ltpStepOneDrafts.length > 0;
              return (
                <section key={key} data-testid={`group-${key}`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>{pb?.name ?? key}</span>
                    <span style={{ fontFamily: mono, fontSize: 10, color: D.faint }}>
                      {key}{pb && !pb.enabled ? " / disabled" : ""}{pb?.promo_code ? ` / code ${pb.promo_code}` : ""}{pb && pb.holdout_pct > 0 ? ` / holdout ${pb.holdout_pct}%` : ""}
                    </span>
                    <span className="approval-group-actions" style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                      {retryable.length > 0 && (
                        <button
                          style={btn(false, busy.size > 0 || retryContextBusy || generating || regeneratingId !== null || !data?.retry_context_ready)}
                          disabled={busy.size > 0 || retryContextBusy || generating || regeneratingId !== null || !data?.retry_context_ready}
                          title={!data?.retry_context_ready ? "Apply migration 012 before retrying context" : undefined}
                          onClick={() => retryContext(retryable.map((candidate) => candidate.id))}
                          data-testid={`button-retry-context-batch-${key}`}
                        >
                          {retryContextBusy ? "Retrying context..." : `Retry context (${retryable.length})`}
                        </button>
                      )}
                      {drafted.length > 0 && (
                        <>
                          <button style={btn(false, regeneratingId !== null || busy.size > 0 || ltpBatchBusy || selectableDrafted.length === 0)} onClick={() => setSelected((s) => { const n = new Set(s); const all = selectableDrafted.every((c) => n.has(c.id)); selectableDrafted.forEach((c) => all ? n.delete(c.id) : n.add(c.id)); return n; })} disabled={regeneratingId !== null || busy.size > 0 || ltpBatchBusy || selectableDrafted.length === 0} data-testid={`button-select-${key}`}>
                            {selectableDrafted.length === 0 ? "No LTP drafts ready for bulk approval" : selectableDrafted.every((c) => selected.has(c.id)) ? "Clear selection" : "Select all drafted"}
                          </button>
                          <button style={btn(true, sel.length === 0 || groupEditing || regeneratingId !== null || busy.size > 0)} disabled={sel.length === 0 || groupEditing || regeneratingId !== null || busy.size > 0} title={groupEditing ? "Finish or cancel open edits in this group first" : undefined} onClick={() => openBulk(key)} data-testid={`button-bulk-${key}`}>
                            Review bulk approval ({sel.length})
                          </button>
                        </>
                      )}
                      {canShowLtpBatch && (
                        <button
                          style={btn(false, !ltpSequenceReady || ltpBatchBusy || groupEditing || busy.size > 0 || generating || regeneratingId !== null || ltpReshufflingId !== null || ltpConfigBusyKey !== null)}
                          disabled={!ltpSequenceReady || ltpBatchBusy || groupEditing || busy.size > 0 || generating || regeneratingId !== null || ltpReshufflingId !== null || ltpConfigBusyKey !== null}
                          title={!ltpSequenceReady ? "Apply migration 013 before rebuilding the LTP cohort" : groupEditing ? "Save or cancel the current edit first" : undefined}
                          onClick={() => regenerateLtpBatch(ltpStepOneDrafts.map((candidate) => candidate.id))}
                          data-testid="button-regenerate-ltp-cohort"
                        >
                          {ltpBatchBusy ? "Rebuilding LTP cohort..." : `Rebuild all drafted step 1s (${ltpStepOneDrafts.length})`}
                        </button>
                      )}
                    </span>
                  </div>
                  {list.map((c) => (
                    <ApprovalCard key={c.id} onEditingChange={(on) => setEditing(c.id, on)} c={c} busy={busy.has(c.id) || busy.size > 0 || regeneratingId !== null || generating || ltpBatchBusy || ltpReshufflingId !== null || ltpConfigBusyKey !== null} selected={selected.has(c.id)}
                      onToggle={() => setSelected((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })}
                      onSave={(b) => withBusy(c.id, () => retentionApi.edit(slug, c.id, b), c.status === "approved" ? "Saved. Approval reset; approve again to schedule." : c.status === "manual_edit" ? "Edit saved. Review the refreshed status before approving." : "Draft saved")}
                      onApprove={() => { if (!editingIds.has(c.id) && c.message && needOperator()) withBusy(c.id, () => retentionApi.approve(slug, c.id, operator.trim(), c.message?.body ?? ""), "Approved and scheduled"); }}
                      onSkip={() => withBusy(c.id, () => retentionApi.skip(slug, c.id), "Skipped")}
                        onRegenerate={() => regenerate(c.id)} regenerating={regeneratingId === c.id}
                        onReshuffle={() => { void reshuffleLtp(c); }} reshuffling={ltpReshufflingId === c.id}
                        onLtpBatchRegenerate={() => regenerateLtpBatch(ltpStepOneDrafts.map((candidate) => candidate.id))}
                        onRetryContext={() => retryContext([c.id], true)} retryContextReady={Boolean(data?.retry_context_ready)} sequenceSchemaReady={ltpSequenceReady} />
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
