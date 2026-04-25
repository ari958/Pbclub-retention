import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { useToast } from "@/components/Toast";
import { toTitleCase } from "@/lib/helpers";
import type { MessageTemplate } from "@/lib/types";

interface ClubRow {
  id: string;
  name: string;
  agent_config: Record<string, unknown> | null;
  scheduled_sync_time: string | null;
  timezone: string | null;
}

const KNOWN_LABELS: Record<string, string> = {
  max_messages_per_day: "Max messages per day",
  max_messages_per_week: "Max messages per week",
  tone: "Agent tone",
  language: "Language",
  signup_link_base: "Signup link base URL",
  follow_up_days: "Follow-up window (days)",
  enabled: "Agent enabled",
  dormant_threshold_days: "Dormant Threshold Days",
  lapsing_threshold_days: "Lapsing Threshold Days",
  max_messages_per_thread: "Max Messages Per Thread",
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

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  return String(val);
}

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg-surface-2)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--text-tertiary)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
  display: "block",
};

const cardStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "hidden",
};

const cardHeadStyle: React.CSSProperties = {
  padding: "14px 20px 12px",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 500,
  color: "var(--text-tertiary)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

// ─── Preview helper ────────────────────────────────────────────────────────────

const PREVIEW_VALS: Record<string, string> = {
  first_name: "Alex",
  skill_level: "3.0",
  club_name: "PB Club",
  last_visit: "Apr 10",
  event_date: "May 12",
  booking_link: "pbclub.com/book",
};

function previewBody(body: string): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, v) => PREVIEW_VALS[v] ?? `{{${v}}}`);
}

function smsCount(body: string): string {
  const len = body.length;
  if (len === 0) return "0 chars";
  const msgs = Math.ceil(len / 160);
  return `${len} chars · ${msgs} SMS`;
}

// ─── Template list item ────────────────────────────────────────────────────────

