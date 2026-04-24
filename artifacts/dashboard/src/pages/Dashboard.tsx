import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/components/Toast";
import { Sidebar } from "@/components/Sidebar";
import { PlayerDrawer } from "@/components/PlayerDrawer";
import {
  getEngagementState,
  relativeTime,
  STATE_COLORS,
  STATE_BG,
} from "@/lib/helpers";
import type { EngagementState, ProgressionStatus, Player, MessageQueueItem } from "@/lib/types";

// ─── Shared UI atoms ──────────────────────────────────────────────────────────

function StatePill({ state }: { state: EngagementState }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        borderRadius: 4,
        background: STATE_BG[state],
        fontSize: 12,
        fontWeight: 500,
        color: STATE_COLORS[state],
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: STATE_COLORS[state],
          flexShrink: 0,
        }}
      />
      {state}
    </span>
  );
}

function ProgressionBadge({ status }: { status: ProgressionStatus }) {
  const isUnset = status === null;
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        padding: "2px 6px",
        borderRadius: 3,
        background: isUnset ? "var(--accent-light)" : "var(--bg-surface-2)",
        color: isUnset ? "var(--accent)" : "var(--text-secondary)",
        border: `1px solid ${isUnset ? "rgba(232,168,56,0.25)" : "var(--border)"}`,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {status ?? "unset"}
    </span>
  );
}

