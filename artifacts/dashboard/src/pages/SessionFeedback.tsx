import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { useToast } from "@/components/Toast";
import { useClub, clubApiUrl } from "@/lib/ClubContext";

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
} as const;

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 500,
  color: "#6e7681",
  marginBottom: 5,
  fontFamily: "var(--font-mono)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 5,
  border: `1px solid ${D.border}`,
  background: D.inner,
  color: D.text,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const LEVELS = [
  "Beginner",
  "Advanced Beginner",
  "Low Intermediate",
  "Intermediate",
  "Advanced Intermediate",
  "Advanced",
];

interface FeedbackRow {
  event_id: string;
  level: string | null;
  self_fit: number | null;
  others_fit: number | null;
  responded_at: string | null;
}

interface SessionSummary {
  event_id: string;
  level: string;
  totalResponses: number;
  selfFitYes: number;
  othersFitYes: number;
  firstResponse: string;
}

interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  use_case_tags: string[];
  is_builtin: boolean;
}

function safeDate(isoStr: string): string {
  const dt = new Date(isoStr);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 10px",
        borderRadius: 16,
        fontSize: 11,
        fontWeight: 500,
        cursor: "pointer",
        border: `1px solid ${active ? D.accent : D.border}`,
        background: active ? D.accentBg : D.inner,
        color: active ? D.accent : D.muted,
        transition: "all 0.1s",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

export default function SessionFeedback() {
  const toast = useToast();
  const club = useClub();

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState("");

  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);
  const [tName, setTName] = useState("");
  const [tBody, setTBody] = useState("");
  const [tSaving, setTSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);


  useEffect(() => {
    const fetchSessions = async () => {
      setSessionsLoading(true);
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("session_feedback")
        .select("event_id, level, self_fit, others_fit, responded_at")
        .gte("responded_at", since)
        .not("responded_at", "is", null);

      if (data) {
        const map = new Map<string, { level: string; rows: FeedbackRow[] }>();
        for (const row of data as FeedbackRow[]) {
          if (!map.has(row.event_id)) {
            map.set(row.event_id, { level: row.level ?? "Unknown", rows: [] });
          }
          map.get(row.event_id)!.rows.push(row);
        }

        const summaries: SessionSummary[] = [];
        for (const [event_id, { level, rows }] of map) {
          const valid = rows.filter((r) => r.self_fit !== null && r.others_fit !== null);
          if (valid.length === 0) continue;
          summaries.push({
            event_id,
            level,
            totalResponses: valid.length,
            selfFitYes: valid.filter((r) => r.self_fit === 1).length,
            othersFitYes: valid.filter((r) => r.others_fit === 1).length,
            firstResponse: valid.map((r) => r.responded_at!).sort()[0],
          });
        }

        summaries.sort((a, b) => new Date(b.firstResponse).getTime() - new Date(a.firstResponse).getTime());
        setSessions(summaries);
      }
      setSessionsLoading(false);
    };
    fetchSessions();
  }, []);

  const fetchTemplate = useCallback(async () => {
    setTemplateLoading(true);
    try {
      const res = await fetch(clubApiUrl(club.slug, "/api/templates"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const all: MessageTemplate[] = await res.json();
      const found = all.find((t) => t.use_case_tags.includes("session_feedback")) ?? null;
      setTemplate(found);
      if (found) { setTName(found.name); setTBody(found.body); }
    } catch { toast.error("Failed to load feedback template"); }
    finally { setTemplateLoading(false); }
  }, [club.slug, toast]);

  useEffect(() => { fetchTemplate(); }, [fetchTemplate]);

  const saveTemplate = async () => {
    if (!template) return;
    if (!tName.trim() || !tBody.trim()) { toast.error("Name and body are required"); return; }
    setTSaving(true);
    try {
      const res = await fetch(clubApiUrl(club.slug, `/api/templates/${template.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tName.trim(), body: tBody.trim(), use_case_tags: template.use_case_tags }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      toast.success("Template saved");
      await fetchTemplate();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Save failed"); }
    finally { setTSaving(false); }
  };

  const insertVar = (v: string) => {
    const el = bodyRef.current;
    if (!el) { setTBody((b) => b + v); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setTBody(el.value.slice(0, start) + v + el.value.slice(end));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + v.length, start + v.length); });
  };

  const filteredSessions = levelFilter
    ? sessions.filter((s) => s.level.toLowerCase() === levelFilter.toLowerCase())
    : sessions;

  const readOnly = template?.is_builtin ?? false;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: D.bg }}>
      <Sidebar />
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
          <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>Session Ratings</span>
        </header>

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "24px 28px",
            background: D.bg,
            display: "flex",
            gap: 20,
            alignItems: "flex-start",
          }}
        >
          {/* ── Section A: Session Health (60%) ── */}
          <div
            style={{
              flex: "0 0 60%",
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "14px 20px",
                borderBottom: `1px solid ${D.border}`,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: D.text }}>Session Health</span>
                {!sessionsLoading && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      padding: "2px 7px",
                      borderRadius: 3,
                      background: D.inner,
                      color: D.faint,
                      border: `1px solid ${D.border}`,
                    }}
                  >
                    {sessions.length} sessions · last 30d
                  </span>
                )}
              </div>
              {/* Level filter chips */}
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                <Chip label="All Levels" active={!levelFilter} onClick={() => setLevelFilter("")} />
                {LEVELS.map((l) => (
                  <Chip key={l} label={l} active={levelFilter === l} onClick={() => setLevelFilter(levelFilter === l ? "" : l)} />
                ))}
              </div>
            </div>

            {sessionsLoading ? (
              <div style={{ padding: "32px 20px", color: D.faint, fontSize: 13 }}>Loading…</div>
            ) : filteredSessions.length === 0 ? (
              <div style={{ padding: "32px 20px", color: D.faint, fontSize: 13 }}>
                {sessions.length === 0
                  ? "No session feedback in the last 30 days."
                  : "No sessions match this filter."}
              </div>
            ) : (
              filteredSessions.map((s) => {
                const selfPct = Math.round((s.selfFitYes / s.totalResponses) * 100);
                const othersPct = Math.round((s.othersFitYes / s.totalResponses) * 100);
                const needsReview = selfPct < 60 || othersPct < 60;
                return (
                  <div
                    key={s.event_id}
                    style={{
                      padding: "14px 20px",
                      borderBottom: `1px solid ${D.border}`,
                      display: "flex",
                      flexDirection: "column",
                      gap: 7,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 10,
                            padding: "2px 7px",
                            borderRadius: 3,
                            background: D.accentBg,
                            color: D.accent,
                            border: "1px solid rgba(232,168,56,0.25)",
                            fontWeight: 500,
                          }}
                        >
                          {s.level}
                        </span>
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: D.faint }}>
                          {safeDate(s.firstResponse)}
                        </span>
                        {needsReview && (
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: "var(--font-mono)",
                              padding: "1px 6px",
                              borderRadius: 3,
                              background: D.orangeBg,
                              color: D.orange,
                              border: "1px solid rgba(212,129,58,0.25)",
                              fontWeight: 500,
                            }}
                          >
                            ⚠ Review needed
                          </span>
                        )}
                      </div>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: D.faint, whiteSpace: "nowrap", flexShrink: 0 }}>
                        {s.totalResponses} {s.totalResponses === 1 ? "response" : "responses"}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 24 }}>
                      <span style={{ fontSize: 12, color: D.muted }}>
                        <span style={{ fontWeight: 600, color: selfPct < 60 ? D.orange : D.text }}>
                          {selfPct}%
                        </span>{" "}
                        felt they belonged
                      </span>
                      <span style={{ fontSize: 12, color: D.muted }}>
                        <span style={{ fontWeight: 600, color: othersPct < 60 ? D.orange : D.text }}>
                          {othersPct}%
                        </span>{" "}
                        said others belonged
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* ── Section B: Template Editor (40%) ── */}
          <div
            style={{
              flex: "1 1 0",
              minWidth: 0,
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "14px 20px", borderBottom: `1px solid ${D.border}` }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: D.text }}>Rating Message Template</span>
            </div>

            <div style={{ padding: "20px" }}>
              {templateLoading ? (
                <div style={{ color: D.faint, fontSize: 13 }}>Loading…</div>
              ) : !template ? (
                <div style={{ color: D.faint, fontSize: 13 }}>
                  No feedback template found. Restart the server to auto-seed one.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
                      Built-in — cannot be edited
                    </div>
                  )}

                  <div>
                    <label style={labelStyle}>Template name</label>
                    <input
                      type="text"
                      value={tName}
                      onChange={(e) => !readOnly && setTName(e.target.value)}
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
                      rows={8}
                      disabled={readOnly}
                      style={{
                        ...inputStyle,
                        resize: "vertical",
                        lineHeight: 1.65,
                        minHeight: 160,
                        opacity: readOnly ? 0.65 : 1,
                        cursor: readOnly ? "default" : "text",
                      }}
                    />
                    {!readOnly && (
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                        <span style={{ fontSize: 10, color: D.faint, fontFamily: "var(--font-mono)", alignSelf: "center", marginRight: 2 }}>
                          Insert:
                        </span>
                        {["{{first_name}}", "{{level}}"].map((v) => (
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
                  </div>

                  {!readOnly && (
                    <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
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
                          fontFamily: "var(--font-sans)",
                        }}
                      >
                        {tSaving ? "Saving…" : "Save template"}
                      </button>
                    </div>
                  )}
                  <p style={{ fontSize: 11, color: D.muted, fontStyle: "italic", marginTop: 8, marginBottom: 0, textAlign: "right" }}>
                    This message is sent automatically 30 minutes after each leveled session ends.
                  </p>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