function TemplatePill({ tag }: { tag: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        padding: "2px 6px",
        borderRadius: 3,
        background: "var(--bg-surface-2)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border)",
      }}
    >
      {tag}
    </span>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function Settings() {
  const toast = useToast();

  // Club settings state
  const [club, setClub] = useState<ClubRow | null>(null);
  const [clubLoading, setClubLoading] = useState(true);
  const [syncTime, setSyncTime] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [saving, setSaving] = useState(false);
  const [hasScheduleColumns, setHasScheduleColumns] = useState(true);

  // Templates state
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [tName, setTName] = useState("");
  const [tBody, setTBody] = useState("");
  const [tTags, setTTags] = useState<string[]>([]);
  const [tSaving, setTSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // ── Club data load
  useEffect(() => {
    supabase
      .from("clubs")
      .select("id, name, agent_config, scheduled_sync_time, timezone")
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error?.message?.includes("scheduled_sync_time") || error?.code === "42703") {
          setHasScheduleColumns(false);
          supabase
            .from("clubs")
            .select("id, name, agent_config")
            .limit(1)
            .maybeSingle()
            .then(({ data: fallback }) => {
              if (fallback) setClub(fallback as ClubRow);
              setClubLoading(false);
            });
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

  // ── Templates load
  const fetchTemplates = useCallback(async () => {
    const { data } = await supabase
      .from("message_templates")
      .select("*")
      .order("created_at");
    if (data) setTemplates(data as MessageTemplate[]);
    setTemplatesLoading(false);
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const saveSchedule = async () => {
    if (!club) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("clubs")
        .update({ scheduled_sync_time: syncTime, timezone })
        .eq("id", club.id);
      if (error) toast.error(error.message);
      else {
        setClub((prev) => prev ? { ...prev, scheduled_sync_time: syncTime, timezone } : prev);
        toast.success("Schedule saved");
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Template editor helpers
  const openNew = () => {
    setEditingTemplate(null);
    setIsNew(true);
    setTName("");
    setTBody("");
    setTTags([]);
  };

  const openEdit = (t: MessageTemplate) => {
    setEditingTemplate(t);
    setIsNew(false);
    setTName(t.name);
    setTBody(t.body);
    setTTags([...t.use_case_tags]);
  };

  const discardEditor = () => {
    setEditingTemplate(null);
    setIsNew(false);
  };

  const insertVar = (v: string) => {
    const el = bodyRef.current;
    if (!el) { setTBody((b) => b + v); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + v + el.value.slice(end);
    setTBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + v.length, start + v.length);
    });
  };

  const toggleTag = (tag: string) => {
    setTTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const saveTemplate = async () => {
    if (!tName.trim() || !tBody.trim()) {
      toast.error("Name and body are required");
      return;
    }
    setTSaving(true);
    try {
      if (isNew) {
        const { error } = await supabase.from("message_templates").insert({
          name: tName.trim(),
          body: tBody.trim(),
          use_case_tags: tTags,
          is_builtin: false,
        });
        if (error) throw error;
        toast.success("Template saved");
      } else if (editingTemplate) {
        const { error } = await supabase
          .from("message_templates")
          .update({ name: tName.trim(), body: tBody.trim(), use_case_tags: tTags })
          .eq("id", editingTemplate.id);
        if (error) throw error;
        toast.success("Template updated");
      }
      discardEditor();
      await fetchTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setTSaving(false);
    }
  };

  const configEntries: [string, unknown][] = club?.agent_config
    ? Object.entries(club.agent_config)
    : [];

  const editorOpen = isNew || editingTemplate !== null;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <Sidebar clubName={club?.name ?? ""} />
      <div style={{ marginLeft: 220, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <header
          style={{
            height: 52,
            minHeight: 52,
            display: "flex",
            alignItems: "center",
            padding: "0 28px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-surface)",
            position: "sticky",
            top: 0,
            zIndex: 5,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>Settings</span>
        </header>

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "28px",
            background: "var(--bg-surface-2)",
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {/* ── Existing settings (narrow column) */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
            {clubLoading ? (
              <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>Loading…</div>
            ) : (
              <>
                {/* Club card */}
                <div style={cardStyle}>
                  <div style={cardHeadStyle}>Club</div>
                  <div style={{ padding: "14px 20px" }}>
                    <div style={{ fontWeight: 600, fontSize: 18 }}>{club?.name ?? "—"}</div>
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
                          color: "var(--state-lapsing)",
                          background: "rgba(212,129,58,0.08)",
                          border: "1px solid rgba(212,129,58,0.2)",
                          borderRadius: 5,
                          padding: "10px 14px",
                          lineHeight: 1.6,
                        }}
                      >
                        Schedule columns not yet added. Run in Supabase SQL editor:
                        <pre style={{ fontFamily: "var(--font-mono)", fontSize: 11, marginTop: 8, whiteSpace: "pre-wrap" }}>
{`ALTER TABLE clubs
  ADD COLUMN IF NOT EXISTS scheduled_sync_time time,
  ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'America/New_York';`}
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
                        <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
                          {club?.scheduled_sync_time
                            ? `Currently: ${club.scheduled_sync_time} ${club.timezone ?? "UTC"}`
                            : "Not set — defaults to 02:00"}
                        </span>
                        <button
                          onClick={saveSchedule}
                          disabled={saving}
                          style={{ padding: "6px 14px", borderRadius: 5, background: "var(--accent)", color: "#fff", border: "none", fontSize: 12, fontWeight: 500, fontFamily: "var(--font-sans)", cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1 }}
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
                      <div style={{ padding: "20px", fontSize: 13, color: "var(--text-tertiary)" }}>No configuration set</div>
                    ) : (
                      configEntries.map(([key, val]) => (
                        <div
                          key={key}
                          style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", borderBottom: "1px solid var(--border)" }}
                        >
                          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{KNOWN_LABELS[key] ?? toTitleCase(key)}</span>
                          <span style={{ fontSize: 13, fontWeight: 500, fontFamily: typeof val === "boolean" ? "var(--font-sans)" : "var(--font-mono)", color: typeof val === "boolean" ? (val ? "var(--state-active)" : "var(--state-dormant)") : "var(--text-primary)" }}>
                            {formatValue(val)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <div style={{ padding: "14px 20px", borderTop: "1px solid var(--border)", background: "var(--bg-surface-2)", display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>ℹ</span>
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
                      Sync and agent runs are scheduled nightly at your configured time. Manual triggers are available for testing but may affect PodPlay performance during business hours.
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── Templates section (full width) */}
          <div style={cardStyle}>
            <div
              style={{
                ...cardHeadStyle,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>Message Templates</span>
              {!editorOpen && (
                <button
                  onClick={openNew}
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    padding: "3px 10px",
                    borderRadius: 4,
                    background: "var(--accent)",
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

            <div style={{ display: "flex", minHeight: 320 }}>
              {/* LEFT PANEL — list */}
              <div
                style={{
                  width: 280,
                  minWidth: 280,
                  borderRight: "1px solid var(--border)",
                  overflowY: "auto",
                }}
              >
                {templatesLoading ? (
                  <div style={{ padding: "20px 16px", fontSize: 13, color: "var(--text-tertiary)" }}>Loading…</div>
                ) : templates.length === 0 ? (
                  <div style={{ padding: "20px 16px", fontSize: 13, color: "var(--text-tertiary)" }}>
                    No templates yet. Click "+ New template" to create one.
                  </div>
                ) : (
                  templates.map((t) => {
                    const isSelected = editingTemplate?.id === t.id;
                    return (
                      <div
                        key={t.id}
                        style={{
                          padding: "12px 16px",
                          borderBottom: "1px solid var(--border)",
                          background: isSelected ? "rgba(232,168,56,0.05)" : "transparent",
                          borderLeft: isSelected ? "3px solid var(--accent)" : "3px solid transparent",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontWeight: 500, fontSize: 13 }}>{t.name}</span>
                            <span
                              style={{
                                fontSize: 9,
                                fontFamily: "var(--font-mono)",
                                padding: "1px 5px",
                                borderRadius: 3,
                                background: t.is_builtin ? "rgba(59,130,246,0.10)" : "var(--accent-light)",
                                color: t.is_builtin ? "#3b82f6" : "var(--accent)",
                                border: `1px solid ${t.is_builtin ? "rgba(59,130,246,0.2)" : "rgba(232,168,56,0.2)"}`,
                              }}
                            >
                              {t.is_builtin ? "built-in" : "custom"}
                            </span>
                          </div>
                          {!t.is_builtin && (
                            <button
                              onClick={() => openEdit(t)}
                              style={{ fontSize: 11, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
                            >
                              Edit
                            </button>
                          )}
                          {t.is_builtin && (
                            <span
                              title="Built-in templates cannot be edited"
                              style={{ fontSize: 11, color: "var(--text-tertiary)", cursor: "default", padding: "2px 6px" }}
                            >
                              —
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {t.use_case_tags.map((tag) => <TemplatePill key={tag} tag={tag} />)}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* RIGHT PANEL — editor */}
              <div style={{ flex: 1, minWidth: 0, padding: "20px 24px" }}>
                {!editorOpen ? (
                  <div
                    style={{
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--text-tertiary)",
                      fontSize: 13,
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <span>Select a custom template to edit</span>
                    <span style={{ fontSize: 12 }}>or click + New template to create one</span>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {/* Name */}
                    <div>
                      <label style={labelStyle}>Template name</label>
                      <input
                        type="text"
                        value={tName}
                        onChange={(e) => setTName(e.target.value)}
                        placeholder="e.g. Win-back campaign"
                        style={inputStyle}
                      />
                    </div>

                    {/* Body + preview side by side */}
                    <div style={{ display: "flex", gap: 16 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <label style={labelStyle}>Message body</label>
                        <textarea
                          ref={bodyRef}
                          value={tBody}
                          onChange={(e) => setTBody(e.target.value)}
                          rows={5}
                          placeholder="Write your message…"
                          style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
                        />
                        {/* Variable chips */}
                        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 7 }}>
                          <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", alignSelf: "center" }}>Insert:</span>
                          {TEMPLATE_VARS.map((v) => (
                            <button
                              key={v}
                              onClick={() => insertVar(v)}
                              style={{
                                fontSize: 10,
                                fontFamily: "var(--font-mono)",
                                padding: "2px 7px",
                                borderRadius: 3,
                                border: "1px solid var(--border)",
                                background: "var(--bg-surface-2)",
                                color: "var(--text-secondary)",
                                cursor: "pointer",
                              }}
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", marginTop: 5 }}>
                          {smsCount(tBody)}
                        </div>
                      </div>

                      {/* Live preview */}
                      <div style={{ width: 220, flexShrink: 0 }}>
                        <label style={labelStyle}>Preview</label>
                        <div
                          style={{
                            background: "var(--bg-surface-2)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "10px 12px",
                            fontSize: 12,
                            lineHeight: 1.7,
                            color: "var(--text-primary)",
                            minHeight: 80,
                          }}
                        >
                          {tBody.trim() ? previewBody(tBody) : <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>No message yet</span>}
                        </div>
                      </div>
                    </div>

                    {/* Use case tags */}
                    <div>
                      <label style={labelStyle}>Use case tags</label>
                      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                        {USE_CASE_OPTIONS.map((tag) => {
                          const on = tTags.includes(tag);
                          return (
                            <button
                              key={tag}
                              onClick={() => toggleTag(tag)}
                              style={{
                                fontSize: 12,
                                fontFamily: "var(--font-mono)",
                                padding: "4px 10px",
                                borderRadius: 4,
                                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                                background: on ? "rgba(232,168,56,0.10)" : "var(--bg-surface-2)",
                                color: on ? "var(--accent)" : "var(--text-secondary)",
                                cursor: "pointer",
                                transition: "all 0.12s",
                              }}
                            >
                              {tag}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Footer buttons */}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
                      <button
                        onClick={discardEditor}
                        style={{ padding: "7px 16px", borderRadius: 5, fontSize: 13, border: "1px solid var(--border)", background: "var(--bg-surface-2)", color: "var(--text-secondary)", cursor: "pointer" }}
                      >
                        Discard
                      </button>
                      <button
                        onClick={saveTemplate}
                        disabled={tSaving || !tName.trim() || !tBody.trim()}
                        style={{
                          padding: "7px 18px",
                          borderRadius: 5,
                          fontSize: 13,
                          fontWeight: 500,
                          background: !tSaving && tName.trim() && tBody.trim() ? "var(--accent)" : "var(--border)",
                          color: !tSaving && tName.trim() && tBody.trim() ? "#fff" : "var(--text-tertiary)",
                          border: "none",
                          cursor: !tSaving && tName.trim() && tBody.trim() ? "pointer" : "not-allowed",
                        }}
                      >
                        {tSaving ? "Saving…" : "Save template"}
                      </button>
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
