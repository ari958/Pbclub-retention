import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { useToast } from "@/components/Toast";
import { toTitleCase } from "@/lib/helpers";
import type { MessageTemplate } from "@/lib/types";

const D = {
  bg: "#161b22",
  card: "#0f1117",
  border: "#30363d",
  inner: "#1e2530",
  text: "#e6edf3",
  muted: "#8b949e",
  faint: "#6e7681",
  accent: "#E8A838",
  accentBg: "rgba(232,168,56,0.10)",
  green: "#2ea043",
  greenBg: "rgba(46,160,67,0.10)",
  orange: "#d4813a",
  orangeBg: "rgba(212,129,58,0.10)",
  red: "#cf222e",
  redBg: "rgba(207,34,46,0.08)",
  redText: "#ff6b6b",
} as const;

interface ClubRow {
  id: string;
  name: string;
  agent_config: Record<string, unknown> | null;
  scheduled_sync_time: string | null;
  timezone: string | null;
}

interface JobState {
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: Record<string, number> | null;
  error: string | null;
  recentLogs: string[];
}

const KNOWN_LABELS: Record<string, string> = {
  max_messages_per_day: "Max messages per day",
  max_messages_per_week: "Max messages per week",
  tone: "Agent tone",
  language: "Language",
  signup_link_base: "Signup link base URL",
  follow_up_days: "Follow-up window (days)",
  enabled: "Agent enabled",
  dormant_threshold_days: "Inactive threshold days",
  lapsing_threshold_days: "Drifting threshold days",
  max_messages_per_thread: "Max messages per thread",
};

const TAG_LABELS: Record<string, string> = {
  "never-visited": "Never Visited",
  dormant: "Inactive",
  lapsing: "Drifting",
  active: "Active",
  "ready-to-advance": "Ready to Advance",
  session_feedback: "Session Feedback",
};

const COMMON_TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Phoenix", "America/Anchorage",
  "Pacific/Honolulu", "America/Toronto", "America/Vancouver",
  "Europe/London", "Europe/Paris", "Australia/Sydney", "Pacific/Auckland",
];

const USE_CASE_OPTIONS = [
  "never-visited", "dormant", "lapsing", "active", "ready-to-advance",
];

const TEMPLATE_VARS = [
  "{{first_name}}", "{{skill_level}}", "{{club_name}}",
  "{{last_visit}}", "{{event_date}}", "{{booking_link}}",
];

const PREVIEW_VALS: Record<string, string> = {
  first_name: "Alex", skill_level: "3.5", club_name: "PB Club",
  last_visit: "Mar 4", event_date: "May 10", booking_link: "pbclub.com/book",
  event_link: "pbclub.com/events", next_level: "4.0",
};

function previewBody(body: string): React.ReactNode {
  const parts = body.split(/(\{\{\w+\}\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\{\{(\w+)\}\}$/);
        if (!m) return <span key={i}>{part}</span>;
        const v = m[1];
        const resolved = PREVIEW_VALS[v];
        return resolved ? (
          <span key={i} style={{ background: D.greenBg, color: D.green, borderRadius: 3, padding: "0 3px", fontFamily: "var(--font-mono)", fontSize: 11 }}>{resolved}</span>
        ) : (
          <span key={i} style={{ background: D.accentBg, color: D.accent, borderRadius: 3, padding: "0 3px", fontFamily: "var(--font-mono)", fontSize: 11 }}>{part}</span>
        );
      })}
    </>
  );
}

function smsCount(body: string): string {
  const len = body.length;
  if (len === 0) return "0 chars";
  return `${len} chars · ${Math.ceil(len / 160)} SMS`;
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  return String(val);
}

function formatJobTime(iso: string | null): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 5,
  border: `1px solid ${D.border}`,
  background: D.inner,
  color: D.text,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: D.faint,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
  display: "block",
};

const cardStyle: React.CSSProperties = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  overflow: "hidden",
};

