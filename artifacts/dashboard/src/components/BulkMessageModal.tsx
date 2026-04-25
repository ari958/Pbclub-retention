import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/components/Toast";
import { relativeTime } from "@/lib/helpers";
import type { Player, MessageTemplate } from "@/lib/types";

interface BulkMessageModalProps {
  recipients: Player[];
  filterSummary: string;
  onClose: () => void;
}

interface UpcomingEvent {
  id: string;
  name: string;
  subtype: string;
  startTime: string;
  admissionRating: Record<string, unknown> | null;
  admissionRate: Record<string, unknown> | null;
  signupUrl: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_VARS = [
  "{{first_name}}", "{{skill_level}}", "{{club_name}}",
  "{{last_visit}}", "{{event_date}}", "{{booking_link}}",
];

const OPERATOR_VARS = new Set(["event_date", "booking_link", "event_link", "next_level"]);
const EVENT_VARS    = new Set(["event_date", "event_link", "booking_link"]);

const OPERATOR_VAR_CONFIG: Record<string, { label: string; placeholder: string }> = {
  event_date:   { label: "Event date",       placeholder: "e.g. May 10" },
  booking_link: { label: "Booking link",     placeholder: "e.g. pbclub.com/book" },
  event_link:   { label: "Sign-up link",     placeholder: "e.g. pbclub.com/tournament" },
  next_level:   { label: "Next skill level", placeholder: "e.g. 3.5" },
};

const SUBTYPE_LABELS: Record<string, string> = {
  TOURNAMENT:   "Tournament",
  ADULT_CLASS:  "Class",
  OPEN_PLAY:    "Open Play",
  LEAGUE_NIGHT: "League",
  CLASS:        "Class",
  EVENT:        "Event",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getOperatorVarsNeeded(body: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of body.match(/\{\{(\w+)\}\}/g) ?? []) {
    const v = m.slice(2, -2);
    if (OPERATOR_VARS.has(v) && !seen.has(v)) { seen.add(v); result.push(v); }
  }
  return result;
}

function templateNeedsEventPicker(body: string): boolean {
  return (body.match(/\{\{(\w+)\}\}/g) ?? []).some((m) => EVENT_VARS.has(m.slice(2, -2)));
}

function applyOperatorVals(body: string, vals: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, v) =>
    OPERATOR_VARS.has(v) && vals[v]?.trim() ? vals[v].trim() : match
  );
}

function resolvePlayerVar(varName: string, player: Player | undefined): string | null {
  if (!player) return null;
  if (varName === "first_name") return player.name.split(" ")[0];
  if (varName === "skill_level") return player.skill_level ?? "your level";
  if (varName === "club_name") return "PB Club";
  if (varName === "last_visit") return relativeTime(player.last_visit_date);
  return null;
}

function formatEventOption(event: UpcomingEvent): string {
  const typeLabel = SUBTYPE_LABELS[event.subtype] ??
    event.subtype.charAt(0) + event.subtype.slice(1).toLowerCase().replace(/_/g, " ");

  const d = new Date(event.startTime);
  const datePart = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const timePart = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const dateStr = `${datePart}, ${timePart}`;

  let skillRange = "";
  try {
    const ar = event.admissionRating;
    const rate = event.admissionRate;
    let min: number | undefined, max: number | undefined;

    const tryNum = (v: unknown) => typeof v === "number" ? v : undefined;

    if (ar) {
      min = tryNum(ar.min) ?? tryNum(ar.minRating);
      max = tryNum(ar.max) ?? tryNum(ar.maxRating);
    }
    if ((min === undefined || max === undefined) && rate) {
      min = tryNum(rate.min);
      max = tryNum(rate.max);
    }

    if (min !== undefined && max !== undefined) {
      skillRange = ` · ${min}–${max}`;
    }
  } catch {
    // silently skip
  }

  return `${typeLabel} · ${event.name} · ${dateStr}${skillRange}`;
}

