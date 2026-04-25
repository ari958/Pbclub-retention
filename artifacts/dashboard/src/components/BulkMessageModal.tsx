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

const ALL_VARS = [
  "{{first_name}}",
  "{{skill_level}}",
  "{{club_name}}",
  "{{last_visit}}",
  "{{event_date}}",
  "{{booking_link}}",
];

const OPERATOR_VARS = new Set(["event_date", "booking_link", "event_link", "next_level"]);

function resolveVar(varName: string, player: Player | undefined): string | null {
  if (!player) return null;
  if (varName === "first_name") return player.name.split(" ")[0];
  if (varName === "skill_level") return player.skill_level ?? "your level";
  if (varName === "club_name") return "PB Club";
  if (varName === "last_visit") return relativeTime(player.last_visit_date);
  return null;
}

function hasUnresolvedVars(body: string): boolean {
  const matches = body.match(/\{\{(\w+)\}\}/g) ?? [];
  return matches.some((m) => OPERATOR_VARS.has(m.slice(2, -2)));
}

function PreviewText({ body, player }: { body: string; player: Player | undefined }) {
  if (!body.trim()) {
    return (
      <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>
        No message yet
      </span>
    );
  }
  const parts = body.split(/(\{\{\w+\}\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\{\{(\w+)\}\}$/);
        if (!match) return <span key={i}>{part}</span>;
        const varName = match[1];
        if (OPERATOR_VARS.has(varName)) {
          return (
            <span
              key={i}
              style={{
                background: "rgba(232,168,56,0.18)",
                color: "var(--accent)",
                borderRadius: 3,
                padding: "0 3px",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              {part}
            </span>
          );
        }
        const resolved = resolveVar(varName, player);
        return (
          <span
            key={i}
            style={{
              background: "rgba(46,160,67,0.10)",
              color: "var(--state-active)",
              borderRadius: 3,
              padding: "0 3px",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            {resolved ?? part}
          </span>
        );
      })}
    </>
  );
}

function TagPill({ tag }: { tag: string }) {
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

function VarChip({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        padding: "3px 8px",
        borderRadius: 4,
        background: "var(--bg-surface-2)",
        color: "var(--text-secondary)",
        border: "1px solid var(--border)",
        cursor: "pointer",
        transition: "border-color 0.1s",
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLElement).style.borderColor = "var(--accent)")
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLElement).style.borderColor = "var(--border)")
      }
    >
      {label}
    </button>
  );
}

