import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { PlayerDrawer } from "@/components/PlayerDrawer";
import { formatDate } from "@/lib/helpers";
import type { MessageStatus } from "@/lib/types";

interface MessageRow {
  id: string;
  body: string;
  direction: string;
  status: MessageStatus;
  delivery_status: string | null;
  error_code: string | null;
  error_message: string | null;
  twilio_message_sid: string | null;
  link_clicked: boolean | null;
  link_clicked_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  conversation_id: string;
  conversations: {
    id: string;
    triggered_by: string | null;
    player_id: string | null;
    players: { id: string; name: string } | null;
  } | null;
}

type FilterTab = "all" | "outbound" | "replies" | "failed";

function DirectionBadge({ direction }: { direction: string }) {
  const isOut = direction === "outbound";
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        background: isOut ? "rgba(232,168,56,0.1)" : "rgba(46,160,67,0.1)",
        color: isOut ? "var(--accent)" : "var(--state-active)",
        border: `1px solid ${isOut ? "rgba(232,168,56,0.25)" : "rgba(46,160,67,0.25)"}`,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {isOut ? "outbound" : "← reply"}
    </span>
  );
}

function StatusBadge({
  status,
  deliveryStatus,
  errorMessage,
  direction,
}: {
  status: MessageStatus;
  deliveryStatus: string | null;
  errorMessage: string | null;
  direction: string;
}) {
  // Inbound messages don't have a meaningful status in our system
  if (direction === "inbound") return null;

  // Prefer delivery_status = 'delivered' over status = 'sent' — more specific
  const display = deliveryStatus === "delivered" ? "delivered" : status;

  const styles: Record<string, React.CSSProperties> = {
    pending: { background: "var(--accent-light)", color: "var(--accent)", border: "1px solid rgba(232,168,56,0.25)" },
    sent: { background: "rgba(46,160,67,0.08)", color: "var(--state-active)", border: "1px solid rgba(46,160,67,0.2)" },
    delivered: { background: "rgba(46,160,67,0.15)", color: "var(--state-active)", border: "1px solid rgba(46,160,67,0.3)" },
    skipped: { background: "var(--bg-surface-2)", color: "var(--text-tertiary)", border: "1px solid var(--border)" },
    failed: { background: "rgba(207,34,46,0.08)", color: "var(--state-dormant)", border: "1px solid rgba(207,34,46,0.2)" },
    undelivered: { background: "rgba(212,129,58,0.08)", color: "var(--state-lapsing)", border: "1px solid rgba(212,129,58,0.2)" },
  };

  const labels: Record<string, string> = {
    pending: "queued",
    sent: "sent",
    delivered: "delivered",
    skipped: "skipped",
    failed: "failed",
    undelivered: "undelivered",
  };

  return (
    <span
      title={errorMessage ?? undefined}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        cursor: errorMessage ? "help" : "default",
        ...(styles[display] ?? styles.sent),
      }}
    >
      {labels[display] ?? display}
      {errorMessage && " ⚠"}
    </span>
  );
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "5px 12px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: active ? "var(--text-primary)" : "var(--bg-surface-2)",
  color: active ? "var(--bg-surface)" : "var(--text-secondary)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  cursor: "pointer",
  fontWeight: active ? 500 : 400,
  whiteSpace: "nowrap" as const,
});

