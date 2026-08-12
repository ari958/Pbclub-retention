/**
 * ExperimentsTab — Phase 4 Outreach Experiment Module
 *
 * Three views:
 *   list    — all experiments for the club
 *   setup   — pick session, preview pool, randomize
 *   detail  — review treatment/control, edit messages, veto, mark sent
 *   results — per-experiment + pooled outcome table
 *
 * Hard constraints:
 *   - No send button implies the system sends. Every send action is labeled as manual.
 *   - Phone numbers are shown only in the detail view (operator context).
 *   - No Twilio calls, no PodPlay writes, no automated sending.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";

// ── Palette (matches Programs.tsx) ────────────────────────────────────────────
const BG      = "#0d1117";
const SURFACE = "#161b22";
const SURF2   = "#1c2128";
const BORDER  = "#30363d";
const TEXT    = "#e6edf3";
const TEXT2   = "#8b949e";
const AMBER   = "#d29922";
const BLUE    = "#58a6ff";
const GREEN   = "#3fb950";
const RED     = "#f85149";
const PURPLE  = "#bc8cff";

const STATUS_COLOR: Record<string, string> = {
  draft:     TEXT2,
  ready:     AMBER,
  sent:      BLUE,
  measuring: PURPLE,
  complete:  GREEN,
};

// ── Types ──────────────────────────────────────────────────────────────────────
interface Experiment {
  id: string;
  name: string;
  event_name: string;
  event_start: string;
  status: string;
  treatment_pct: number;
  pool_size: number | null;
  randomized_at: string | null;
  sent_at: string | null;
  notes: string | null;
  created_at: string;
  counts?: { treatment: number; control: number; sent: number; vetoed: number };
}

interface Participant {
  id: string;
  experiment_id: string;
  player_id: string;
  arm: "treatment" | "control";
  rank: number | null;
  score: number;
  reasons: Record<string, any>;
  vetoed: boolean;
  veto_reason: string | null;
  message_text: string | null;
  sent_at: string | null;
  channel: string | null;
  booked_target_session: boolean | null;
  attended_within_30d: boolean | null;
  first_attendance_at: string | null;
  outcome_measured_at: string | null;
  players?: { name: string; phone: string | null; sms_opt_in: boolean | null; last_visit_date: string | null; attendance_archetype: string | null };
}

interface EligibleSession {
  id: string;
  event_id: string;
  event_name: string;
  event_start_time: string;
  rule_name: string;
  signup_count: number;
  total_teams: number;
}

interface PreviewResult {
  pool_size: number;
  n_treatment: number;
  n_control: number;
  worth_running: boolean;
  min_pool_note: string | null;
  funnel: Record<string, any>;
  balance: { balanced: boolean; reason: string | null };
  treatment_stats: ArmStats;
  control_stats: ArmStats;
}

interface ArmStats {
  meanScore: number;
  lapsingPct: number;
  dormantPct: number;
  meanDaysSince: number | null;
  n: number;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Badge({ label, color = TEXT2 }: { label: string; color?: string }) {
  return (
    <span style={{
      background: color + "22", color, border: `1px solid ${color}44`,
      borderRadius: 4, padding: "1px 7px", fontSize: 11, fontWeight: 600,
      textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function Pill({ label, color = TEXT2 }: { label: string; color?: string }) {
  return (
    <span style={{
      background: color + "18", color, border: `1px solid ${color}30`,
      borderRadius: 10, padding: "1px 6px", fontSize: 10, whiteSpace: "nowrap",
    }}>{label}</span>
  );
}

function ArmStatsRow({ label, stats }: { label: string; stats: ArmStats }) {
  return (
    <div style={{ display: "flex", gap: 24, alignItems: "center", padding: "6px 0", borderBottom: `1px solid ${BORDER}` }}>
      <span style={{ color: TEXT2, fontSize: 12, minWidth: 90 }}>{label}</span>
      <span style={{ color: TEXT, fontSize: 12 }}>n={stats.n}</span>
      <span style={{ color: TEXT, fontSize: 12 }}>scorē={stats.meanScore}</span>
      <span style={{ color: TEXT, fontSize: 12 }}>lapsing {stats.lapsingPct}%</span>
      <span style={{ color: TEXT, fontSize: 12 }}>dormant {stats.dormantPct}%</span>
      {stats.meanDaysSince !== null && <span style={{ color: TEXT, fontSize: 12 }}>days̄={stats.meanDaysSince}</span>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props { api: string; clubId: string; }
type View = "list" | "setup" | "detail" | "results";

export default function ExperimentsTab({ api, clubId }: Props) {
  const [view, setView] = useState<View>("list");
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedExp, setSelectedExp] = useState<Experiment | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [eligibleSessions, setEligibleSessions] = useState<EligibleSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Setup state
  const [setupDecisionId, setSetupDecisionId] = useState("");
  const [setupTreatmentPct, setSetupTreatmentPct] = useState(70);
  const [setupNotes, setSetupNotes] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  // Detail state
  const [editingMessage, setEditingMessage] = useState<string | null>(null); // participant id
  const [messageEdits, setMessageEdits] = useState<Record<string, string>>({});
  const [vetoingId, setVetoingId] = useState<string | null>(null);
  const [vetoReason, setVetoReason] = useState("");
  const [markingSent, setMarkingSent] = useState(false);
  const [selectedTreatment, setSelectedTreatment] = useState<Set<string>>(new Set());
  const [measuring, setMeasuring] = useState(false);

  // Results state
  const [pooled, setPooled] = useState<any>(null);
  const [pooledExps, setPooledExps] = useState<any[]>([]);

  // Dispatch state (Phase 4.1)
  const [dryRunLoading, setDryRunLoading]     = useState(false);
  const [dryRunResult, setDryRunResult]       = useState<any | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [dispatching, setDispatching]         = useState(false);
  const [dispatchResult, setDispatchResult]   = useState<any | null>(null);

  const fetch_ = useCallback(async (path: string, opts?: RequestInit) => {
    const url = `${api}${path}${path.includes("?") ? "&" : "?"}clubId=${clubId}`;
    const r = await fetch(url, opts);
    const ct = r.headers.get("content-type") ?? "";
    if (!r.ok || !ct.includes("application/json")) {
      const body = await r.text();
      const err = new Error(
        `HTTP ${r.status} — expected JSON but got ${ct || "unknown"}\n` +
        `URL: ${url}\n` +
        (body.trimStart().startsWith("<") ? "(HTML response — proxy or routing issue)" : body.slice(0, 300))
      );
      (err as any).status = r.status;
      throw err;
    }
    return r.json();
  }, [api, clubId]);

  const loadExperiments = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const d = await fetch_("/experiments");
      setExperiments(d.experiments ?? []);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [fetch_]);

  const loadEligibleSessions = useCallback(async () => {
    try {
      const d = await fetch_("/experiments/eligible-sessions");
      setEligibleSessions(d.decisions ?? []);
    } catch { /* non-fatal */ }
  }, [fetch_]);

  useEffect(() => { loadExperiments(); }, [loadExperiments]);

  // ── List view ────────────────────────────────────────────────────────────────

  async function openDetail(exp: Experiment) {
    setSelectedExp(exp); setLoading(true); setError(null);
    // Reset dispatch state when switching experiments
    setDryRunResult(null); setAwaitingApproval(false); setDispatchResult(null);
    try {
      const d = await fetch_(`/experiments/${exp.id}`);
      setParticipants(d.participants ?? []);
      setSelectedTreatment(new Set());
      setMessageEdits({});
      setView("detail");
    } catch (e: any) {
      if (e.status === 404) {
        // Experiment was deleted since the list loaded — refresh the list.
        setSelectedExp(null);
        setView("list");
        setError("That experiment no longer exists — the list has been refreshed.");
        loadExperiments();
      } else {
        setError(e.message);
      }
    }
    finally { setLoading(false); }
  }

  async function loadDetail(id: string) {
    if (!selectedExp) return;
    try {
      const d = await fetch_(`/experiments/${id}`);
      setParticipants(d.participants ?? []);
      setSelectedExp(d.experiment ?? selectedExp);
    } catch { /* non-fatal */ }
  }

  async function openResults() {
    setLoading(true); setError(null);
    try {
      const d = await fetch_("/experiments/pooled-results");
      setPooled(d.pooled);
      setPooledExps(d.experiments ?? []);
      setView("results");
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  // ── Setup view ────────────────────────────────────────────────────────────────

  async function loadSetup() {
    setView("setup"); setPreview(null); setSetupDecisionId(""); setSetupNotes("");
    await loadEligibleSessions();
  }

  async function runPreview() {
    if (!setupDecisionId) return;
    setPreviewLoading(true); setPreview(null);
    try {
      const d = await fetch_("/experiments/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: setupDecisionId, treatmentPct: setupTreatmentPct / 100 }),
      });
      setPreview(d);
    } catch (e: any) { setError(e.message); }
    finally { setPreviewLoading(false); }
  }

  async function createExperiment() {
    if (!setupDecisionId || !preview) return;
    setCreating(true); setError(null);
    try {
      const d = await fetch_("/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisionId: setupDecisionId,
          treatmentPct: setupTreatmentPct / 100,
          notes: setupNotes || null,
        }),
      });
      await loadExperiments();
      await openDetail(d.experiment);
    } catch (e: any) { setError(e.message); }
    finally { setCreating(false); }
  }

  // ── Detail view ───────────────────────────────────────────────────────────────

  async function saveMessage(pid: string) {
    try {
      await fetch_(`/experiments/${selectedExp!.id}/participants/${pid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_text: messageEdits[pid] }),
      });
      setParticipants(ps => ps.map(p => p.id === pid ? { ...p, message_text: messageEdits[pid] } : p));
      setEditingMessage(null);
    } catch (e: any) { setError(e.message); }
  }

  async function submitVeto(pid: string) {
    try {
      await fetch_(`/experiments/${selectedExp!.id}/veto/${pid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: vetoReason }),
      });
      setParticipants(ps => ps.map(p => p.id === pid ? { ...p, vetoed: true, veto_reason: vetoReason } : p));
      setVetoingId(null); setVetoReason("");
    } catch (e: any) { setError(e.message); }
  }

  async function markSent(ids: string[]) {
    if (ids.length === 0) return;
    setMarkingSent(true); setError(null);
    try {
      const d = await fetch_(`/experiments/${selectedExp!.id}/mark-sent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantIds: ids }),
      });
      const now = new Date().toISOString();
      setParticipants(ps => ps.map(p => ids.includes(p.id) ? { ...p, sent_at: now } : p));
      setSelectedTreatment(new Set());
      if (d.ok) {
        setSelectedExp(e => e ? { ...e, status: e.status === "ready" ? "sent" : e.status } : e);
      }
    } catch (e: any) { setError(e.message); }
    finally { setMarkingSent(false); }
  }

  async function runMeasure() {
    setMeasuring(true); setError(null);
    try {
      await fetch_(`/experiments/${selectedExp!.id}/measure`, { method: "POST" });
      // Poll for completion
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s = await fetch_(`/experiments/${selectedExp!.id}/measure/status`);
        if (s.status === "done" || s.status === "error") break;
      }
      // Reload participants
      const d = await fetch_(`/experiments/${selectedExp!.id}`);
      setParticipants(d.participants ?? []);
      setSelectedExp(d.experiment);
    } catch (e: any) { setError(e.message); }
    finally { setMeasuring(false); }
  }

  async function runDryRun() {
    if (!selectedExp) return;
    setDryRunLoading(true); setDryRunResult(null); setAwaitingApproval(false);
    try {
      const d = await fetch_(`/experiments/${selectedExp.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      setDryRunResult(d);
    } catch (e: any) { setError(e.message); }
    finally { setDryRunLoading(false); }
  }

  async function dispatchSend() {
    if (!selectedExp) return;
    setDispatching(true); setDispatchResult(null); setAwaitingApproval(false);
    try {
      const d = await fetch_(`/experiments/${selectedExp.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, dryRun: false }),
      });
      setDispatchResult(d);
      await loadDetail(selectedExp.id);
    } catch (e: any) { setError(e.message); }
    finally { setDispatching(false); }
  }

  function copyAll() {
    const msgs = participants
      .filter(p => p.arm === "treatment" && !p.vetoed)
      .map((p, i) => `[${i + 1}] ${p.players?.name ?? p.player_id}\n${p.players?.phone ?? ""}\n${messageEdits[p.id] ?? p.message_text ?? ""}`)
      .join("\n\n---\n\n");
    navigator.clipboard.writeText(msgs).catch(() => {});
  }

  const treatment = participants.filter(p => p.arm === "treatment");
  const control   = participants.filter(p => p.arm === "control");
  const unsentTreatment = treatment.filter(p => !p.vetoed && !p.sent_at);

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading && view === "list") {
    return <div style={{ color: TEXT2, padding: 32, textAlign: "center" }}>Loading experiments…</div>;
  }

  if (error) {
    return (
      <div style={{ color: RED, padding: 16, background: RED + "11", borderRadius: 6, margin: 16 }}>
        {error}
        <button onClick={() => setError(null)} style={{ marginLeft: 12, color: TEXT2, background: "none", border: "none", cursor: "pointer" }}>✕</button>
      </div>
    );
  }

  // ── List ──────────────────────────────────────────────────────────────────────

  if (view === "list") {
    return (
      <div style={{ color: TEXT, fontFamily: "monospace" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ color: TEXT2, fontSize: 12 }}>
            {experiments.length} experiment{experiments.length !== 1 ? "s" : ""}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {experiments.some(e => ["measuring","complete"].includes(e.status)) && (
              <button onClick={openResults} style={btnStyle(PURPLE)}>Pooled Results</button>
            )}
            <button onClick={loadSetup} style={btnStyle(BLUE)}>+ New Experiment</button>
          </div>
        </div>

        {experiments.length === 0 ? (
          <div style={{ color: TEXT2, textAlign: "center", padding: "48px 0" }}>
            No experiments yet. Create one by picking an upcoming session.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                {["Name", "Session", "Date", "Status", "Treatment", "Control", "Sent", ""].map(h => (
                  <th key={h} style={{ padding: "6px 10px", color: TEXT2, textAlign: "left", fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {experiments.map(e => (
                <tr key={e.id} style={{ borderBottom: `1px solid ${BORDER}22`, cursor: "pointer" }}
                    onClick={() => openDetail(e)}>
                  <td style={{ padding: "8px 10px", color: TEXT, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</td>
                  <td style={{ padding: "8px 10px", color: TEXT2, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.event_name}</td>
                  <td style={{ padding: "8px 10px", color: TEXT2, whiteSpace: "nowrap" }}>{e.event_start ? new Date(e.event_start).toLocaleDateString() : "—"}</td>
                  <td style={{ padding: "8px 10px" }}><Badge label={e.status} color={STATUS_COLOR[e.status]} /></td>
                  <td style={{ padding: "8px 10px", color: TEXT }}>{e.counts?.treatment ?? "—"}</td>
                  <td style={{ padding: "8px 10px", color: TEXT }}>{e.counts?.control ?? "—"}</td>
                  <td style={{ padding: "8px 10px", color: TEXT }}>{e.counts?.sent ?? 0}</td>
                  <td style={{ padding: "8px 10px", color: BLUE, whiteSpace: "nowrap" }}>View →</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  // ── Setup ─────────────────────────────────────────────────────────────────────

  if (view === "setup") {
    return (
      <div style={{ color: TEXT, fontFamily: "monospace" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <button onClick={() => setView("list")} style={backBtn()}>← Back</button>
          <span style={{ color: TEXT, fontWeight: 600 }}>New Experiment</span>
        </div>

        <div style={{ background: SURFACE, borderRadius: 8, padding: 20, border: `1px solid ${BORDER}`, marginBottom: 16 }}>
          <div style={{ color: TEXT2, fontSize: 11, marginBottom: 12, lineHeight: 1.6 }}>
            Pick an upcoming session that has a PROMOTE decision — the system already flagged it as under-enrolled.
            Set the treatment split, preview the qualifying pool, then randomize.
            The system assigns groups; you send manually from the Review screen.
          </div>

          <label style={labelStyle()}>Upcoming session</label>
          <select
            value={setupDecisionId}
            onChange={e => { setSetupDecisionId(e.target.value); setPreview(null); }}
            style={inputStyle()}
          >
            <option value="">— choose a session —</option>
            {eligibleSessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.event_name} — {new Date(s.event_start_time).toLocaleDateString()} ({s.signup_count}/{s.total_teams} booked)
              </option>
            ))}
          </select>
          {eligibleSessions.length === 0 && (
            <div style={{ color: TEXT2, fontSize: 11, marginTop: 6 }}>
              No eligible sessions found. The evaluator must have generated a PROMOTE decision for an upcoming session.
            </div>
          )}

          <label style={labelStyle()}>Treatment split</label>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <input type="range" min={50} max={90} step={5} value={setupTreatmentPct}
              onChange={e => { setSetupTreatmentPct(Number(e.target.value)); setPreview(null); }}
              style={{ flex: 1 }} />
            <span style={{ color: TEXT, minWidth: 80, fontSize: 13 }}>
              {setupTreatmentPct}% treatment / {100 - setupTreatmentPct}% control
            </span>
          </div>

          <label style={labelStyle()}>Notes (optional)</label>
          <textarea value={setupNotes} onChange={e => setSetupNotes(e.target.value)}
            placeholder="e.g. first test of lapsing cohort on Tuesday 6pm open play"
            style={{ ...inputStyle(), height: 60, resize: "vertical" }} />

          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              disabled={!setupDecisionId || previewLoading}
              onClick={runPreview}
              style={btnStyle(AMBER, !setupDecisionId || previewLoading)}
            >
              {previewLoading ? "Previewing…" : "Preview pool"}
            </button>
          </div>
        </div>

        {preview && (
          <div style={{ background: SURFACE, borderRadius: 8, padding: 20, border: `1px solid ${BORDER}`, marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 12, color: TEXT }}>Pool preview</div>

            {preview.min_pool_note && (
              <div style={{ background: AMBER + "18", border: `1px solid ${AMBER}44`, borderRadius: 6, padding: 10, marginBottom: 12, color: AMBER, fontSize: 12 }}>
                ⚠ {preview.min_pool_note}
              </div>
            )}

            <div style={{ display: "flex", gap: 24, marginBottom: 12, flexWrap: "wrap" }}>
              <Metric label="Qualifying candidates" value={preview.pool_size} />
              <Metric label="Treatment" value={preview.n_treatment} />
              <Metric label="Control (30-day holdout)" value={preview.n_control} />
            </div>

            {preview.balance && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: TEXT2, fontSize: 11, marginBottom: 6 }}>Arm balance check</div>
                {preview.treatment_stats && <ArmStatsRow label="Treatment" stats={preview.treatment_stats} />}
                {preview.control_stats && <ArmStatsRow label="Control" stats={preview.control_stats} />}
                {preview.balance.balanced
                  ? <div style={{ color: GREEN, fontSize: 11, marginTop: 6 }}>✓ Groups are balanced</div>
                  : <div style={{ color: AMBER, fontSize: 11, marginTop: 6 }}>⚠ Imbalance: {preview.balance.reason} — re-randomization will be attempted on create.</div>
                }
              </div>
            )}

            <div style={{ background: SURF2, borderRadius: 6, padding: 10, fontSize: 11, color: TEXT2, marginBottom: 12 }}>
              <strong style={{ color: TEXT }}>Funnel:</strong>{" "}
              {Object.entries(preview.funnel)
                .filter(([k]) => !k.startsWith("segment_"))
                .map(([k, v]) => `${k}: ${v}`)
                .join(" → ")}
            </div>

            <div style={{ background: SURF2, borderRadius: 6, padding: 10, fontSize: 11, color: TEXT2, marginBottom: 16, lineHeight: 1.6 }}>
              <strong style={{ color: TEXT }}>Power caveat:</strong> At ~{preview.n_treatment} treatment and ~{preview.n_control} control,
              this experiment can detect a large effect or a zero effect. It cannot measure a modest one.
              Results should be pooled across sessions before drawing conclusions.
            </div>

            <button
              disabled={!preview.worth_running || creating}
              onClick={createExperiment}
              style={btnStyle(GREEN, !preview.worth_running || creating)}
            >
              {creating ? "Creating…" : "Randomize and create experiment"}
            </button>
            {!preview.worth_running && (
              <div style={{ color: TEXT2, fontSize: 11, marginTop: 6 }}>
                Pool is too small (under 30). Choose a different session.
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Detail ────────────────────────────────────────────────────────────────────

  if (view === "detail" && selectedExp) {
    const allTreatmentIds = treatment.filter(p => !p.vetoed && !p.sent_at).map(p => p.id);

    return (
      <div style={{ color: TEXT, fontFamily: "monospace" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
          <button onClick={() => { setView("list"); loadExperiments(); }} style={backBtn()}>← Back</button>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{selectedExp.name}</span>
              <Badge label={selectedExp.status} color={STATUS_COLOR[selectedExp.status]} />
            </div>
            <div style={{ color: TEXT2, fontSize: 11, marginTop: 4 }}>
              {selectedExp.event_name} · {selectedExp.event_start ? new Date(selectedExp.event_start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }) : "—"}
              {" · "}{Math.round((selectedExp.treatment_pct ?? 0.7) * 100)}% treatment
              {selectedExp.notes && <span> · {selectedExp.notes}</span>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={copyAll} style={btnStyle(TEXT2)}>Copy all messages</button>
            {(selectedExp.status === "sent" || selectedExp.status === "measuring") && (
              <button onClick={runMeasure} disabled={measuring} style={btnStyle(PURPLE, measuring)}>
                {measuring ? "Measuring…" : "Measure outcomes"}
              </button>
            )}
          </div>
        </div>

        {/* ── Dispatch Panel (Phase 4.1) ─────────────────────────────────── */}
        {selectedExp.status === "ready" && !dispatchResult && (
          <div style={{ marginBottom: 16 }}>
            {/* Override / live-mode banner — shown after dry run */}
            {dryRunResult && (
              dryRunResult.test_override_active ? (
                <div style={{ background: AMBER + "18", border: `2px solid ${AMBER}`, borderRadius: 8, padding: "10px 16px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 22 }}>⚠</span>
                  <div>
                    <div style={{ color: AMBER, fontWeight: 700, fontSize: 13 }}>TEST OVERRIDE ACTIVE</div>
                    <div style={{ color: TEXT2, fontSize: 11 }}>All messages route to {dryRunResult.test_override_to_masked} — not to real members.</div>
                  </div>
                </div>
              ) : (
                <div style={{ background: RED + "18", border: `2px solid ${RED}`, borderRadius: 8, padding: "10px 16px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 22 }}>🔴</span>
                  <div>
                    <div style={{ color: RED, fontWeight: 700, fontSize: 13 }}>LIVE MODE — MESSAGES GO TO REAL MEMBERS</div>
                    <div style={{ color: TEXT2, fontSize: 11 }}>No test override active. Each message delivers to the member's actual phone number.</div>
                  </div>
                </div>
              )
            )}

            <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div>
                  <span style={{ fontWeight: 600, color: TEXT }}>Dispatch</span>
                  <span style={{ color: TEXT2, fontSize: 11, marginLeft: 10 }}>
                    Run a dry run first, then approve.
                  </span>
                </div>
                <button onClick={runDryRun} disabled={dryRunLoading} style={btnStyle(AMBER, dryRunLoading)}>
                  {dryRunLoading ? "Checking…" : dryRunResult ? "Re-run dry run" : "Dry run"}
                </button>
              </div>

              {!dryRunResult && (
                <div style={{ color: TEXT2, fontSize: 11, lineHeight: 1.7 }}>
                  Dry run checks every precondition — kill switch, consent, control-arm exclusion, hard cap — and shows
                  exactly who would receive a message and what they'd receive. No messages are sent.
                  After review, you approve with a single click.
                </div>
              )}

              {dryRunResult && (
                <div>
                  {/* Preconditions checklist */}
                  <div style={{ marginBottom: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px" }}>
                    {Object.entries(dryRunResult.preconditions).map(([k, v]: any) => (
                      <div key={k} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
                        <span style={{ color: v ? GREEN : RED, fontWeight: 700 }}>{v ? "✓" : "✗"}</span>
                        <span style={{ color: v ? TEXT2 : RED }}>{k.replace(/_/g, " ")}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ color: TEXT, fontSize: 13, marginBottom: 10 }}>
                    Would dispatch <strong style={{ color: GREEN }}>{dryRunResult.would_send}</strong> messages to the treatment arm.
                  </div>

                  {/* Recipients preview */}
                  {(dryRunResult.recipients?.length ?? 0) > 0 && (
                    <div style={{ maxHeight: 180, overflowY: "auto", marginBottom: 12, background: SURF2, borderRadius: 6, padding: 8 }}>
                      {dryRunResult.recipients.map((r: any) => (
                        <div key={r.participant_id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "3px 0", borderBottom: `1px solid ${BORDER}22`, fontSize: 11 }}>
                          <span style={{ color: TEXT2, minWidth: 22 }}>#{r.rank}</span>
                          <span style={{ color: TEXT, minWidth: 110, flexShrink: 0 }}>{r.player_name}</span>
                          <span style={{ color: r.segment === "lapsing" ? AMBER : PURPLE, minWidth: 55, flexShrink: 0 }}>{r.segment}</span>
                          <span style={{ color: TEXT2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{r.message_preview}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Approve or precondition failure */}
                  {dryRunResult.all_green ? (
                    !awaitingApproval ? (
                      <button onClick={() => setAwaitingApproval(true)} style={btnStyle(GREEN)}>
                        Approve & dispatch {dryRunResult.would_send} messages →
                      </button>
                    ) : (
                      <div style={{ background: GREEN + "11", border: `1px solid ${GREEN}44`, borderRadius: 6, padding: 14, marginTop: 8 }}>
                        <div style={{ color: GREEN, fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                          Send {dryRunResult.would_send} messages to treatment arm for {selectedExp.event_name}?
                        </div>
                        {dryRunResult.test_override_active && (
                          <div style={{ background: AMBER + "18", border: `1px solid ${AMBER}44`, borderRadius: 4, padding: "6px 10px", marginBottom: 8, color: AMBER, fontSize: 12 }}>
                            ⚠ Test override ACTIVE — all messages route to {dryRunResult.test_override_to_masked}
                          </div>
                        )}
                        {!dryRunResult.test_override_active && (
                          <div style={{ background: RED + "18", border: `1px solid ${RED}44`, borderRadius: 4, padding: "6px 10px", marginBottom: 8, color: RED, fontSize: 12, fontWeight: 600 }}>
                            🔴 LIVE: each message will be delivered to the member's real phone number
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 10 }}>
                          <button onClick={dispatchSend} disabled={dispatching} style={btnStyle(GREEN, dispatching)}>
                            {dispatching ? "Dispatching…" : "Yes, send now"}
                          </button>
                          <button onClick={() => setAwaitingApproval(false)} style={btnStyle(TEXT2)}>Cancel</button>
                        </div>
                      </div>
                    )
                  ) : (
                    <div style={{ color: RED, fontSize: 11, padding: "6px 0" }}>
                      ✗ One or more preconditions failed — resolve before dispatching.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Dispatch result */}
        {dispatchResult && (
          <div style={{ background: SURF2, border: `1px solid ${dispatchResult.failed > 0 ? RED : GREEN}55`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ fontWeight: 600, color: TEXT, marginBottom: 8 }}>
              Dispatch complete — {dispatchResult.dispatched} sent · {dispatchResult.failed} failed · {dispatchResult.skipped + dispatchResult.aborted} skipped/aborted
              {dispatchResult.test_override_active && <span style={{ color: AMBER, marginLeft: 8 }}>(test override was active)</span>}
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto" }}>
              {dispatchResult.results?.map((r: any, i: number) => (
                <div key={r.participant_id ?? i} style={{ display: "flex", gap: 8, fontSize: 11, padding: "2px 0", borderBottom: `1px solid ${BORDER}22` }}>
                  <span style={{ color: r.outcome === "sent" ? GREEN : r.outcome === "failed" ? RED : TEXT2, fontWeight: 700 }}>
                    {r.outcome === "sent" ? "✓" : r.outcome === "failed" ? "✗" : "—"}
                  </span>
                  <span style={{ color: r.outcome === "sent" ? GREEN : r.outcome === "failed" ? RED : TEXT2 }}>
                    {r.outcome}{r.simulated ? " (simulated)" : ""}{r.error ? `: ${r.error.slice(0, 80)}` : ""}
                  </span>
                  {r.twilio_sid && <span style={{ color: TEXT2 }}>SID {r.twilio_sid}</span>}
                </div>
              ))}
            </div>
            {/* No re-send button per 4d — failed messages are investigated, not retried */}
            {dispatchResult.failed > 0 && (
              <div style={{ color: TEXT2, fontSize: 11, marginTop: 8 }}>
                Failed sends are recorded in the participant list for investigation. Do not retry from this UI.
              </div>
            )}
          </div>
        )}

        {/* Manual send reminder — shown when already-sent or no dispatch panel */}
        {selectedExp.status !== "ready" && !dispatchResult && (
          <div style={{ background: AMBER + "12", border: `1px solid ${AMBER}33`, borderRadius: 6, padding: "8px 12px", fontSize: 11, color: AMBER, marginBottom: 16 }}>
            This experiment has already been dispatched or is in {selectedExp.status} status.
            Use "Mark sent" to record any additional manual sends, or "Measure outcomes" to update results.
          </div>
        )}

        {/* Treatment section */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ color: TEXT, fontWeight: 600, fontSize: 13 }}>
              Treatment — {treatment.length} participants
              {treatment.some(p => !p.vetoed && p.sent_at && !p.reasons?.dispatch_simulated) && (
                <span style={{ color: GREEN, marginLeft: 8, fontSize: 11 }}>
                  {treatment.filter(p => !p.vetoed && p.sent_at && !p.reasons?.dispatch_simulated).length} sent
                </span>
              )}
              {treatment.some(p => !p.vetoed && p.sent_at && p.reasons?.dispatch_simulated) && (
                <span style={{ color: AMBER, marginLeft: 8, fontSize: 11 }}>
                  {treatment.filter(p => !p.vetoed && p.sent_at && p.reasons?.dispatch_simulated).length} simulated (nothing delivered)
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {unsentTreatment.length > 0 && (
                <>
                  <label style={{ color: TEXT2, fontSize: 11, cursor: "pointer" }}>
                    <input type="checkbox"
                      checked={selectedTreatment.size === unsentTreatment.length && unsentTreatment.length > 0}
                      onChange={e => setSelectedTreatment(e.target.checked ? new Set(unsentTreatment.map(p => p.id)) : new Set())}
                      style={{ marginRight: 4 }}
                    />
                    Select all
                  </label>
                  {selectedTreatment.size > 0 && (
                    <button
                      onClick={() => markSent([...selectedTreatment])}
                      disabled={markingSent}
                      style={btnStyle(GREEN, markingSent)}
                    >
                      {markingSent ? "Marking…" : `Mark ${selectedTreatment.size} sent`}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {treatment.map(p => (
            <TreatmentRow
              key={p.id}
              p={p}
              editing={editingMessage === p.id}
              editValue={messageEdits[p.id] ?? p.message_text ?? ""}
              selected={selectedTreatment.has(p.id)}
              vetoingThis={vetoingId === p.id}
              vetoReason={vetoReason}
              onEdit={() => { setEditingMessage(p.id); setMessageEdits(m => ({ ...m, [p.id]: m[p.id] ?? p.message_text ?? "" })); }}
              onEditChange={v => setMessageEdits(m => ({ ...m, [p.id]: v }))}
              onSaveMessage={() => saveMessage(p.id)}
              onCancelEdit={() => setEditingMessage(null)}
              onCopy={() => navigator.clipboard.writeText(messageEdits[p.id] ?? p.message_text ?? "").catch(() => {})}
              onMarkSent={() => markSent([p.id])}
              onVetoStart={() => { setVetoingId(p.id); setVetoReason(""); }}
              onVetoReasonChange={setVetoReason}
              onVetoSubmit={() => submitVeto(p.id)}
              onVetoCancel={() => { setVetoingId(null); setVetoReason(""); }}
              onSelect={checked => setSelectedTreatment(s => { const n = new Set(s); checked ? n.add(p.id) : n.delete(p.id); return n; })}
            />
          ))}
        </div>

        {/* Control section */}
        <div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: RED, fontWeight: 600, fontSize: 13 }}>
              Control — {control.length} participants — DO NOT CONTACT
            </div>
            <div style={{ color: TEXT2, fontSize: 11, marginTop: 2 }}>
              These members are held out for 30 days from randomization. They are shown here so you can
              see who is being withheld. Do not contact them through any channel during this period —
              doing so invalidates the comparison.
            </div>
          </div>

          <div style={{ background: SURF2, border: `1px solid ${RED}33`, borderRadius: 6, padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                  {["Rank", "Name", "Segment", "Days away", "Score", "Vetoed"].map(h => (
                    <th key={h} style={{ padding: "6px 10px", color: TEXT2, textAlign: "left", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {control.map(p => (
                  <tr key={p.id} style={{ borderBottom: `1px solid ${BORDER}22`, opacity: p.vetoed ? 0.4 : 1 }}>
                    <td style={{ padding: "6px 10px", color: TEXT2 }}>{p.rank ?? "—"}</td>
                    <td style={{ padding: "6px 10px", color: TEXT }}>{p.players?.name ?? p.player_id}</td>
                    <td style={{ padding: "6px 10px" }}>
                      <Pill label={p.reasons?.retention_segment ?? "—"}
                            color={p.reasons?.retention_segment === "lapsing" ? AMBER : PURPLE} />
                    </td>
                    <td style={{ padding: "6px 10px", color: TEXT2 }}>{p.reasons?.days_since_visit ?? "—"}d</td>
                    <td style={{ padding: "6px 10px", color: TEXT }}>{p.score}</td>
                    <td style={{ padding: "6px 10px" }}>
                      {p.vetoed
                        ? <span style={{ color: RED, fontSize: 11 }}>vetoed{p.veto_reason ? `: ${p.veto_reason}` : ""}</span>
                        : <button onClick={() => { setVetoingId(p.id); setVetoReason(""); }}
                            style={{ ...btnStyle(RED), fontSize: 10, padding: "2px 8px" }}>Veto</button>
                      }
                      {vetoingId === p.id && (
                        <VetoPanel
                          reason={vetoReason} onChange={setVetoReason}
                          onSubmit={() => submitVeto(p.id)}
                          onCancel={() => { setVetoingId(null); setVetoReason(""); }}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ── Results ───────────────────────────────────────────────────────────────────

  if (view === "results") {
    return (
      <div style={{ color: TEXT, fontFamily: "monospace" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <button onClick={() => setView("list")} style={backBtn()}>← Back</button>
          <span style={{ fontWeight: 600 }}>Pooled Results</span>
        </div>

        {pooledExps.length === 0 ? (
          <div style={{ color: TEXT2, textAlign: "center", padding: 48 }}>No completed experiments yet.</div>
        ) : (
          <>
            {/* Per-experiment table */}
            {pooledExps.map((e: any) => (
              <div key={e.id} style={{ marginBottom: 24 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, color: TEXT }}>
                  {e.name}
                  <span style={{ marginLeft: 8 }}><Badge label={e.status} color={STATUS_COLOR[e.status] ?? TEXT2} /></span>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, border: `1px solid ${BORDER}` }}>
                  <thead>
                    <tr style={{ background: SURF2 }}>
                      <th style={thStyle()}>Metric</th>
                      <th style={thStyle()}>Treatment (n={e.treatment.n})</th>
                      <th style={thStyle()}>Control (n={e.control.n})</th>
                      <th style={thStyle()}>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ResultRow label="Booked target session"
                      t={e.treatment.booked} tn={e.treatment.n}
                      c={e.control.booked}   cn={e.control.n} />
                    <ResultRow label={`Attended within 30 days${e.treatment.provisional_30d || e.control.provisional_30d ? " †" : ""}`}
                      t={e.treatment.attended} tn={e.treatment.n}
                      c={e.control.attended}   cn={e.control.n} />
                  </tbody>
                </table>
                {(e.treatment.provisional_30d || e.control.provisional_30d) && (
                  <div style={{ color: TEXT2, fontSize: 10, marginTop: 4 }}>
                    † 30-day window not yet closed for all participants — provisional numbers only.
                  </div>
                )}
              </div>
            ))}

            {/* Pooled */}
            {pooled && pooled.n_experiments > 1 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 8, color: TEXT }}>
                  Pooled across {pooled.n_experiments} experiments
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, border: `1px solid ${BORDER}`, marginBottom: 12 }}>
                  <thead>
                    <tr style={{ background: SURF2 }}>
                      <th style={thStyle()}>Metric</th>
                      <th style={thStyle()}>Treatment (n={pooled.treatment_n})</th>
                      <th style={thStyle()}>Control (n={pooled.control_n})</th>
                      <th style={thStyle()}>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ResultRow label="Booked target session"
                      t={pooled.treatment_booked} tn={pooled.treatment_n}
                      c={pooled.control_booked}   cn={pooled.control_n} />
                    <ResultRow label="Attended within 30 days"
                      t={pooled.treatment_attended} tn={pooled.treatment_n}
                      c={pooled.control_attended}   cn={pooled.control_n} />
                  </tbody>
                </table>
                <div style={{ background: SURF2, borderRadius: 6, padding: 12, fontSize: 11, color: TEXT2, lineHeight: 1.7 }}>
                  <strong style={{ color: TEXT }}>How to read this:</strong> {pooled.power_caveat}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return null;
}

// ── TreatmentRow ──────────────────────────────────────────────────────────────

function TreatmentRow(props: {
  p: Participant;
  editing: boolean; editValue: string; selected: boolean;
  vetoingThis: boolean; vetoReason: string;
  onEdit: () => void; onEditChange: (v: string) => void;
  onSaveMessage: () => void; onCancelEdit: () => void;
  onCopy: () => void; onMarkSent: () => void;
  onVetoStart: () => void; onVetoReasonChange: (v: string) => void;
  onVetoSubmit: () => void; onVetoCancel: () => void;
  onSelect: (checked: boolean) => void;
}) {
  const { p } = props;
  const sent      = !!p.sent_at;
  const simulated = sent && p.reasons?.dispatch_simulated === true;
  const vetoed    = p.vetoed;
  const seg       = p.reasons?.retention_segment ?? "—";

  return (
    <div style={{
      background: vetoed ? SURF2 : sent ? GREEN + "08" : SURFACE,
      border: `1px solid ${vetoed ? BORDER : sent ? GREEN + "33" : BORDER}`,
      borderRadius: 6, padding: 12, marginBottom: 8,
      opacity: vetoed ? 0.5 : 1,
    }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {!sent && !vetoed && (
          <input type="checkbox" checked={props.selected}
            onChange={e => props.onSelect(e.target.checked)}
            style={{ marginTop: 3, cursor: "pointer" }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Header row */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ color: TEXT2, fontSize: 11 }}>#{p.rank}</span>
            <span style={{ color: TEXT, fontWeight: 600 }}>{p.players?.name ?? p.player_id}</span>
            <Pill label={seg} color={seg === "lapsing" ? AMBER : PURPLE} />
            <span style={{ color: TEXT2, fontSize: 11 }}>{p.reasons?.days_since_visit ?? "—"}d away</span>
            <span style={{ color: TEXT2, fontSize: 11 }}>score {p.score}</span>
            {p.reasons?.buddy_already_signed_up && (
              <Pill label={`buddy×${p.reasons.buddy_already_signed_up}`} color={BLUE} />
            )}
            {sent && !simulated && <Badge label="sent" color={GREEN} />}
            {simulated && <Badge label="simulated — not delivered" color={AMBER} />}
            {vetoed && <Badge label={`vetoed${p.veto_reason ? ": " + p.veto_reason : ""}`} color={RED} />}
          </div>

          {/* Phone */}
          {p.players?.phone && (
            <div style={{ color: TEXT2, fontSize: 11, marginBottom: 6 }}>
              📱 {p.players.phone}
            </div>
          )}

          {/* Message */}
          {!vetoed && (
            <div style={{ marginBottom: 8 }}>
              {props.editing ? (
                <div>
                  <textarea
                    value={props.editValue}
                    onChange={e => props.onEditChange(e.target.value)}
                    style={{ width: "100%", background: "#0d1117", color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 4, padding: 8, fontSize: 12, lineHeight: 1.6, resize: "vertical", minHeight: 80, boxSizing: "border-box" }}
                    autoFocus
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button onClick={props.onSaveMessage} style={btnStyle(GREEN)}>Save</button>
                    <button onClick={props.onCancelEdit} style={btnStyle(TEXT2)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div style={{ background: "#0d1117", border: `1px solid ${BORDER}`, borderRadius: 4, padding: 8, fontSize: 12, color: TEXT, lineHeight: 1.6, cursor: "text" }}
                     onClick={props.onEdit}>
                  {p.message_text ?? <span style={{ color: TEXT2, fontStyle: "italic" }}>No message drafted</span>}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          {!vetoed && (
            <div style={{ display: "flex", gap: 6 }}>
              {!props.editing && (
                <>
                  <button onClick={props.onEdit} style={{ ...btnStyle(TEXT2), fontSize: 11 }}>Edit</button>
                  <button onClick={props.onCopy} style={{ ...btnStyle(TEXT2), fontSize: 11 }}>Copy</button>
                </>
              )}
              {!sent && (
                <button onClick={props.onMarkSent} style={{ ...btnStyle(GREEN), fontSize: 11 }}>Mark sent</button>
              )}
              {!props.vetoingThis && (
                <button onClick={props.onVetoStart} style={{ ...btnStyle(RED), fontSize: 11 }}>Veto</button>
              )}
            </div>
          )}

          {/* Veto panel */}
          {props.vetoingThis && !vetoed && (
            <VetoPanel
              reason={props.vetoReason} onChange={props.onVetoReasonChange}
              onSubmit={props.onVetoSubmit} onCancel={props.onVetoCancel}
            />
          )}

          {/* Outcome (if measured) */}
          {p.outcome_measured_at && (
            <div style={{ display: "flex", gap: 10, marginTop: 6, fontSize: 11 }}>
              <OutcomeChip label="booked" value={p.booked_target_session} />
              <OutcomeChip label="attended 30d" value={p.attended_within_30d} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VetoPanel(props: { reason: string; onChange: (v: string) => void; onSubmit: () => void; onCancel: () => void }) {
  return (
    <div style={{ background: RED + "11", border: `1px solid ${RED}33`, borderRadius: 6, padding: 10, marginTop: 8 }}>
      <div style={{ color: RED, fontSize: 11, marginBottom: 6 }}>
        Vetoing removes this person from the experiment entirely — from both arms.
        They will not be contacted and will not appear in results. This cannot be undone.
      </div>
      <input
        placeholder="Reason (optional)"
        value={props.reason}
        onChange={e => props.onChange(e.target.value)}
        style={{ ...inputStyle(), marginBottom: 8, padding: "4px 8px" }}
        autoFocus
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={props.onSubmit} style={btnStyle(RED)}>Confirm veto</button>
        <button onClick={props.onCancel} style={btnStyle(TEXT2)}>Cancel</button>
      </div>
    </div>
  );
}

function OutcomeChip({ label, value }: { label: string; value: boolean | null }) {
  const color = value === null ? TEXT2 : value ? GREEN : RED;
  const text  = value === null ? "provisional" : value ? "yes" : "no";
  return <span style={{ color, fontSize: 11 }}>{label}: <strong>{text}</strong></span>;
}

function ResultRow({ label, t, tn, c, cn }: { label: string; t: number; tn: number; c: number; cn: number }) {
  const tPct = tn > 0 ? ((t / tn) * 100).toFixed(0) : "—";
  const cPct = cn > 0 ? ((c / cn) * 100).toFixed(0) : "—";
  const diff = tn > 0 && cn > 0 ? ((t / tn - c / cn) * 100).toFixed(0) : "—";
  const diffNum = typeof diff === "string" && diff !== "—" ? Number(diff) : null;
  return (
    <tr style={{ borderBottom: `1px solid ${BORDER}22` }}>
      <td style={{ padding: "8px 10px", color: TEXT2 }}>{label}</td>
      <td style={{ padding: "8px 10px", color: TEXT }}>{t} / {tn} ({tPct}%)</td>
      <td style={{ padding: "8px 10px", color: TEXT }}>{c} / {cn} ({cPct}%)</td>
      <td style={{ padding: "8px 10px", color: diffNum !== null && diffNum > 0 ? GREEN : diffNum !== null && diffNum < 0 ? RED : TEXT2 }}>
        {diff !== "—" ? (Number(diff) >= 0 ? `+${diff}pp` : `${diff}pp`) : "—"}
      </td>
    </tr>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div style={{ color: TEXT2, fontSize: 10 }}>{label}</div>
      <div style={{ color: TEXT, fontSize: 20, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────────────────

function btnStyle(color: string, disabled = false): React.CSSProperties {
  return {
    background: color + "20", color, border: `1px solid ${color}44`,
    borderRadius: 5, padding: "4px 12px", cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12, opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap",
  };
}

function backBtn(): React.CSSProperties {
  return { background: "none", border: "none", color: BLUE, cursor: "pointer", fontSize: 13, padding: 0 };
}

function labelStyle(): React.CSSProperties {
  return { display: "block", color: TEXT2, fontSize: 11, marginBottom: 4, marginTop: 12 };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%", background: "#0d1117", color: TEXT, border: `1px solid ${BORDER}`,
    borderRadius: 5, padding: "6px 10px", fontSize: 12, boxSizing: "border-box",
  };
}

function thStyle(): React.CSSProperties {
  return { padding: "7px 10px", color: TEXT2, fontWeight: 500, textAlign: "left", borderBottom: `1px solid ${BORDER}` };
}
