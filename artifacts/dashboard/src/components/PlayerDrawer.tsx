import { useEffect, useState } from "react";
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

export function PlayerDrawer({ playerId, onClose, onDataChanged }: PlayerDrawerProps) {
  const toast = useToast();
  const [player, setPlayer] = useState<FullPlayer | null>(null);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [runningAgent, setRunningAgent] = useState(false);
  const [savingProgression, setSavingProgression] = useState(false);

  useEffect(() => {
    if (!playerId) {
      setPlayer(null);
      setAttendance([]);
      setConversations([]);
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
      if (pRes.data) setPlayer(pRes.data as FullPlayer);
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

  const runAgent = async () => {
    if (!player) return;
    setRunningAgent(true);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: player.id }),
      });
      if (res.ok) {
        toast.success("Message ready in queue");
        onDataChanged?.();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Agent run failed");
      }
    } finally {
      setRunningAgent(false);
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
        }}
      />

      {/* Drawer panel */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          width: 420,
          height: "100vh",
          background: "var(--bg-surface)",
          borderLeft: "1px solid var(--border)",
          zIndex: 201,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
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
              <div style={{ height: 20, background: "var(--bg-surface-2)", borderRadius: 4, width: 140 }} />
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
                opacity: runningAgent || loadingData ? 0.5 : 1,
                cursor: runningAgent || loadingData ? "not-allowed" : "pointer",
                fontFamily: "var(--font-sans)",
              }}
            >
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
            Loading…
          </div>
        ) : player ? (
          <div style={{ flex: 1 }}>
            {/* Profile section */}
            <Section title="Profile">
              <ProfileRow label="Skill level" value={player.skill_level ? toTitleCase(player.skill_level) : "—"} />
              <ProfileRow label="Membership" value={player.membership_status ? toTitleCase(player.membership_status) : "—"} />
              <ProfileRow label="Phone" value={player.phone ?? "—"} />
              <ProfileRow label="Last visit" value={relativeTime(player.last_visit_date)} />
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
                    padding: "5px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    opacity: savingProgression ? 0.5 : 1,
                    cursor: savingProgression ? "not-allowed" : "pointer",
                  }}
                >
                  {PROGRESSION_OPTIONS.map((o) => (
                    <option key={String(o.value)} value={o.value ?? ""}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {player.notes && (
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-tertiary)",
                      marginBottom: 4,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Notes
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      lineHeight: 1.55,
                      padding: "8px 10px",
                      background: "var(--bg-surface-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                    }}
                  >
                    {player.notes}
                  </div>
                </div>
              )}
            </Section>

            {/* Attendance */}
            <Section title={`Attendance (last ${attendance.length})`}>
              {attendance.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No sessions recorded</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {attendance.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "5px 0",
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
                      style={{
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        overflow: "hidden",
                      }}
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
                                color:
                                  m.direction === "outbound"
                                    ? "var(--accent)"
                                    : "var(--state-active)",
                                marginBottom: 3,
                              }}
                            >
                              {m.direction}
                              {m.twilio_message_sid === "skipped" && " · skipped"}
                            </div>
                            <div style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>
                              {m.body}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div
                          style={{
                            padding: "8px 10px",
                            fontSize: 12,
                            color: "var(--text-tertiary)",
                          }}
                        >
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
    </>
  );
}

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
      <span
        style={{
          fontSize: 12,
          color: "var(--text-primary)",
          fontWeight: 500,
          textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}