function formatDisplayDate(isoString: string): string {
  const d = new Date(isoString);
  const month = d.toLocaleDateString("en-US", { month: "short" });
  const day = d.getDate();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${month} ${day} at ${time}`;
}

// ─── PreviewText ──────────────────────────────────────────────────────────────

interface PreviewTextProps {
  body: string;
  player: Player | undefined;
  operatorVals: Record<string, string>;
}

function PreviewText({ body, player, operatorVals }: PreviewTextProps) {
  if (!body.trim()) {
    return <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>No message yet</span>;
  }
  return (
    <>
      {body.split(/(\{\{\w+\}\})/g).map((part, i) => {
        const m = part.match(/^\{\{(\w+)\}\}$/);
        if (!m) return <span key={i}>{part}</span>;
        const v = m[1];

        if (OPERATOR_VARS.has(v)) {
          const filled = operatorVals[v]?.trim();
          return filled ? (
            <span key={i} style={{ background: "rgba(46,160,67,0.10)", color: "var(--state-active)", borderRadius: 3, padding: "0 3px", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {filled}
            </span>
          ) : (
            <span key={i} style={{ background: "rgba(232,168,56,0.18)", color: "var(--accent)", borderRadius: 3, padding: "0 3px", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {part}
            </span>
          );
        }

        const resolved = resolvePlayerVar(v, player);
        return (
          <span key={i} style={{ background: "rgba(46,160,67,0.10)", color: "var(--state-active)", borderRadius: 3, padding: "0 3px", fontFamily: "var(--font-mono)", fontSize: 12 }}>
            {resolved ?? part}
          </span>
        );
      })}
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TagPill({ tag }: { tag: string }) {
  return (
    <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", padding: "2px 6px", borderRadius: 3, background: "var(--bg-surface-2)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
      {tag}
    </span>
  );
}

function VarChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ fontSize: 11, fontFamily: "var(--font-mono)", padding: "3px 8px", borderRadius: 4, background: "var(--bg-surface-2)", color: "var(--text-secondary)", border: "1px solid var(--border)", cursor: "pointer", transition: "border-color 0.1s" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--accent)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--border)")}
    >
      {label}
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function BulkMessageModal({ recipients, filterSummary, onClose }: BulkMessageModalProps) {
  const toast = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [mode, setMode]                         = useState<"template" | "custom">("template");
  const [templates, setTemplates]               = useState<MessageTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<MessageTemplate | null>(null);
  const [customBody, setCustomBody]             = useState("");
  const [operatorVals, setOperatorVals]         = useState<Record<string, string>>({});
  const [optInOnly, setOptInOnly]               = useState(true);
  const [sending, setSending]                   = useState(false);

  // Events state
  const [events, setEvents]           = useState<UpcomingEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const [manualLinkNeeded, setManualLinkNeeded] = useState(false);

  const previewPlayer = recipients[0];
  const rawBody = mode === "template" ? (selectedTemplate?.body ?? "") : customBody;
  const operatorVarsNeeded = getOperatorVarsNeeded(rawBody);
  const needsEventPicker = mode === "template" && !!selectedTemplate && templateNeedsEventPicker(rawBody);

  // Non-event operator vars (e.g. {{next_level}})
  const nonEventOperatorVars = operatorVarsNeeded.filter((v) => !EVENT_VARS.has(v));

  // Send-ready checks
  const allOperatorVarsFilled = operatorVarsNeeded.every((v) => operatorVals[v]?.trim());
  const eventPickerSatisfied = !needsEventPicker || (selectedEventId !== "");

  const resolvedBodyForApi = applyOperatorVals(rawBody, operatorVals);

  const eligibleRecipients = optInOnly
    ? recipients.filter((p) => p.sms_opt_in === true)
    : recipients;

  const canSend =
    rawBody.trim().length > 0 &&
    (mode === "template" ? selectedTemplate !== null : true) &&
    allOperatorVarsFilled &&
    eventPickerSatisfied &&
    eligibleRecipients.length > 0;

  const estimatedCost = (eligibleRecipients.length * 0.02).toFixed(2);

  // ── Load templates ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/templates")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setTemplates(data as MessageTemplate[]); })
      .catch(() => {
        supabase.from("message_templates").select("*").order("created_at")
          .then(({ data }) => { if (data) setTemplates(data as MessageTemplate[]); });
      })
      .finally(() => setTemplatesLoading(false));
  }, []);

  // ── Load events on mount ────────────────────────────────────────────────────
  useEffect(() => {
    setEventsLoading(true);
    fetch("/api/events/upcoming")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: UpcomingEvent[]) => { setEvents(data); setEventsError(null); })
      .catch(() => setEventsError("Couldn't load events — enter details manually."))
      .finally(() => setEventsLoading(false));
  }, []);

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Template selection ────────────────────────────────────────────────────
  const handleSelectTemplate = (t: MessageTemplate) => {
    setSelectedTemplate(t);
    setOperatorVals({});
    setSelectedEventId("");
    setManualLinkNeeded(false);
  };

  // ── Event selection ───────────────────────────────────────────────────────
  const handleEventChange = (eventId: string) => {
    setSelectedEventId(eventId);
    if (!eventId) {
      setOperatorVals((prev) => ({ ...prev, event_date: "", event_link: "", booking_link: "" }));
      setManualLinkNeeded(false);
      return;
    }
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return;
    const displayDate = formatDisplayDate(ev.startTime);
    const url = ev.signupUrl ?? "";
    setOperatorVals((prev) => ({
      ...prev,
      event_date: displayDate,
      event_link: url,
      booking_link: url,
    }));
    setManualLinkNeeded(!ev.signupUrl);
  };

  // ── Manual link input (when no signupUrl) ──────────────────────────────────
  const handleManualLink = (val: string) => {
    setOperatorVals((prev) => ({ ...prev, event_link: val, booking_link: val }));
  };

  // ── Custom message var insertion ──────────────────────────────────────────
  const insertVar = useCallback((v: string) => {
    const el = textareaRef.current;
    if (!el) { setCustomBody((b) => b + v); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + v + el.value.slice(end);
    setCustomBody(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + v.length, start + v.length); });
  }, []);

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    setSending(true);
    try {
      const res = await fetch("/api/messages/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          player_ids: eligibleRecipients.map((p) => p.id),
          message_body: resolvedBodyForApi,
          template_id: selectedTemplate?.id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? `HTTP ${res.status}`);
      }
      const data: { sent: number; failed: number; errors: string[] } = await res.json();
      onClose();
      if (data.failed > 0) toast.info(`Sent to ${data.sent} players · ${data.failed} failed`);
      else toast.success(`Sent to ${data.sent} players`);
    } catch (err) {
      toast.error(`Send failed — ${err instanceof Error ? err.message : "try again"}`);
    } finally {
      setSending(false);
    }
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const sectionHead: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    fontWeight: 500,
    color: "var(--text-tertiary)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    marginBottom: 8,
  };

  const fieldInput: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "var(--bg-surface-2)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{ background: "var(--bg-surface)", borderRadius: 10, border: "1px solid var(--border)", width: "100%", maxWidth: 640, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Send bulk message</div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>{filterSummary}</div>
          </div>
          <button onClick={onClose} style={{ fontSize: 18, color: "var(--text-tertiary)", padding: "2px 6px", borderRadius: 4, lineHeight: 1 }}>×</button>
        </div>

        {/* SCROLLABLE BODY */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>

          {/* MESSAGE TYPE */}
          <div style={{ marginBottom: 18 }}>
            <div style={sectionHead}>Message type</div>
            <div style={{ display: "flex", gap: 8 }}>
              {(["template", "custom"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{ padding: "7px 16px", borderRadius: 6, fontSize: 13, fontWeight: mode === m ? 500 : 400, border: `1px solid ${mode === m ? "var(--accent)" : "var(--border)"}`, background: mode === m ? "rgba(232,168,56,0.08)" : "var(--bg-surface-2)", color: mode === m ? "var(--accent)" : "var(--text-secondary)", cursor: "pointer", transition: "all 0.12s" }}
                >
                  {m === "template" ? "Use a template" : "Write custom"}
                </button>
              ))}
            </div>
          </div>

          {/* TEMPLATE SELECTOR */}
          {mode === "template" && (
            <div style={{ marginBottom: 18 }}>
              <div style={sectionHead}>Select template</div>
              {templatesLoading ? (
                <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Loading…</div>
              ) : templates.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>No templates yet — create one in Settings.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {templates.map((t) => {
                    const selected = selectedTemplate?.id === t.id;
                    return (
                      <div
                        key={t.id}
                        onClick={() => handleSelectTemplate(t)}
                        style={{ border: `1.5px solid ${selected ? "#3b82f6" : "var(--border)"}`, borderRadius: 7, padding: "10px 14px", cursor: "pointer", background: selected ? "rgba(59,130,246,0.05)" : "var(--bg-surface-2)", transition: "border-color 0.12s, background 0.12s" }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <span style={{ fontWeight: 500, fontSize: 13 }}>{t.name}</span>
                          <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", padding: "1px 6px", borderRadius: 3, background: t.is_builtin ? "rgba(59,130,246,0.10)" : "rgba(232,168,56,0.08)", color: t.is_builtin ? "#3b82f6" : "var(--accent)", border: `1px solid ${t.is_builtin ? "rgba(59,130,246,0.2)" : "rgba(232,168,56,0.2)"}` }}>
                            {t.is_builtin ? "built-in" : "custom"}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {t.use_case_tags.map((tag) => <TagPill key={tag} tag={tag} />)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* EVENT PICKER — only when template needs it */}
          {needsEventPicker && (
            <div style={{ marginBottom: 18 }}>
              <div style={sectionHead}>Select an event</div>

              {eventsLoading ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-tertiary)" }}>
                  <span style={{ width: 12, height: 12, border: "2px solid var(--border)", borderTopColor: "var(--text-secondary)", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
                  Loading events from PodPlay…
                </div>
              ) : eventsError || events.length === 0 ? (
                <>
                  <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 12 }}>
                    {eventsError ?? "No upcoming events found in PodPlay."}
                  </div>
                  {/* Fall back to plain text inputs for all event vars */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {operatorVarsNeeded.filter((v) => EVENT_VARS.has(v)).map((v) => {
                      const cfg = OPERATOR_VAR_CONFIG[v]!;
                      return (
                        <div key={v}>
                          <label style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginBottom: 5, fontWeight: 500 }}>
                            {cfg.label}
                            {!operatorVals[v]?.trim() && <span style={{ marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 400 }}>required</span>}
                          </label>
                          <input
                            type="text"
                            value={operatorVals[v] ?? ""}
                            onChange={(e) => setOperatorVals((prev) => ({ ...prev, [v]: e.target.value }))}
                            placeholder={cfg.placeholder}
                            style={{ ...fieldInput, borderColor: operatorVals[v]?.trim() ? "var(--border)" : "rgba(232,168,56,0.5)" }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  {/* Native select */}
                  <select
                    value={selectedEventId}
                    onChange={(e) => handleEventChange(e.target.value)}
                    style={{ ...fieldInput, cursor: "pointer", marginBottom: 10 }}
                  >
                    <option value="" disabled>— Choose an event —</option>
                    {events.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {formatEventOption(ev)}
                      </option>
                    ))}
                  </select>

                  {/* Sign-up link state after selection */}
                  {selectedEventId && (
                    manualLinkNeeded ? (
                      <div style={{ marginTop: 6 }}>
                        <label style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginBottom: 5, fontWeight: 500 }}>
                          Sign-up link
                          {!operatorVals.event_link?.trim() && <span style={{ marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 400 }}>required</span>}
                        </label>
                        <input
                          type="text"
                          value={operatorVals.event_link ?? ""}
                          onChange={(e) => handleManualLink(e.target.value)}
                          placeholder="e.g. pbclub.com/tournament"
                          style={{ ...fieldInput, borderColor: operatorVals.event_link?.trim() ? "var(--border)" : "rgba(232,168,56,0.5)", marginBottom: 5 }}
                        />
                        <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                          No sign-up link found for this event. Enter one manually or leave blank.
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: "var(--state-active)", marginTop: 4 }}>
                        Sign-up link found ✓
                      </div>
                    )
                  )}
                </>
              )}
            </div>
          )}

          {/* NON-EVENT OPERATOR VARS (e.g. {{next_level}}) */}
          {nonEventOperatorVars.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={sectionHead}>Fill in details</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {nonEventOperatorVars.map((v) => {
                  const cfg = OPERATOR_VAR_CONFIG[v] ?? { label: v, placeholder: "" };
                  return (
                    <div key={v}>
                      <label style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", marginBottom: 5, fontWeight: 500 }}>
                        {cfg.label}
                        {!operatorVals[v]?.trim() && <span style={{ marginLeft: 6, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 400 }}>required</span>}
                      </label>
                      <input
                        type="text"
                        value={operatorVals[v] ?? ""}
                        onChange={(e) => setOperatorVals((prev) => ({ ...prev, [v]: e.target.value }))}
                        placeholder={cfg.placeholder}
                        style={{ ...fieldInput, borderColor: operatorVals[v]?.trim() ? "var(--border)" : "rgba(232,168,56,0.5)" }}
                        onFocus={(e) => ((e.currentTarget as HTMLElement).style.borderColor = "var(--accent)")}
                        onBlur={(e) => ((e.currentTarget as HTMLElement).style.borderColor = operatorVals[v]?.trim() ? "var(--border)" : "rgba(232,168,56,0.5)")}
                      />
                    </div>
                  );
                })}
            </div>
            </div>
          )}

          {/* CUSTOM TEXTAREA */}
          {mode === "custom" && (
            <div style={{ marginBottom: 18 }}>
              <div style={sectionHead}>Message body</div>
              <textarea
                ref={textareaRef}
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                placeholder="Write your message…"
                rows={5}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-surface-2)", color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 13, lineHeight: 1.6, resize: "vertical", outline: "none", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", marginRight: 4 }}>Insert:</span>
                {ALL_VARS.map((v) => <VarChip key={v} label={v} onClick={() => insertVar(v)} />)}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", marginTop: 6 }}>
                {customBody.length} chars · {Math.ceil(customBody.length / 160) || 1} SMS
              </div>
            </div>
          )}

          {/* PREVIEW */}
          <div style={{ marginBottom: 18 }}>
            <div style={sectionHead}>Preview</div>
            <div style={{ background: "var(--bg-surface-2)", border: "1px solid var(--border)", borderRadius: 7, padding: "12px 14px", fontSize: 13, lineHeight: 1.7, color: "var(--text-primary)" }}>
              <PreviewText body={rawBody} player={previewPlayer} operatorVals={operatorVals} />
            </div>
            {previewPlayer && (
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 5, fontFamily: "var(--font-mono)" }}>
                Preview as: {previewPlayer.name}
                {!allOperatorVarsFilled && (
                  <span style={{ color: "var(--accent)", marginLeft: 8 }}>⚠ Fill in amber variables before sending</span>
                )}
              </div>
            )}
          </div>

          {/* OPT-IN TOGGLE */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-surface-2)" }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>Only send to SMS opt-in players</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{eligibleRecipients.length} / {recipients.length} eligible</div>
            </div>
            <button
              onClick={() => setOptInOnly((v) => !v)}
              style={{ width: 42, height: 24, borderRadius: 12, background: optInOnly ? "var(--state-active)" : "var(--border)", border: "none", cursor: "pointer", position: "relative", transition: "background 0.15s", flexShrink: 0 }}
            >
              <span style={{ position: "absolute", top: 3, left: optInOnly ? 21 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
            </button>
          </div>
        </div>

        {/* FOOTER */}
        <div style={{ padding: "14px 22px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, background: "var(--bg-surface)" }}>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
            Sending to {eligibleRecipients.length} players · ~${estimatedCost} est. cost
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={onClose} style={{ padding: "7px 16px", borderRadius: 5, fontSize: 13, border: "1px solid var(--border)", background: "var(--bg-surface-2)", color: "var(--text-secondary)", cursor: "pointer" }}>
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={!canSend || sending}
              style={{ padding: "7px 18px", borderRadius: 5, fontSize: 13, fontWeight: 500, background: canSend && !sending ? "var(--accent)" : "var(--border)", color: canSend && !sending ? "#fff" : "var(--text-tertiary)", border: "none", cursor: canSend && !sending ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: 6, transition: "background 0.12s, color 0.12s" }}
            >
              {sending && <span style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "#fff", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite" }} />}
              {sending ? "Sending…" : `Send to ${eligibleRecipients.length} players →`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
