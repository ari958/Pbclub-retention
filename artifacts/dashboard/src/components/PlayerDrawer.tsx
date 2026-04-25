import { useEffect, useState, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useToast } from "./Toast";
import { relativeTime, formatDate, getEngagementState, toTitleCase, STATE_COLORS } from "@/lib/helpers";
import type { ProgressionStatus } from "@/lib/types";

interface FullPlayer {
  id: string;
  name: string;
  skill_level: string | null;
  membership_status: string | null;
  progression_status: ProgressionStatus;
  last_visit_date: string | null;
  phone: string | null;
  notes: string | null;
  club_id: string | null;
}

interface Attendance {
  id: string;
  program_name: string | null;
  program_type: string | null;
  attended_at: string;
}

interface MessageRow {
  id: string;
  body: string;
  direction: string;
  twilio_message_sid: string | null;
}

interface ConversationRow {
  id: string;
  triggered_by: string | null;
  messages: MessageRow[];
}

interface PlayerDrawerProps {
  playerId: string | null;
  onClose: () => void;
  onDataChanged?: () => void;
}

const PROGRESSION_OPTIONS: { label: string; value: ProgressionStatus }[] = [
  { label: "Ready to Advance", value: "ready-to-advance" },
  { label: "Developing", value: "developing" },
  { label: "At Ceiling", value: "at-ceiling" },
  { label: "Unset", value: null },
];

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        border: "2px solid rgba(255,255,255,0.4)",
        borderTopColor: "#fff",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
        marginRight: 5,
        verticalAlign: "middle",
      }}
    />
  );
}

function MembershipPill({ status }: { status: string | null }) {
  if (!status) return <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>—</span>;
  const isMember = status.toLowerCase() === "member";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 9px",
        borderRadius: 4,
        background: isMember ? "rgba(46,160,67,0.10)" : "rgba(100,100,100,0.08)",
        color: isMember ? "#2ea043" : "#8b949e",
        fontSize: 12,
        fontWeight: 500,
        border: `1px solid ${isMember ? "rgba(46,160,67,0.20)" : "rgba(100,100,100,0.14)"}`,
      }}
    >
      {toTitleCase(status)}
    </span>
  );
}

