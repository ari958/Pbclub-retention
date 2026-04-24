import { useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

type EngagementState = "active" | "lapsing" | "dormant";
type ProgressionStatus = "ready-to-advance" | "developing" | "at-ceiling" | null;

interface Player {
  id: string;
  name: string;
  skill_level: string | null;
  membership_status: string | null;
  progression_status: ProgressionStatus;
  last_visit_date: string | null;
}

interface MessageQueueItem {
  id: string;
  body: string;
  signup_url: string | null;
  conversation_id: string;
  conversations: {
    triggered_by: string | null;
    players: {
      name: string;
      skill_level: string | null;
      progression_status: ProgressionStatus;
    } | null;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getEngagementState(lastVisitDate: string | null): EngagementState {
  if (!lastVisitDate) return "dormant";
  const daysSince = (Date.now() - new Date(lastVisitDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 14) return "active";
  if (daysSince <= 30) return "lapsing";
  return "dormant";
}

function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const STATE_COLORS: Record<EngagementState, string> = {
  active: "var(--state-active)",
  lapsing: "var(--state-lapsing)",
  dormant: "var(--state-dormant)",
};

const STATE_BG: Record<EngagementState, string> = {
  active: "rgba(46,160,67,0.10)",
  lapsing: "rgba(212,129,58,0.10)",
  dormant: "rgba(207,34,46,0.10)",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatePill({ state }: { state: EngagementState }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px",
      borderRadius: 4, background: STATE_BG[state], fontSize: 12, fontWeight: 500,
      color: STATE_COLORS[state],
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: STATE_COLORS[state], flexShrink: 0 }} />
      {state}
    </span>
  );
}

function ProgressionBadge({ status }: { status: ProgressionStatus }) {
  const isUnset = status === null;
  const label = status ?? "unset";
  return (
    <span style={{
      fontFamily: "var(--font-mono)", fontSize: 11, padding: "2px 6px", borderRadius: 3,
      background: isUnset ? "var(--accent-light)" : "var(--bg-surface-2)",
      color: isUnset ? "var(--accent)" : "var(--text-secondary)",
      border: `1px solid ${isUnset ? "rgba(232,168,56,0.25)" : "var(--border)"}`,
      fontWeight: 500, whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}

function ActionBtn({ label, variant = "default", onClick, disabled }: {
  label: string; variant?: "default" | "primary" | "danger"; onClick?: () => void; disabled?: boolean;
}) {
  const styles: Record<string, React.CSSProperties> = {
    default: { background: "var(--bg-surface-2)", color: "var(--text-primary)", border: "1px solid var(--border)" },
    primary: { background: "var(--accent)", color: "#fff", border: "none" },
    danger: { background: "rgba(207,34,46,0.08)", color: "var(--state-dormant)", border: "1px solid rgba(207,34,46,0.2)" },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles[variant], padding: "4px 10px", borderRadius: 4, fontSize: 12,
        fontWeight: 500, opacity: disabled ? 0.4 : 1, fontFamily: "var(--font-sans)",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

const NAV_ITEMS = ["Dashboard", "Players", "Assessments", "Messages", "Settings"];

function Sidebar({ active, clubName }: { active: string; clubName: string }) {
  return (
    <aside style={{
      width: 220, minWidth: 220, height: "100vh", position: "fixed", top: 0, left: 0,
      background: "var(--bg-primary)", display: "flex", flexDirection: "column",
      borderRight: "1px solid var(--border-dark)", zIndex: 10,
    }}>
      {/* Logo */}
      <div style={{ padding: "20px 20px 16px" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 500, color: "var(--accent)", letterSpacing: "-0.02em" }}>
          Pulse
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4, fontWeight: 400 }}>
          {clubName || "—"}
        </div>
      </div>

      <div style={{ width: "100%", height: 1, background: "var(--border-dark)" }} />

      {/* Nav */}
      <nav style={{ flex: 1, padding: "12px 0" }}>
        {NAV_ITEMS.map((item) => {
          const isActive = item === active;
          return (
            <div key={item} style={{
              display: "flex", alignItems: "center", padding: "8px 20px",
              fontSize: 13, fontWeight: isActive ? 500 : 400,
              color: isActive ? "#fff" : "var(--text-tertiary)",
              borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
              background: isActive ? "rgba(232,168,56,0.06)" : "transparent",
              cursor: "pointer", transition: "color 0.15s",
            }}>
              {item}
            </div>
          );
        })}
      </nav>

      {/* Sync status */}
      <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border-dark)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--state-active)", flexShrink: 0, boxShadow: "0 0 4px var(--state-active)" }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
            sync live
          </span>
        </div>
      </div>
    </aside>
  );
}

// ─── Panels ───────────────────────────────────────────────────────────────────

function AtRiskPanel({ players, onRunAgent }: { players: Player[]; onRunAgent: (playerId: string) => Promise<void> }) {
  const [running, setRunning] = useState<string | null>(null);

  const handleRun = async (playerId: string) => {
    setRunning(playerId);
    try {
      await onRunAgent(playerId);
    } finally {
      setRunning(null);
    }
  };

  const sorted = [...players].sort((a, b) => {
    const order: Record<EngagementState, number> = { dormant: 0, lapsing: 1, active: 2 };
    return order[getEngagementState(a.last_visit_date)] - order[getEngagementState(b.last_visit_date)];
  });

  return (
    <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>At-Risk Players</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", background: "var(--bg-surface-2)", padding: "2px 8px", borderRadius: 3, border: "1px solid var(--border)" }}>
          {sorted.length} players
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-surface-2)" }}>
              {["PLAYER", "STATE", "PROGRESSION", "LAST VISIT", ""].map((h) => (
                <th key={h} style={{
                  padding: "8px 16px", textAlign: "left", fontFamily: "var(--font-mono)",
                  fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)",
                  borderBottom: "1px solid var(--border)", letterSpacing: "0.05em",
                  whiteSpace: "nowrap",
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
                  No players to display
                </td>
              </tr>
            ) : sorted.map((p, i) => {
              const state = getEngagementState(p.last_visit_date);
              const isRunning = running === p.id;
              return (
                <tr key={p.id} style={{ borderBottom: i < sorted.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                    {p.skill_level && (
                      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>{p.skill_level}</div>
                    )}
                  </td>
                  <td style={{ padding: "10px 16px" }}>
                    <StatePill state={state} />
                  </td>
                  <td style={{ padding: "10px 16px" }}>
                    <ProgressionBadge status={p.progression_status} />
                  </td>
                  <td style={{ padding: "10px 16px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {relativeTime(p.last_visit_date)}
                  </td>
                  <td style={{ padding: "10px 16px", textAlign: "right" }}>
                    <ActionBtn
                      label={isRunning ? "Running…" : "Run Agent"}
                      variant="default"
                      disabled={isRunning}
                      onClick={() => handleRun(p.id)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NeedsAssessmentPanel({ players, onUpdate }: { players: Player[]; onUpdate: () => void }) {
  const [loading, setLoading] = useState<string | null>(null);

  const updateProgression = async (playerId: string, status: string) => {
    setLoading(playerId + status);
    await supabase.from("players").update({ progression_status: status }).eq("id", playerId);
    setLoading(null);
    onUpdate();
  };

  return (
    <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Needs Assessment</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--state-lapsing)", background: "rgba(212,129,58,0.08)", padding: "2px 8px", borderRadius: 3, border: "1px solid rgba(212,129,58,0.2)" }}>
          {players.length} pending
        </span>
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {players.length === 0 ? (
          <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
            All players assessed
          </div>
        ) : players.map((p, i) => (
          <div key={p.id} style={{
            padding: "12px 16px", borderBottom: i < players.length - 1 ? "1px solid var(--border)" : "none",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                  {p.skill_level ?? "No skill level set"} · {relativeTime(p.last_visit_date)}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
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
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MessageQueuePanel({ messages, onSent }: { messages: MessageQueueItem[]; onSent: () => void }) {
  const [sending, setSending] = useState<string | null>(null);

  const sendMessage = async (messageId: string) => {
    setSending(messageId);
    try {
      await fetch("/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: messageId }),
      });
      onSent();
    } finally {
      setSending(null);
    }
  };

  return (
    <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Message Queue</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", background: "var(--bg-surface-2)", padding: "2px 8px", borderRadius: 3, border: "1px solid var(--border)" }}>
          {messages.length} pending
        </span>
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {messages.length === 0 ? (
          <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
            No messages in queue
          </div>
        ) : messages.map((m, i) => {
          const player = m.conversations?.players;
          const routingTag = m.conversations?.triggered_by;
          return (
            <div key={m.id} style={{ padding: "12px 16px", borderBottom: i < messages.length - 1 ? "1px solid var(--border)" : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{ fontWeight: 500, fontSize: 13 }}>{player?.name ?? "Unknown"}</span>
                {routingTag && (
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 10, padding: "1px 5px", borderRadius: 3,
                    background: "var(--bg-surface-2)", color: "var(--text-tertiary)", border: "1px solid var(--border)",
                  }}>
                    {routingTag}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", fontStyle: "italic", lineHeight: 1.5, marginBottom: 10 }}>
                {m.body.length > 120 ? m.body.slice(0, 120) + "…" : m.body}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <ActionBtn
                  label={sending === m.id ? "Sending…" : "Send"}
                  variant="primary"
                  disabled={sending === m.id}
                  onClick={() => sendMessage(m.id)}
                />
                <ActionBtn label="Edit" />
                <ActionBtn label="Skip" variant="danger" />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [messages, setMessages] = useState<MessageQueueItem[]>([]);
  const [clubName, setClubName] = useState("");
  const [loading, setLoading] = useState(true);
  const [batchRunning, setBatchRunning] = useState(false);

  const fetchMessages = useCallback(async () => {
    const res = await supabase
      .from("messages")
      .select("id, body, signup_url, conversation_id, conversations!conversation_id(triggered_by, players!player_id(name, skill_level, progression_status))")
      .eq("direction", "outbound")
      .eq("sent_by", "agent")
      .is("twilio_message_sid", null);
    if (res.data) setMessages(res.data as MessageQueueItem[]);
  }, []);

  const fetchData = useCallback(async () => {
    const [playersRes, clubRes] = await Promise.all([
      supabase.from("players").select("id, name, skill_level, membership_status, progression_status, last_visit_date"),
      supabase.from("clubs").select("name").limit(1).maybeSingle(),
    ]);
    if (playersRes.data) setPlayers(playersRes.data as Player[]);
    if (clubRes.data?.name) setClubName(clubRes.data.name);
    await fetchMessages();
    setLoading(false);
  }, [fetchMessages]);

  const runAgent = useCallback(async (playerId: string) => {
    await fetch("/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: playerId }),
    });
    await fetchMessages();
  }, [fetchMessages]);

  const runBatchAgent = useCallback(async () => {
    setBatchRunning(true);
    try {
      const atRisk = players.filter((p) => {
        const s = getEngagementState(p.last_visit_date);
        return s === "lapsing" || s === "dormant";
      });
      await Promise.allSettled(
        atRisk.map((p) =>
          fetch("/api/agent/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ player_id: p.id }),
          })
        )
      );
      await fetchMessages();
    } finally {
      setBatchRunning(false);
    }
  }, [players, fetchMessages]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const needsAssessment = players.filter((p) => p.progression_status === null);

  const active = players.filter((p) => getEngagementState(p.last_visit_date) === "active").length;
  const lapsing = players.filter((p) => getEngagementState(p.last_visit_date) === "lapsing").length;
  const dormant = players.filter((p) => getEngagementState(p.last_visit_date) === "dormant").length;

  const stats = [
    { label: "ACTIVE PLAYERS", value: active, color: "var(--state-active)" },
    { label: "LAPSING", value: lapsing, color: "var(--state-lapsing)" },
    { label: "DORMANT", value: dormant, color: "var(--state-dormant)" },
    { label: "RESPONSE RATE", value: "—", color: "var(--text-primary)" },
  ];

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <Sidebar active="Dashboard" clubName={clubName} />

      {/* Main */}
      <div style={{ marginLeft: 220, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>

        {/* Sticky top bar */}
        <header style={{
          height: 52, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 28px", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)",
          position: "sticky", top: 0, zIndex: 5,
        }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Dashboard</span>
          <div style={{ display: "flex", gap: 8 }}>
            <ActionBtn label="Sync All" onClick={fetchData} />
            <ActionBtn
              label={batchRunning ? "Running…" : "Run Batch Agent"}
              variant="primary"
              disabled={batchRunning}
              onClick={runBatchAgent}
            />
          </div>
        </header>

        {/* Content */}
        <main style={{ flex: 1, overflowY: "auto", padding: "24px 28px", background: "var(--bg-surface-2)" }}>

          {/* Stat cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
            {stats.map((s) => (
              <div key={s.label} style={{
                background: "var(--bg-surface)", border: "1px solid var(--border)",
                borderRadius: 8, padding: "16px 20px",
              }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)", letterSpacing: "0.06em", marginBottom: 8 }}>
                  {s.label}
                </div>
                <div style={{ fontSize: 28, fontWeight: 600, color: s.color, lineHeight: 1 }}>
                  {loading ? "—" : s.value}
                </div>
              </div>
            ))}
          </div>

          {/* Two-column layout */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            {/* Left: 60% */}
            <div style={{ flex: "0 0 60%", minWidth: 0 }}>
              <AtRiskPanel players={players} onRunAgent={runAgent} />
            </div>

            {/* Right: 40% */}
            <div style={{ flex: "0 0 calc(40% - 12px)", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              <NeedsAssessmentPanel players={needsAssessment} onUpdate={fetchData} />
              <MessageQueuePanel messages={messages} onSent={fetchData} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