export default function Messages() {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [clubName, setClubName] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);
  const [tab, setTab] = useState<FilterTab>("all");

  const fetchData = async () => {
    const [msgRes, clubRes] = await Promise.all([
      supabase
        .from("messages")
        .select(
          "id, body, direction, status, delivery_status, error_code, error_message, twilio_message_sid, link_clicked, link_clicked_at, sent_at, delivered_at, conversation_id, conversations!conversation_id(id, triggered_by, player_id, players!player_id(id, name))"
        )
        .order("id", { ascending: false })
        .limit(200),
      supabase.from("clubs").select("name").limit(1).maybeSingle(),
    ]);
    if (msgRes.data) setMessages(msgRes.data as MessageRow[]);
    if (clubRes.data?.name) setClubName(clubRes.data.name);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const filtered = messages.filter((m) => {
    if (tab === "outbound") return m.direction === "outbound";
    if (tab === "replies") return m.direction === "inbound";
    if (tab === "failed") return m.status === "failed" || m.status === "undelivered";
    return true;
  });

  const repliesCount = messages.filter((m) => m.direction === "inbound").length;
  const failedCount = messages.filter((m) => m.status === "failed" || m.status === "undelivered").length;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <Sidebar clubName={clubName} />
      <div style={{ marginLeft: 220, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <header style={{ height: 52, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)", position: "sticky", top: 0, zIndex: 5 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Messages</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
            {filtered.length} shown
          </span>
        </header>

        <main style={{ flex: 1, overflowY: "auto", padding: "20px 28px", background: "var(--bg-surface-2)" }}>
          {/* Filter tabs */}
          <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
            <button style={tabStyle(tab === "all")} onClick={() => setTab("all")}>All</button>
            <button style={tabStyle(tab === "outbound")} onClick={() => setTab("outbound")}>Outbound</button>
            <button style={tabStyle(tab === "replies")} onClick={() => setTab("replies")}>
              Replies {repliesCount > 0 && <span style={{ marginLeft: 4, background: "var(--state-active)", color: "#fff", borderRadius: 99, padding: "0px 5px", fontSize: 10 }}>{repliesCount}</span>}
            </button>
            <button style={tabStyle(tab === "failed")} onClick={() => setTab("failed")}>
              Failed {failedCount > 0 && <span style={{ marginLeft: 4, background: "var(--state-dormant)", color: "#fff", borderRadius: 99, padding: "0px 5px", fontSize: 10 }}>{failedCount}</span>}
            </button>
          </div>

          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "var(--bg-surface-2)" }}>
                    {["PLAYER", "MESSAGE", "DIRECTION", "STATUS", "LINK", "DATE"].map((h) => (
                      <th key={h} style={{ padding: "8px 16px", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)", borderBottom: "1px solid var(--border)", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>Loading…</td></tr>
                  ) : filtered.length === 0 ? (
                    <tr><td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>No messages yet</td></tr>
                  ) : (
                    filtered.map((m, i) => {
                      const player = m.conversations?.players;
                      const playerId = m.conversations?.player_id ?? player?.id ?? null;
                      const isReply = m.direction === "inbound";
                      const dateToShow = m.delivered_at ?? m.sent_at ?? null;
                      return (
                        <tr
                          key={m.id}
                          style={{
                            borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none",
                            background: isReply ? "rgba(46,160,67,0.02)" : "transparent",
                          }}
                        >
                          <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                            <span
                              onClick={() => playerId && setDrawerPlayerId(playerId)}
                              style={{ fontWeight: 500, fontSize: 13, cursor: playerId ? "pointer" : "default", color: playerId ? "var(--accent)" : "var(--text-primary)" }}
                              onMouseEnter={(e) => { if (playerId) (e.currentTarget as HTMLElement).style.textDecoration = "underline"; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; }}
                            >
                              {player?.name ?? "—"}
                            </span>
                          </td>
                          <td style={{ padding: "10px 16px", fontSize: 12, color: isReply ? "var(--text-primary)" : "var(--text-secondary)", fontStyle: isReply ? "normal" : "italic", maxWidth: 340 }}>
                            {m.body.length > 100 ? m.body.slice(0, 100) + "…" : m.body}
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <DirectionBadge direction={m.direction} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <StatusBadge status={m.status} deliveryStatus={m.delivery_status} errorMessage={m.error_message} direction={m.direction} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            {m.link_clicked ? (
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--state-active)" }}>clicked</span>
                            ) : (
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)" }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: "10px 16px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                            {dateToShow ? formatDate(dateToShow) : "—"}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>
      <PlayerDrawer playerId={drawerPlayerId} onClose={() => setDrawerPlayerId(null)} />
    </div>
  );
}