export function PlayerDrawer({ playerId, onClose, onDataChanged }: PlayerDrawerProps) {
  const toast = useToast();
  const [player, setPlayer] = useState<FullPlayer | null>(null);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [runningAgent, setRunningAgent] = useState(false);
  const [savingProgression, setSavingProgression] = useState(false);

  // Notes
  const [notesDraft, setNotesDraft] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Agent inline result
  const [agentResult, setAgentResult] = useState<string | null>(null);
  const [editingResult, setEditingResult] = useState(false);
  const [resultDraft, setResultDraft] = useState("");
  const [sendingResult, setSendingResult] = useState(false);

  // Animation
  const [mounted, setMounted] = useState(false);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Trigger slide-in
  useEffect(() => {
    if (playerId) {
      setMounted(false);
      setAgentResult(null);
      requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    } else {
      setMounted(false);
    }
  }, [playerId]);

  useEffect(() => {
    if (!playerId) {
      setPlayer(null);
      setAttendance([]);
      setConversations([]);
      setNotesDraft("");
      return;
    }
    setLoadingData(true);
    Promise.all([
      supabase
        .from("players")
        .select("id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id")
        .eq("id", playerId)
        .single(),
      supabase
        .from("attendances")
        .select("id, program_name, program_type, attended_at")
        .eq("player_id", playerId)
        .order("attended_at", { ascending: false })
        .limit(15),
      supabase
        .from("conversations")
        .select("id, triggered_by, messages!conversation_id(id, body, direction, twilio_message_sid)")
        .eq("player_id", playerId)
        .order("id", { ascending: false }),
    ]).then(([pRes, aRes, cRes]) => {
      if (pRes.data) {
        setPlayer(pRes.data as FullPlayer);
        setNotesDraft(pRes.data.notes ?? "");
      }
      if (aRes.data) setAttendance(aRes.data as Attendance[]);
      if (cRes.data) setConversations(cRes.data as ConversationRow[]);
    }).finally(() => setLoadingData(false));
  }, [playerId]);

  const updateProgression = async (val: ProgressionStatus) => {
    if (!player) return;
    setSavingProgression(true);
    await supabase.from("players").update({ progression_status: val }).eq("id", player.id);
    setPlayer((p) => p ? { ...p, progression_status: val } : p);
    setSavingProgression(false);
    onDataChanged?.();
    toast.info(`Progression set to ${toTitleCase(val ?? "unset")}`);
  };

  const saveNotes = async () => {
    if (!player) return;
    const trimmed = notesDraft.trim();
    const current = player.notes ?? "";
    if (trimmed === current) return;
    await supabase.from("players").update({ notes: trimmed || null }).eq("id", player.id);
    setPlayer((p) => p ? { ...p, notes: trimmed || null } : p);
    setNoteSaved(true);
    if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = setTimeout(() => setNoteSaved(false), 2000);
  };

  const runAgent = async () => {
    if (!player) return;
    setRunningAgent(true);
    setAgentResult(null);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: player.id }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.message ?? data.body ?? null;
        if (msg) {
          setAgentResult(msg);
          setResultDraft(msg);
        }
        toast.success("Message ready in queue");
        onDataChanged?.();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Agent run failed");
      }
    } catch {
      toast.error("Failed — try again");
    } finally {
      setRunningAgent(false);
    }
  };

  const sendResult = async () => {
    setSendingResult(true);
    try {
      const { data: convData } = await supabase
        .from("conversations")
        .select("id, messages!conversation_id(id)")
        .eq("player_id", player!.id)
        .order("id", { ascending: false })
        .limit(1)
        .single();
      const msgId = (convData as any)?.messages?.[0]?.id;
      if (msgId) {
        const res = await fetch("/api/messages/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: msgId }),
        });
        if (res.ok) {
          toast.success("Message sent");
          setAgentResult(null);
          onDataChanged?.();
        } else {
          const d = await res.json().catch(() => ({}));
          toast.error(d.error ?? "Send failed");
        }
      }
    } finally {
      setSendingResult(false);
    }
  };

  if (!playerId) return null;

  const engState = player ? getEngagementState(player.last_visit_date) : null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          zIndex: 200,
          opacity: mounted ? 1 : 0,
          transition: "opacity 200ms ease-out",
        }}
      />

      {/* Drawer panel */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          width: 440,
          height: "100vh",
          background: "var(--bg-surface)",
          borderLeft: "1px solid var(--border)",
          zIndex: 201,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          transform: mounted ? "translateX(0)" : "translateX(100%)",
          transition: "transform 200ms ease-out",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            position: "sticky",
            top: 0,
            background: "var(--bg-surface)",
            zIndex: 1,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            {loadingData || !player ? (
              <div className="skeleton-bar" style={{ width: 140, height: 18, borderRadius: 4 }} />
            ) : (
              <>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 3 }}>{player.name}</div>
                {engState && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: STATE_COLORS[engState],
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: 12, color: STATE_COLORS[engState], fontWeight: 500 }}>
                      {engState}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={runAgent}
              disabled={runningAgent || loadingData}
              style={{
                padding: "5px 12px",
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 500,
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                opacity: runningAgent || loadingData ? 0.65 : 1,
                cursor: runningAgent || loadingData ? "not-allowed" : "pointer",
                fontFamily: "var(--font-sans)",
                display: "flex",
                alignItems: "center",
              }}
            >
              {runningAgent && <Spinner />}
              {runningAgent ? "Running…" : "Run Agent"}
            </button>
            <button
              onClick={onClose}
              style={{
                width: 28,
                height: 28,
                borderRadius: 4,
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border)",
                fontSize: 16,
                color: "var(--text-tertiary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontFamily: "var(--font-sans)",
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {loadingData ? (
          <div style={{ padding: "20px" }}>
            {[140, 100, 160, 80, 120].map((w, i) => (
              <div key={i} className="skeleton-bar" style={{ width: w, height: 12, marginBottom: 14, borderRadius: 4 }} />
            ))}
          </div>
        ) : player ? (
          <div style={{ flex: 1 }}>
            {/* Profile section */}
            <Section title="Profile">
              <ProfileRow label="Last visit" value={relativeTime(player.last_visit_date)} />
              <ProfileRow label="Phone" value={player.phone ?? "—"} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12 }}>
                <span style={{ fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0 }}>Skill level</span>
                {player.skill_level ? (
                  <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500 }}>{toTitleCase(player.skill_level)}</span>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>Not set</span>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}>
                <span style={{ fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0 }}>Membership</span>
                <MembershipPill status={player.membership_status} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-tertiary)",
                    marginBottom: 6,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Progression
                </label>
                <select
                  value={player.progression_status ?? ""}
                  disabled={savingProgression}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateProgression(v === "" ? null : (v as ProgressionStatus));
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 13,
                    width: "100%",
                    opacity: savingProgression ? 0.5 : 1,
                    cursor: savingProgression ? "not-allowed" : "pointer",
                    outline: "none",
                  }}
                >
                  {PROGRESSION_OPTIONS.map((o) => (
                    <option key={String(o.value)} value={o.value ?? ""}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Notes */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label
                    style={{
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-tertiary)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Notes
                  </label>
                  {noteSaved && (
                    <span style={{ fontSize: 11, color: "var(--state-active)", fontWeight: 500 }}>
                      Saved ✓
                    </span>
                  )}
                </div>
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  onBlur={saveNotes}
                  placeholder="Add notes about this player…"
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    fontSize: 12,
                    fontFamily: "var(--font-sans)",
                    lineHeight: 1.55,
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    resize: "vertical",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </Section>

            {/* Agent Result inline */}
            {agentResult && (
              <Section title="Generated Message">
                {editingResult ? (
                  <>
                    <textarea
                      value={resultDraft}
                      onChange={(e) => setResultDraft(e.target.value)}
                      rows={5}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        fontSize: 12,
                        fontFamily: "var(--font-sans)",
                        lineHeight: 1.55,
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        background: "var(--bg-surface-2)",
                        color: "var(--text-primary)",
                        resize: "vertical",
                        outline: "none",
                        marginBottom: 8,
                      }}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => { setAgentResult(resultDraft); setEditingResult(false); }}
                        style={{ ...btnStyle, background: "var(--accent)", color: "#fff", border: "none" }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => { setResultDraft(agentResult); setEditingResult(false); }}
                        style={btnStyle}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        lineHeight: 1.6,
                        fontStyle: "italic",
                        padding: "10px 12px",
                        background: "var(--bg-surface-2)",
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        marginBottom: 10,
                      }}
                    >
                      {agentResult}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => { setEditingResult(true); setResultDraft(agentResult); }}
                        style={btnStyle}
                      >
                        Edit
                      </button>
                      <button
                        onClick={sendResult}
                        disabled={sendingResult}
                        style={{ ...btnStyle, background: "var(--accent)", color: "#fff", border: "none", opacity: sendingResult ? 0.65 : 1 }}
                      >
                        {sendingResult ? "Sending…" : "Send"}
                      </button>
                      <button
                        onClick={() => setAgentResult(null)}
                        style={{ ...btnStyle, color: "var(--text-tertiary)" }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </>
                )}
              </Section>
            )}

            {/* Attendance */}
            <Section title={`Attendance (last ${attendance.length})`}>
              {attendance.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No attendance records</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {attendance.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <span style={{ fontSize: 12, color: "var(--text-primary)" }}>
                        {a.program_name ?? "Unknown program"}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-tertiary)",
                          flexShrink: 0,
                          marginLeft: 12,
                        }}
                      >
                        {formatDate(a.attended_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Conversation history */}
            <Section title={`Conversations (${conversations.length})`}>
              {conversations.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No conversations yet</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {conversations.map((c) => (
                    <div
                      key={c.id}
                      style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}
                    >
                      <div
                        style={{
                          padding: "6px 10px",
                          background: "var(--bg-surface-2)",
                          borderBottom: "1px solid var(--border)",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        {c.triggered_by && (
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 10,
                              color: "var(--text-tertiary)",
                              padding: "1px 5px",
                              borderRadius: 3,
                              background: "var(--bg-surface)",
                              border: "1px solid var(--border)",
                            }}
                          >
                            {c.triggered_by}
                          </span>
                        )}
                      </div>
                      {c.messages.length > 0 ? (
                        c.messages.map((m) => (
                          <div
                            key={m.id}
                            style={{
                              padding: "8px 10px",
                              borderBottom: "1px solid var(--border)",
                              fontSize: 12,
                              lineHeight: 1.5,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 10,
                                fontFamily: "var(--font-mono)",
                                color: m.direction === "outbound" ? "var(--accent)" : "var(--state-active)",
                                marginBottom: 3,
                              }}
                            >
                              {m.direction}
                              {m.twilio_message_sid === "skipped" && " · skipped"}
                            </div>
                            <div style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>{m.body}</div>
                          </div>
                        ))
                      ) : (
                        <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-tertiary)" }}>
                          No messages
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
            }}
          >
            Player not found
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  background: "var(--bg-surface-2)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 500,
          color: "var(--text-tertiary)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        marginBottom: 8,
        gap: 12,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}