const cardHeadStyle: React.CSSProperties = {
  padding: "14px 20px 12px",
  borderBottom: `1px solid ${D.border}`,
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 500,
  color: D.faint,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

type EditorMode = "idle" | "new" | "edit-custom" | "view-builtin";

function SyncLogPanel() {
  const [syncJob, setSyncJob] = useState<JobState | null>(null);
  const [importJob, setImportJob] = useState<JobState | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<"sync" | "import" | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const [syncRes, importRes] = await Promise.all([
        fetch("/api/sync/events/status"),
        fetch("/api/import/status"),
      ]);
      if (syncRes.ok) setSyncJob(await syncRes.json());
      if (importRes.ok) setImportJob(await importRes.json());
    } catch { }
    setLoading(false);
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const statusColor = (status: string) => {
    if (status === "done") return D.green;
    if (status === "error") return D.redText;
    if (status === "running") return D.accent;
    if (status === "cancelled") return D.faint;
    return D.faint;
  };

  const renderJob = (label: string, job: JobState | null, key: "sync" | "import") => {
    if (!job) return null;
    const isExpanded = expanded === key;
    return (
      <div style={{ borderBottom: `1px solid ${D.border}` }}>
        <div
          onClick={() => setExpanded(isExpanded ? null : key)}
          style={{ padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", userSelect: "none" }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = D.inner; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 500, fontSize: 13, color: D.text }}>{label}</span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 3,
                background: D.inner,
                color: statusColor(job.status),
                border: `1px solid ${D.border}`,
              }}
            >
              {job.status}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: D.faint, fontFamily: "var(--font-mono)" }}>
              {job.finishedAt
                ? `Last run: ${formatJobTime(job.finishedAt)}`
                : job.startedAt
                  ? `Started: ${formatJobTime(job.startedAt)}`
                  : "Never run"}
            </span>
            <span style={{ fontSize: 12, color: D.faint }}>{isExpanded ? "▲" : "▼"}</span>
          </div>
        </div>

        {isExpanded && (
          <div style={{ padding: "0 20px 16px", borderTop: `1px solid ${D.border}`, background: D.inner }}>
            {job.stats && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "12px 0 10px" }}>
                {Object.entries(job.stats).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: D.faint, textTransform: "uppercase" }}>{k}</span>
                    <span style={{ fontSize: 16, fontWeight: 600, color: k === "errors" && v > 0 ? D.redText : D.text }}>{v}</span>
                  </div>
                ))}
              </div>
            )}
            {job.error && (
              <div style={{ fontSize: 12, color: D.redText, background: D.redBg, border: "1px solid rgba(207,34,46,0.2)", borderRadius: 5, padding: "8px 12px", marginBottom: 10 }}>
                {job.error}
              </div>
            )}
            {job.recentLogs.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: D.faint, textTransform: "uppercase", marginBottom: 6 }}>Recent logs</div>
                <div style={{ maxHeight: 200, overflowY: "auto", background: D.card, border: `1px solid ${D.border}`, borderRadius: 5, padding: "8px 10px" }}>
                  {job.recentLogs.slice(-20).map((line, i) => (
                    <div
                      key={i}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: line.includes("ERROR") || line.includes("TIMEOUT") ? D.redText : D.muted,
                        lineHeight: 1.7,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {job.recentLogs.length === 0 && !job.stats && !job.error && (
              <div style={{ fontSize: 12, color: D.faint, padding: "10px 0" }}>No activity recorded yet.</div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={cardStyle}>
      <div style={{ ...cardHeadStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Sync & Import Log</span>
        <button
          onClick={fetchJobs}
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            padding: "2px 8px",
            borderRadius: 3,
            background: D.inner,
            color: D.muted,
            border: `1px solid ${D.border}`,
            cursor: "pointer",
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          Refresh
        </button>
      </div>
      {loading ? (
        <div style={{ padding: "20px", fontSize: 13, color: D.faint }}>Loading…</div>
      ) : (
        <>
          {renderJob("Attendance Sync", syncJob, "sync")}
          {renderJob("Player Import", importJob, "import")}
        </>
      )}
    </div>
  );
}

export default function Settings() {
  const toast = useToast();

  const [club, setClub] = useState<ClubRow | null>(null);
  const [clubLoading, setClubLoading] = useState(true);
  const [syncTime, setSyncTime] = useState("02:00");
  const [timezone, setTimezone] = useState("America/New_York");
  const [saving, setSaving] = useState(false);
  const [hasScheduleColumns, setHasScheduleColumns] = useState(true);

  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [editorMode, setEditorMode] = useState<EditorMode>("idle");
  const [editingId, setEditingId] = useState<string | null>(null);

  const [tName, setTName] = useState("");
  const [tBody, setTBody] = useState("");
  const [tTags, setTTags] = useState<string[]>([]);
  const [tSaving, setTSaving] = useState(false);

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const readOnly = editorMode === "view-builtin";

  useEffect(() => {
    supabase.from("clubs").select("id, name, agent_config, scheduled_sync_time, timezone").limit(1).maybeSingle()
      .then(({ data, error }) => {
        if (error?.message?.includes("scheduled_sync_time") || error?.code === "42703") {
          setHasScheduleColumns(false);
          supabase.from("clubs").select("id, name, agent_config").limit(1).maybeSingle()
            .then(({ data: fallback }) => { if (fallback) setClub(fallback as ClubRow); setClubLoading(false); });
        } else {
          if (data) {
            setClub(data as ClubRow);
            setSyncTime(data.scheduled_sync_time ?? "02:00");
            setTimezone(data.timezone ?? "America/New_York");
          }
          setClubLoading(false);
        }
      });
  }, []);

  const fetchTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTemplates(await res.json());
    } catch { toast.error("Failed to load templates"); }
    finally { setTemplatesLoading(false); }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const saveSchedule = async () => {
    if (!club) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("clubs").update({ scheduled_sync_time: syncTime, timezone }).eq("id", club.id);
      if (error) toast.error(error.message);
      else {
        setClub((prev) => prev ? { ...prev, scheduled_sync_time: syncTime, timezone } : prev);
        toast.success("Schedule saved");
      }
    } finally { setSaving(false); }
  };

  const openNew = () => { setEditorMode("new"); setEditingId(null); setTName(""); setTBody(""); setTTags([]); };
  const openEditCustom = (t: MessageTemplate) => { setEditorMode("edit-custom"); setEditingId(t.id); setTName(t.name); setTBody(t.body); setTTags([...t.use_case_tags]); };
  const openViewBuiltin = (t: MessageTemplate) => { setEditorMode("view-builtin"); setEditingId(t.id); setTName(t.name); setTBody(t.body); setTTags([...t.use_case_tags]); };
  const discardEditor = () => { setEditorMode("idle"); setEditingId(null); };

  const insertVar = (v: string) => {
    if (readOnly) return;
    const el = bodyRef.current;
    if (!el) { setTBody((b) => b + v); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setTBody(el.value.slice(0, start) + v + el.value.slice(end));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + v.length, start + v.length); });
  };

  const toggleTag = (tag: string) => {
    if (readOnly) return;
    setTTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
  };

  const saveTemplate = async () => {
    if (!tName.trim() || !tBody.trim()) { toast.error("Name and body are required"); return; }
    setTSaving(true);
    try {
      let res: Response;
      if (editorMode === "new") {
        res = await fetch("/api/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: tName.trim(), body: tBody.trim(), use_case_tags: tTags }) });
      } else {
        res = await fetch(`/api/templates/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: tName.trim(), body: tBody.trim(), use_case_tags: tTags }) });
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      toast.success(editorMode === "new" ? "Template created" : "Template updated");
      discardEditor();
      await fetchTemplates();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Save failed"); }
    finally { setTSaving(false); }
  };

  const configEntries: [string, unknown][] = club?.agent_config ? Object.entries(club.agent_config) : [];
  const editorOpen = editorMode !== "idle";

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: D.bg }}>
      <Sidebar clubName={club?.name ?? ""} />
      <div style={{ marginLeft: 240, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <header
          style={{
            height: 52,
            minHeight: 52,
            display: "flex",
            alignItems: "center",
            padding: "0 28px",
            borderBottom: `1px solid ${D.border}`,
            background: D.card,
            position: "sticky",
            top: 0,
            zIndex: 5,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>Settings</span>
        </header>

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "28px",
            background: D.bg,
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
            {clubLoading ? (
              <div style={{ color: D.faint, fontSize: 13 }}>Loading…</div>
            ) : (
              <>
                {/* Club name card */}
                <div style={cardStyle}>
                  <div style={cardHeadStyle}>Club</div>
                  <div style={{ padding: "14px 20px" }}>
                    <div style={{ fontWeight: 600, fontSize: 18, color: D.text }}>{club?.name ?? "—"}</div>
                  </div>
                </div>

                {/* Sync schedule card */}
                <div style={cardStyle}>
                  <div style={cardHeadStyle}>Sync Schedule</div>
                  {!hasScheduleColumns ? (
                    <div style={{ padding: "16px 20px" }}>
                      <div
                        style={{
                          fontSize: 12,
                          color: D.orange,
                          background: D.orangeBg,
                          border: "1px solid rgba(212,129,58,0.2)",
                          borderRadius: 5,
                          padding: "10px 14px",
                          lineHeight: 1.6,
                        }}
                      >
                        Schedule columns not yet added. Run in Supabase SQL editor:
                        <pre style={{ fontFamily: "var(--font-mono)", fontSize: 11, marginTop: 8, whiteSpace: "pre-wrap", color: D.muted }}>
                          {`ALTER TABLE clubs\n  ADD COLUMN IF NOT EXISTS scheduled_sync_time time,\n  ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'America/New_York';`}
                        </pre>
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
                      <div>
                        <label style={labelStyle}>Nightly sync time (24h)</label>
                        <input type="time" value={syncTime} onChange={(e) => setSyncTime(e.target.value)} style={inputStyle} />
                      </div>
                      <div>
                        <label style={labelStyle}>Timezone</label>
                        <select value={timezone} onChange={(e) => setTimezone(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
                          {COMMON_TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                        </select>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
                        <span style={{ fontSize: 11, color: D.faint, fontFamily: "var(--font-mono)" }}>
                          {club?.scheduled_sync_time
                            ? `Currently: ${club.scheduled_sync_time} ${club.timezone ?? "UTC"}`
                            : "Not set — defaults to 02:00"}
                        </span>
                        <button
                          onClick={saveSchedule}
                          disabled={saving}
                          style={{
                            padding: "6px 14px",
                            borderRadius: 5,
                            background: D.accent,
                            color: "#fff",
                            border: "none",
                            fontSize: 12,
                            fontWeight: 500,
                            fontFamily: "var(--font-sans)",
                            cursor: saving ? "not-allowed" : "pointer",
                            opacity: saving ? 0.6 : 1,
                          }}
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Agent config card */}
                <div style={cardStyle}>
                  <div style={cardHeadStyle}>Agent Configuration</div>
                  <div style={{ padding: "4px 0" }}>
                    {configEntries.length === 0 ? (
                      <div style={{ padding: "20px", fontSize: 13, color: D.faint }}>No configuration set</div>
                    ) : configEntries.map(([key, val]) => (
                      <div
                        key={key}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "10px 20px",
                          borderBottom: `1px solid ${D.border}`,
                        }}
                      >
                        <span style={{ fontSize: 13, color: D.muted }}>{KNOWN_LABELS[key] ?? toTitleCase(key)}</span>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            fontFamily: typeof val === "boolean" ? "var(--font-sans)" : "var(--font-mono)",
                            color: typeof val === "boolean"
                              ? (val ? D.green : D.redText)
                              : D.text,
                          }}
                        >
                          {formatValue(val)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div
                    style={{
                      padding: "14px 20px",
                      borderTop: `1px solid ${D.border}`,
                      background: D.inner,
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                    }}
                  >
                    <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1, color: D.muted }}>ℹ</span>
                    <span style={{ fontSize: 12, color: D.faint, lineHeight: 1.6 }}>
                      Sync and agent runs are scheduled nightly at your configured time. Manual triggers are available for testing but may affect PodPlay performance during business hours.
                    </span>
                  </div>
                </div>

                <SyncLogPanel />
              </>
            )}
          </div>

          {/* ── Message Templates ── */}
          <div style={cardStyle}>
            <div style={{ ...cardHeadStyle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>Message Templates</span>
              {!editorOpen && (
                <button
                  onClick={openNew}
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    padding: "3px 10px",
                    borderRadius: 4,
                    background: D.accent,
                    color: "#fff",
                    border: "none",
                    cursor: "pointer",
                    fontWeight: 500,
                    textTransform: "none",
                    letterSpacing: 0,
                  }}
                >
                  + New template
                </button>
              )}
            </div>

            <div style={{ display: "flex", minHeight: 340 }}>
              {/* LEFT — template list */}
              <div style={{ width: 260, minWidth: 260, borderRight: `1px solid ${D.border}`, overflowY: "auto", flexShrink: 0 }}>
                {templatesLoading ? (
                  <div style={{ padding: "20px 16px", fontSize: 13, color: D.faint }}>Loading…</div>
                ) : templates.length === 0 ? (
                  <div style={{ padding: "20px 16px", fontSize: 13, color: D.faint }}>No templates yet.</div>
                ) : (
                  templates.map((t) => {
                    const isSelected = editingId === t.id;
                    return (
                      <div
                        key={t.id}
                        onClick={() => t.is_builtin ? openViewBuiltin(t) : openEditCustom(t)}
                        style={{
                          padding: "11px 14px",
                          borderBottom: `1px solid ${D.border}`,
                          background: isSelected ? D.accentBg : "transparent",
                          borderLeft: isSelected ? `3px solid ${D.accent}` : "3px solid transparent",
                          cursor: "pointer",
                          transition: "background 0.1s",
                        }}
                        onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = D.inner; }}
                        onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                          <span style={{ fontWeight: 500, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: D.text }}>
                            {t.name}
                          </span>
                          <span
                            style={{
                              fontSize: 9,
                              fontFamily: "var(--font-mono)",
                              padding: "1px 5px",
                              borderRadius: 3,
                              flexShrink: 0,
                              marginLeft: 6,
                              background: t.is_builtin ? "rgba(96,165,250,0.10)" : D.accentBg,
                              color: t.is_builtin ? "#60a5fa" : D.accent,
                              border: `1px solid ${t.is_builtin ? "rgba(96,165,250,0.2)" : "rgba(232,168,56,0.2)"}`,
                            }}
                          >
                            {t.is_builtin ? "built-in" : "custom"}
                          </span>
                        </div>
                        {t.use_case_tags.length > 0 && (
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {t.use_case_tags.map((tag) => (
                              <span
                                key={tag}
                                style={{
                                  fontSize: 10,
                                  fontFamily: "var(--font-mono)",
                                  padding: "1px 5px",
                                  borderRadius: 3,
                                  background: D.inner,
                                  color: D.faint,
                                  border: `1px solid ${D.border}`,
                                }}
                              >
                                {TAG_LABELS[tag] ?? tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* RIGHT — editor */}
              <div style={{ flex: 1, minWidth: 0, padding: "20px 24px", overflowY: "auto" }}>
                {!editorOpen ? (
                  <div
                    style={{
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: D.faint,
                      fontSize: 13,
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <span>Click a template to view it</span>
                    <span style={{ fontSize: 12 }}>or click + New template to create one</span>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    {readOnly && (
                      <div
                        style={{
                          fontSize: 12,
                          color: "#60a5fa",
                          background: "rgba(96,165,250,0.07)",
                          border: "1px solid rgba(96,165,250,0.2)",
                          borderRadius: 6,
                          padding: "9px 13px",
                          lineHeight: 1.5,
                        }}
                      >
                        Built-in templates cannot be edited. Create a custom template to make changes.
                      </div>
                    )}
                    <div>
                      <label style={labelStyle}>Template name</label>
                      <input
                        type="text"
                        value={tName}
                        onChange={(e) => !readOnly && setTName(e.target.value)}
                        placeholder="e.g. Win-back campaign"
                        disabled={readOnly}
                        style={{ ...inputStyle, opacity: readOnly ? 0.65 : 1, cursor: readOnly ? "default" : "text" }}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Message body</label>
                      <textarea
                        ref={bodyRef}
                        value={tBody}
                        onChange={(e) => !readOnly && setTBody(e.target.value)}
                        rows={5}
                        placeholder="Write your message…"
                        disabled={readOnly}
                        style={{
                          ...inputStyle,
                          resize: "vertical",
                          lineHeight: 1.65,
                          minHeight: 120,
                          opacity: readOnly ? 0.65 : 1,
                          cursor: readOnly ? "default" : "text",
                        }}
                      />
                      {!readOnly && (
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 }}>
                          <span style={{ fontSize: 10, color: D.faint, fontFamily: "var(--font-mono)", alignSelf: "center", marginRight: 2 }}>Insert:</span>
                          {TEMPLATE_VARS.map((v) => (
                            <button
                              key={v}
                              onClick={() => insertVar(v)}
                              style={{
                                fontSize: 10,
                                fontFamily: "var(--font-mono)",
                                padding: "2px 7px",
                                borderRadius: 3,
                                border: `1px solid ${D.border}`,
                                background: D.inner,
                                color: D.muted,
                                cursor: "pointer",
                              }}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: D.faint, fontFamily: "var(--font-mono)", marginTop: 6 }}>
                        {smsCount(tBody)}
                      </div>
                    </div>
                    <div>
                      <label style={labelStyle}>Best used for</label>
                      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                        {USE_CASE_OPTIONS.map((tag) => {
                          const on = tTags.includes(tag);
                          return (
                            <button
                              key={tag}
                              onClick={() => toggleTag(tag)}
                              disabled={readOnly}
                              style={{
                                fontSize: 12,
                                fontFamily: "var(--font-mono)",
                                padding: "4px 10px",
                                borderRadius: 4,
                                border: `1px solid ${on ? D.accent : D.border}`,
                                background: on ? D.accentBg : D.inner,
                                color: on ? D.accent : D.muted,
                                cursor: readOnly ? "default" : "pointer",
                                opacity: readOnly ? 0.7 : 1,
                              }}
                            >
                              {TAG_LABELS[tag] ?? tag}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <label style={labelStyle}>Live preview</label>
                      <div
                        style={{
                          background: D.inner,
                          border: `1px solid ${D.border}`,
                          borderRadius: 6,
                          padding: "11px 13px",
                          fontSize: 13,
                          lineHeight: 1.7,
                          color: D.text,
                          minHeight: 60,
                        }}
                      >
                        {tBody.trim()
                          ? previewBody(tBody)
                          : <span style={{ color: D.faint, fontStyle: "italic" }}>No message yet</span>}
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 2 }}>
                      <button
                        onClick={discardEditor}
                        style={{
                          padding: "7px 16px",
                          borderRadius: 5,
                          fontSize: 13,
                          border: `1px solid ${D.border}`,
                          background: D.inner,
                          color: D.muted,
                          cursor: "pointer",
                        }}
                      >
                        {readOnly ? "Close" : "Discard"}
                      </button>
                      {!readOnly && (
                        <button
                          onClick={saveTemplate}
                          disabled={tSaving || !tName.trim() || !tBody.trim()}
                          style={{
                            padding: "7px 18px",
                            borderRadius: 5,
                            fontSize: 13,
                            fontWeight: 500,
                            background: !tSaving && tName.trim() && tBody.trim() ? D.accent : D.border,
                            color: !tSaving && tName.trim() && tBody.trim() ? "#fff" : D.faint,
                            border: "none",
                            cursor: !tSaving && tName.trim() && tBody.trim() ? "pointer" : "not-allowed",
                          }}
                        >
                          {tSaving ? "Saving…" : "Save template"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