function ActionBtn({
  label,
  variant = "default",
  onClick,
  disabled,
}: {
  label: string;
  variant?: "default" | "primary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
}) {
  const styles: Record<string, React.CSSProperties> = {
    default: {
      background: "var(--bg-surface-2)",
      color: "var(--text-primary)",
      border: "1px solid var(--border)",
    },
    primary: { background: "var(--accent)", color: "#fff", border: "none" },
    danger: {
      background: "rgba(207,34,46,0.08)",
      color: "var(--state-dormant)",
      border: "1px solid rgba(207,34,46,0.2)",
    },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles[variant],
        padding: "4px 10px",
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 500,
        opacity: disabled ? 0.4 : 1,
        fontFamily: "var(--font-sans)",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

// ─── Inline progression dropdown ──────────────────────────────────────────────

const PROG_OPTIONS: { label: string; value: ProgressionStatus }[] = [
  { label: "ready-to-advance", value: "ready-to-advance" },
  { label: "developing", value: "developing" },
  { label: "at-ceiling", value: "at-ceiling" },
  { label: "unset", value: null },
];

function ProgressionDropdown({
  status,
  playerId,
  onUpdate,
}: {
  status: ProgressionStatus;
  playerId: string;
  onUpdate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const select = async (val: ProgressionStatus) => {
    setSaving(true);
    setOpen(false);
    await supabase
      .from("players")
      .update({ progression_status: val })
      .eq("id", playerId);
    setSaving(false);
    onUpdate();
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <div
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        style={{ cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.5 : 1 }}
        title="Click to change"
      >
        <ProgressionBadge status={status} />
      </div>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            minWidth: 162,
            padding: "4px 0",
          }}
        >
          {PROG_OPTIONS.map((opt) => (
            <div
              key={String(opt.value)}
              onClick={(e) => {
                e.stopPropagation();
                select(opt.value);
              }}
              style={{
                padding: "7px 12px",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                color:
                  opt.value === status ? "var(--accent)" : "var(--text-primary)",
                background: "transparent",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.background = "var(--bg-surface-2)")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.background = "transparent")
              }
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Panels ───────────────────────────────────────────────────────────────────

function AtRiskPanel({
  players,
  filterState,
  onRunAgent,
  onRowClick,
  onProgressionChange,
}: {
  players: Player[];
  filterState: EngagementState | null;
  onRunAgent: (playerId: string) => Promise<void>;
  onRowClick: (playerId: string) => void;
  onProgressionChange: () => void;
}) {
  const [running, setRunning] = useState<string | null>(null);

  const handleRun = async (e: React.MouseEvent, playerId: string) => {
    e.stopPropagation();
    setRunning(playerId);
    try {
      await onRunAgent(playerId);
    } finally {
      setRunning(null);
    }
  };

  const sorted = [...players].sort((a, b) => {
    const order: Record<EngagementState, number> = {
      dormant: 0,
      lapsing: 1,
      active: 2,
    };
    return (
      order[getEngagementState(a.last_visit_date)] -
      order[getEngagementState(b.last_visit_date)]
    );
  });

  const displayed = filterState
    ? sorted.filter((p) => getEngagementState(p.last_visit_date) === filterState)
    : sorted;

  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 20px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>At-Risk Players</span>
          {filterState && (
            <span
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: STATE_COLORS[filterState],
                background: STATE_BG[filterState],
                padding: "1px 6px",
                borderRadius: 3,
              }}
            >
              {filterState}
            </span>
          )}
        </div>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-tertiary)",
            background: "var(--bg-surface-2)",
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid var(--border)",
          }}
        >
          {displayed.length} players
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-surface-2)" }}>
              {["PLAYER", "STATE", "PROGRESSION", "LAST VISIT", ""].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "8px 16px",
                    textAlign: "left",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontWeight: 500,
                    color: "var(--text-tertiary)",
                    borderBottom: "1px solid var(--border)",
                    letterSpacing: "0.05em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    padding: "32px 16px",
                    textAlign: "center",
                    color: "var(--text-tertiary)",
                    fontSize: 13,
                  }}
                >
                  No players to display
                </td>
              </tr>
            ) : (
              displayed.map((p, i) => {
                const state = getEngagementState(p.last_visit_date);
                const isRunning = running === p.id;
                return (
                  <tr
                    key={p.id}
                    onClick={() => onRowClick(p.id)}
                    style={{
                      borderBottom:
                        i < displayed.length - 1
                          ? "1px solid var(--border)"
                          : "none",
                      cursor: "pointer",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "var(--bg-surface-2)")
                    }
                    onMouseLeave={(e) =>
                      ((e.currentTarget as HTMLElement).style.background =
                        "transparent")
                    }
                  >
                    <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                      {p.skill_level && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-tertiary)",
                            marginTop: 1,
                          }}
                        >
                          {p.skill_level}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px" }}>
                      <StatePill state={state} />
                    </td>
                    <td style={{ padding: "10px 16px" }}>
                      <ProgressionDropdown
                        status={p.progression_status}
                        playerId={p.id}
                        onUpdate={onProgressionChange}
                      />
                    </td>
                    <td
                      style={{
                        padding: "10px 16px",
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {relativeTime(p.last_visit_date)}
                    </td>
                    <td style={{ padding: "10px 16px", textAlign: "right" }}>
                      <ActionBtn
                        label={isRunning ? "Running…" : "Run Agent"}
                        variant="default"
                        disabled={isRunning}
                        onClick={(e) => handleRun(e as unknown as React.MouseEvent, p.id)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NeedsAssessmentPanel({
  players,
  onUpdate,
}: {
  players: Player[];
  onUpdate: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [checkmarks, setCheckmarks] = useState<Set<string>>(new Set());

  const updateProgression = async (playerId: string, status: string) => {
    setLoading(playerId + status);
    await supabase
      .from("players")
      .update({ progression_status: status })
      .eq("id", playerId);
    setLoading(null);
    setCheckmarks((prev) => new Set([...prev, playerId]));
    setTimeout(() => {
      setCheckmarks((prev) => {
        const next = new Set(prev);
        next.delete(playerId);
        return next;
      });
      onUpdate();
    }, 600);
  };

  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 20px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>Needs Assessment</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--state-lapsing)",
            background: "rgba(212,129,58,0.08)",
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid rgba(212,129,58,0.2)",
          }}
        >
          {players.length} pending
        </span>
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {players.length === 0 ? (
          <div
            style={{
              padding: "28px 20px",
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
            }}
          >
            All players assessed
          </div>
        ) : (
          players.map((p, i) => (
            <div
              key={p.id}
              style={{
                padding: "12px 16px",
                borderBottom:
                  i < players.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 8,
                }}
              >
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                    }}
                  >
                    {p.skill_level ?? "No skill level"} · {relativeTime(p.last_visit_date)}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
                {checkmarks.has(p.id) ? (
                  <span
                    style={{
                      fontSize: 14,
                      color: "var(--state-active)",
                      fontWeight: 600,
                    }}
                  >
                    ✓
                  </span>
                ) : (
                  <>
                    <ActionBtn
                      label="Ready"
                      variant="primary"
                      disabled={loading === p.id + "ready-to-advance"}
                      onClick={() => updateProgression(p.id, "ready-to-advance")}
                    />
                    <ActionBtn
                      label="Developing"
                      disabled={loading === p.id + "developing"}
                      onClick={() => updateProgression(p.id, "developing")}
                    />
                    <ActionBtn
                      label="Ceiling"
                      disabled={loading === p.id + "at-ceiling"}
                      onClick={() => updateProgression(p.id, "at-ceiling")}
                    />
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function MessageQueuePanel({
  messages,
  onSent,
  onOpenPlayer,
}: {
  messages: MessageQueueItem[];
  onSent: () => void;
  onOpenPlayer: (playerId: string) => void;
}) {
  const [sending, setSending] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const sendMessage = async (messageId: string) => {
    setSending(messageId);
    try {
      const res = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: messageId }),
      });
      if (res.ok) {
        toast.success("Message sent");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? data.reason ?? "Send failed");
      }
      onSent();
    } finally {
      setSending(null);
    }
  };

  const skipMessage = async (messageId: string, conversationId: string) => {
    setSkipping(messageId);
    try {
      await supabase
        .from("messages")
        .update({ twilio_message_sid: "skipped" })
        .eq("id", messageId);
      await supabase
        .from("conversations")
        .update({ triggered_by: "skipped" })
        .eq("id", conversationId);
      onSent();
    } finally {
      setSkipping(null);
    }
  };

  const startEdit = (messageId: string, body: string) => {
    setEditingId(messageId);
    setDraftBody(body);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftBody("");
  };

  const saveEdit = async (messageId: string) => {
    setSaving(true);
    try {
      await supabase
        .from("messages")
        .update({ body: draftBody })
        .eq("id", messageId);
      setEditingId(null);
      setDraftBody("");
      onSent();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 20px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>Message Queue</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-tertiary)",
            background: "var(--bg-surface-2)",
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid var(--border)",
          }}
        >
          {messages.length} pending
        </span>
      </div>
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        {messages.length === 0 ? (
          <div
            style={{
              padding: "28px 20px",
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
            }}
          >
            No messages in queue
          </div>
        ) : (
          messages.map((m, i) => {
            const player = m.conversations?.players;
            const routingTag = m.conversations?.triggered_by;
            const playerId = m.conversations?.player_id ?? player?.id ?? null;
            const isEditing = editingId === m.id;
            const isSending = sending === m.id;
            const isSkipping = skipping === m.id;
            const busy = isSending || isSkipping || saving;

            return (
              <div
                key={m.id}
                style={{
                  padding: "12px 16px",
                  borderBottom:
                    i < messages.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 6,
                  }}
                >
                  <span
                    onClick={() => playerId && onOpenPlayer(playerId)}
                    style={{
                      fontWeight: 500,
                      fontSize: 13,
                      cursor: playerId ? "pointer" : "default",
                      color: playerId ? "var(--accent)" : "inherit",
                      textDecoration: playerId ? "none" : undefined,
                    }}
                    onMouseEnter={(e) => {
                      if (playerId)
                        (e.currentTarget as HTMLElement).style.textDecoration =
                          "underline";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.textDecoration =
                        "none";
                    }}
                  >
                    {player?.name ?? "Unknown"}
                  </span>
                  {routingTag && routingTag !== "skipped" && (
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        padding: "1px 5px",
                        borderRadius: 3,
                        background: "var(--bg-surface-2)",
                        color: "var(--text-tertiary)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {routingTag}
                    </span>
                  )}
                </div>

                {isEditing ? (
                  <textarea
                    value={draftBody}
                    onChange={(e) => setDraftBody(e.target.value)}
                    rows={4}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "8px 10px",
                      fontSize: 12,
                      fontFamily: "var(--font-sans)",
                      lineHeight: 1.5,
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      background: "var(--bg-surface-2)",
                      color: "var(--text-primary)",
                      resize: "vertical",
                      outline: "none",
                      marginBottom: 8,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      fontStyle: "italic",
                      lineHeight: 1.5,
                      marginBottom: 10,
                    }}
                  >
                    {m.body.length > 120 ? m.body.slice(0, 120) + "…" : m.body}
                  </div>
                )}

                {isEditing ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <ActionBtn
                      label={saving ? "Saving…" : "Save"}
                      variant="primary"
                      disabled={saving || draftBody.trim() === ""}
                      onClick={() => saveEdit(m.id)}
                    />
                    <ActionBtn
                      label="Cancel"
                      disabled={saving}
                      onClick={cancelEdit}
                    />
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <ActionBtn
                      label={isSending ? "Sending…" : "Send"}
                      variant="primary"
                      disabled={busy}
                      onClick={() => sendMessage(m.id)}
                    />
                    <ActionBtn
                      label="Edit"
                      disabled={busy}
                      onClick={() => startEdit(m.id, m.body)}
                    />
                    <ActionBtn
                      label={isSkipping ? "Skipping…" : "Skip"}
                      variant="danger"
                      disabled={busy}
                      onClick={() => skipMessage(m.id, m.conversation_id)}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();

  const [players, setPlayers] = useState<Player[]>([]);
  const [messages, setMessages] = useState<MessageQueueItem[]>([]);
  const [clubName, setClubName] = useState("");
  const [loading, setLoading] = useState(true);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [filterState, setFilterState] = useState<EngagementState | null>(null);
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);

  const fetchMessages = useCallback(async () => {
    const res = await supabase
      .from("messages")
      .select(
        "id, body, signup_url, conversation_id, conversations!conversation_id(id, triggered_by, player_id, players!player_id(id, name, skill_level, progression_status))"
      )
      .eq("direction", "outbound")
      .eq("sent_by", "agent")
      .is("twilio_message_sid", null);
    if (res.data) setMessages(res.data as MessageQueueItem[]);
  }, []);

  const fetchData = useCallback(async () => {
    const [playersRes, clubRes] = await Promise.all([
      supabase
        .from("players")
        .select(
          "id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id"
        ),
      supabase.from("clubs").select("name").limit(1).maybeSingle(),
    ]);
    if (playersRes.data) setPlayers(playersRes.data as Player[]);
    if (clubRes.data?.name) setClubName(clubRes.data.name);
    await fetchMessages();
    setLoading(false);
  }, [fetchMessages]);

  const runAgent = useCallback(
    async (playerId: string) => {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: playerId }),
      });
      if (res.ok) {
        toast.success("Message ready in queue");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Agent run failed");
      }
      await fetchMessages();
    },
    [fetchMessages, toast]
  );

  const runBatchAgent = useCallback(async () => {
    setBatchRunning(true);
    setBatchStatus(null);
    try {
      const targets = players
        .filter((p) =>
          ["lapsing", "dormant"].includes(getEngagementState(p.last_visit_date))
        )
        .slice(0, 50);

      if (targets.length === 0) {
        toast.info("No lapsing or dormant players to message");
        return;
      }

      let generated = 0;
      for (let i = 0; i < targets.length; i++) {
        setBatchStatus(`Running ${i + 1} of ${targets.length}…`);
        const res = await fetch("/api/agent/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ player_id: targets[i].id }),
        });
        if (res.ok) generated++;
      }
      await fetchMessages();
      toast.success(
        `${generated} message${generated !== 1 ? "s" : ""} generated`
      );
    } finally {
      setBatchRunning(false);
      setBatchStatus(null);
    }
  }, [players, fetchMessages, toast]);

  const syncAll = useCallback(async () => {
    setSyncRunning(true);
    try {
      const res = await fetch("/api/sync/all", { method: "POST" });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.success(`Sync complete — ${data.synced ?? 0} players updated`);
        await fetchData();
      } else {
        toast.error("Sync failed");
      }
    } finally {
      setSyncRunning(false);
    }
  }, [fetchData, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const needsAssessment = players.filter((p) => p.progression_status === null);
  const active = players.filter(
    (p) => getEngagementState(p.last_visit_date) === "active"
  ).length;
  const lapsing = players.filter(
    (p) => getEngagementState(p.last_visit_date) === "lapsing"
  ).length;
  const dormant = players.filter(
    (p) => getEngagementState(p.last_visit_date) === "dormant"
  ).length;

  const handleCardClick = (key: EngagementState) => {
    setFilterState((prev) => (prev === key ? null : key));
  };

  const statCards = [
    {
      key: "active" as EngagementState,
      label: "ACTIVE PLAYERS",
      value: active,
      color: "var(--state-active)",
    },
    {
      key: "lapsing" as EngagementState,
      label: "LAPSING",
      value: lapsing,
      color: "var(--state-lapsing)",
    },
    {
      key: "dormant" as EngagementState,
      label: "DORMANT",
      value: dormant,
      color: "var(--state-dormant)",
    },
  ];

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <Sidebar clubName={clubName} />

      <div
        style={{
          marginLeft: 220,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {/* Top bar */}
        <header
          style={{
            height: 52,
            minHeight: 52,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 28px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-surface)",
            position: "sticky",
            top: 0,
            zIndex: 5,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>Dashboard</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {batchStatus && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                }}
              >
                {batchStatus}
              </span>
            )}
            <ActionBtn
              label={syncRunning ? "Syncing…" : "Sync All"}
              disabled={syncRunning}
              onClick={syncAll}
            />
            <ActionBtn
              label={batchRunning ? "Running…" : "Run Batch Agent"}
              variant="primary"
              disabled={batchRunning}
              onClick={runBatchAgent}
            />
          </div>
        </header>

        {/* Content */}
        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "24px 28px",
            background: "var(--bg-surface-2)",
          }}
        >
          {/* Stat cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 12,
              marginBottom: 20,
            }}
          >
            {statCards.map((s) => (
              <div
                key={s.key}
                onClick={() => handleCardClick(s.key)}
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "16px 20px",
                  cursor: "pointer",
                  borderBottom:
                    filterState === s.key
                      ? "3px solid var(--accent)"
                      : "1px solid var(--border)",
                  transition: "border-bottom 0.1s",
                  userSelect: "none",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontWeight: 500,
                    color: "var(--text-tertiary)",
                    letterSpacing: "0.06em",
                    marginBottom: 8,
                  }}
                >
                  {s.label}
                </div>
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 600,
                    color: s.color,
                    lineHeight: 1,
                  }}
                >
                  {loading ? "—" : s.value}
                </div>
              </div>
            ))}
            {/* Response Rate card */}
            <div
              onClick={() => navigate("/messages")}
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "16px 20px",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 500,
                  color: "var(--text-tertiary)",
                  letterSpacing: "0.06em",
                  marginBottom: 8,
                }}
              >
                RESPONSE RATE
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  lineHeight: 1,
                }}
              >
                —
              </div>
            </div>
          </div>

          {/* Two-column layout */}
          <div
            style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
          >
            <div style={{ flex: "0 0 60%", minWidth: 0 }}>
              <AtRiskPanel
                players={players}
                filterState={filterState}
                onRunAgent={runAgent}
                onRowClick={setDrawerPlayerId}
                onProgressionChange={fetchData}
              />
            </div>
            <div
              style={{
                flex: "0 0 calc(40% - 12px)",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <NeedsAssessmentPanel
                players={needsAssessment}
                onUpdate={fetchData}
              />
              <MessageQueuePanel
                messages={messages}
                onSent={fetchData}
                onOpenPlayer={setDrawerPlayerId}
              />
            </div>
          </div>
        </main>
      </div>

      <PlayerDrawer
        playerId={drawerPlayerId}
        onClose={() => setDrawerPlayerId(null)}
        onDataChanged={fetchData}
      />
    </div>
  );
}