export function BulkMessageModal({
  recipients,
  filterSummary,
  onClose,
}: BulkMessageModalProps) {
  const toast = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [mode, setMode] = useState<"template" | "custom">("template");
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<MessageTemplate | null>(null);
  const [customBody, setCustomBody] = useState("");
  const [optInOnly, setOptInOnly] = useState(true);
  const [sending, setSending] = useState(false);

  const previewPlayer = recipients[0];
  const activeBody = mode === "template" ? (selectedTemplate?.body ?? "") : customBody;

  const eligibleRecipients = optInOnly
    ? recipients.filter((p) => p.sms_opt_in === true)
    : recipients;

  const canSend =
    activeBody.trim().length > 0 &&
    (mode === "template" ? selectedTemplate !== null : true) &&
    !hasUnresolvedVars(activeBody) &&
    eligibleRecipients.length > 0;

  const estimatedCost = (eligibleRecipients.length * 0.02).toFixed(2);

  useEffect(() => {
    supabase
      .from("message_templates")
      .select("*")
      .order("created_at")
      .then(({ data }) => {
        if (data) setTemplates(data as MessageTemplate[]);
        setTemplatesLoading(false);
      });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const insertVar = useCallback(
    (v: string) => {
      const el = textareaRef.current;
      if (!el) {
        setCustomBody((b) => b + v);
        return;
      }
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + v + el.value.slice(end);
      setCustomBody(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + v.length, start + v.length);
      });
    },
    []
  );

  const handleSend = async () => {
    setSending(true);
    try {
      const res = await fetch("/api/messages/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          player_ids: eligibleRecipients.map((p) => p.id),
          message_body: activeBody,
          template_id: selectedTemplate?.id,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const data: { sent: number; failed: number; errors: string[] } = await res.json();

      onClose();

      if (data.failed > 0) {
        console.warn("Bulk send partial failures:", data.errors);
        toast.info(
          `Sent to ${data.sent} players · ${data.failed} failed`
        );
      } else {
        toast.success(`Sent to ${data.sent} players`);
      }
    } catch (err) {
      toast.error(
        `Send failed — ${err instanceof Error ? err.message : "try again"}`
      );
    } finally {
      setSending(false);
    }
  };

  const sectionHead: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    fontWeight: 500,
    color: "var(--text-tertiary)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    marginBottom: 8,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg-surface)",
          borderRadius: 10,
          border: "1px solid var(--border)",
          width: "100%",
          maxWidth: 640,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div
          style={{
            padding: "18px 22px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
              Send bulk message
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {filterSummary}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              fontSize: 18,
              color: "var(--text-tertiary)",
              padding: "2px 6px",
              borderRadius: 4,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* SCROLLABLE BODY */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>

          {/* MESSAGE TYPE TOGGLE */}
          <div style={{ marginBottom: 18 }}>
            <div style={sectionHead}>Message type</div>
            <div style={{ display: "flex", gap: 8 }}>
              {(["template", "custom"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    padding: "7px 16px",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: mode === m ? 500 : 400,
                    border: `1px solid ${mode === m ? "var(--accent)" : "var(--border)"}`,
                    background: mode === m ? "rgba(232,168,56,0.08)" : "var(--bg-surface-2)",
                    color: mode === m ? "var(--accent)" : "var(--text-secondary)",
                    cursor: "pointer",
                    transition: "all 0.12s",
                  }}
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
                <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>
                  No templates yet — create one in Settings.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {templates.map((t) => {
                    const selected = selectedTemplate?.id === t.id;
                    return (
                      <div
                        key={t.id}
                        onClick={() => setSelectedTemplate(t)}
                        style={{
                          border: `1.5px solid ${selected ? "#3b82f6" : "var(--border)"}`,
                          borderRadius: 7,
                          padding: "10px 14px",
                          cursor: "pointer",
                          background: selected
                            ? "rgba(59,130,246,0.05)"
                            : "var(--bg-surface-2)",
                          transition: "border-color 0.12s, background 0.12s",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 6,
                          }}
                        >
                          <span style={{ fontWeight: 500, fontSize: 13 }}>{t.name}</span>
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: "var(--font-mono)",
                              padding: "1px 6px",
                              borderRadius: 3,
                              background: t.is_builtin
                                ? "rgba(59,130,246,0.10)"
                                : "var(--accent-light)",
                              color: t.is_builtin ? "#3b82f6" : "var(--accent)",
                              border: `1px solid ${t.is_builtin ? "rgba(59,130,246,0.2)" : "rgba(232,168,56,0.2)"}`,
                            }}
                          >
                            {t.is_builtin ? "built-in" : "custom"}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {t.use_case_tags.map((tag) => (
                            <TagPill key={tag} tag={tag} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
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
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg-surface-2)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 13,
                  lineHeight: 1.6,
                  resize: "vertical",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                  marginTop: 8,
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--text-tertiary)",
                    fontFamily: "var(--font-mono)",
                    marginRight: 4,
                  }}
                >
                  Insert:
                </span>
                {ALL_VARS.map((v) => (
                  <VarChip key={v} label={v} onClick={() => insertVar(v)} />
                ))}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                  fontFamily: "var(--font-mono)",
                  marginTop: 6,
                }}
              >
                {customBody.length} chars
                {" · "}
                {Math.ceil(customBody.length / 160) || 1} SMS
              </div>
            </div>
          )}

          {/* MESSAGE PREVIEW */}
          <div style={{ marginBottom: 18 }}>
            <div style={sectionHead}>Preview</div>
            <div
              style={{
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 7,
                padding: "12px 14px",
                fontSize: 13,
                lineHeight: 1.7,
                color: "var(--text-primary)",
              }}
            >
              <PreviewText body={activeBody} player={previewPlayer} />
            </div>
            {previewPlayer && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                  marginTop: 5,
                  fontFamily: "var(--font-mono)",
                }}
              >
                Preview as: {previewPlayer.name}
                {hasUnresolvedVars(activeBody) && (
                  <span style={{ color: "var(--accent)", marginLeft: 8 }}>
                    ⚠ Fill in amber variables before sending
                  </span>
                )}
              </div>
            )}
          </div>

          {/* OPT-IN FILTER */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-surface-2)",
            }}
          >
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>
                Only send to SMS opt-in players
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                {eligibleRecipients.length} / {recipients.length} eligible
              </div>
            </div>
            <button
              onClick={() => setOptInOnly((v) => !v)}
              style={{
                width: 42,
                height: 24,
                borderRadius: 12,
                background: optInOnly ? "var(--state-active)" : "var(--border)",
                border: "none",
                cursor: "pointer",
                position: "relative",
                transition: "background 0.15s",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 3,
                  left: optInOnly ? 21 : 3,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left 0.15s",
                }}
              />
            </button>
          </div>
        </div>

        {/* FOOTER */}
        <div
          style={{
            padding: "14px 22px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
            background: "var(--bg-surface)",
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Sending to {eligibleRecipients.length} players · ~${estimatedCost} est. cost
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={onClose}
              style={{
                padding: "7px 16px",
                borderRadius: 5,
                fontSize: 13,
                border: "1px solid var(--border)",
                background: "var(--bg-surface-2)",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={!canSend || sending}
              style={{
                padding: "7px 18px",
                borderRadius: 5,
                fontSize: 13,
                fontWeight: 500,
                background: canSend && !sending ? "var(--accent)" : "var(--border)",
                color: canSend && !sending ? "#fff" : "var(--text-tertiary)",
                border: "none",
                cursor: canSend && !sending ? "pointer" : "not-allowed",
                display: "flex",
                alignItems: "center",
                gap: 6,
                transition: "background 0.12s, color 0.12s",
              }}
            >
              {sending && (
                <span
                  style={{
                    width: 12,
                    height: 12,
                    border: "2px solid rgba(255,255,255,0.4)",
                    borderTopColor: "#fff",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "spin 0.7s linear infinite",
                  }}
                />
              )}
              {sending
                ? "Sending…"
                : `Send to ${eligibleRecipients.length} players →`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
