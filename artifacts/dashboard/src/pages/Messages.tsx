import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { PlayerDrawer } from "@/components/PlayerDrawer";
import type { MessageStatus } from "@/lib/types";

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

function safeDate(str: string | null): string {
  if (!str) return "—";
  const dt = new Date(str);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

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
        background: isOut ? D.accentBg : D.greenBg,
        color: isOut ? D.accent : D.green,
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
  if (direction === "inbound") return null;

  const display = deliveryStatus === "delivered" ? "delivered" : status;

  const styles: Record<string, React.CSSProperties> = {
    pending: { background: D.accentBg, color: D.accent, border: "1px solid rgba(232,168,56,0.25)" },
    sent: { background: D.greenBg, color: D.green, border: "1px solid rgba(46,160,67,0.2)" },
    delivered: { background: "rgba(46,160,67,0.15)", color: D.green, border: "1px solid rgba(46,160,67,0.3)" },
    skipped: { background: D.inner, color: D.faint, border: `1px solid ${D.border}` },
    failed: { background: D.redBg, color: D.redText, border: "1px solid rgba(207,34,46,0.2)" },
    undelivered: { background: D.orangeBg, color: D.orange, border: "1px solid rgba(212,129,58,0.2)" },
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

  const TAB_ITEMS: { key: FilterTab; label: string; count?: number; countColor?: string }[] = [
    { key: "all", label: "All" },
    { key: "outbound", label: "Outbound" },
    { key: "replies", label: "Replies", count: repliesCount, countColor: D.green },
    { key: "failed", label: "Failed", count: failedCount, countColor: D.redText },
  ];

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: D.bg }}>
      <Sidebar clubName={clubName} />
      <div style={{ marginLeft: 240, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <header
          style={{
            height: 52,
            minHeight: 52,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 28px",
            borderBottom: `1px solid ${D.border}`,
            background: D.card,
            position: "sticky",
            top: 0,
            zIndex: 5,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>Messages</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: D.faint }}>
            {filtered.length} shown
          </span>
        </header>

        <main style={{ flex: 1, overflowY: "auto", padding: "20px 28px", background: D.bg }}>
          {/* ── Underline tabs ── */}
          <div
            style={{
              display: "flex",
              gap: 0,
              marginBottom: 16,
              borderBottom: `1px solid ${D.border}`,
            }}
          >
            {TAB_ITEMS.map(({ key, label, count, countColor }) => {
              const active = tab === key;
              return (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  style={{
                    padding: "8px 16px",
                    background: "transparent",
                    border: "none",
                    borderBottom: active ? `2px solid ${D.accent}` : "2px solid transparent",
                    color: active ? D.text : D.muted,
                    fontFamily: "var(--font-sans)",
                    fontSize: 13,
                    fontWeight: active ? 500 : 400,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: -1,
                    whiteSpace: "nowrap",
                    transition: "color 0.1s",
                  }}
                >
                  {label}
                  {count != null && count > 0 && (
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: "var(--font-mono)",
                        padding: "1px 5px",
                        borderRadius: 99,
                        background: active ? "rgba(232,168,56,0.15)" : D.inner,
                        color: active ? D.accent : (countColor ?? D.muted),
                        border: `1px solid ${D.border}`,
                        fontWeight: 600,
                      }}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* ── Table ── */}
          <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: D.inner }}>
                    {["PLAYER", "MESSAGE", "DIRECTION", "STATUS", "LINK", "DATE"].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "8px 16px",
                          textAlign: "left",
                          fontFamily: "var(--font-mono)",
                          fontSize: 10,
                          fontWeight: 500,
                          color: D.faint,
                          borderBottom: `1px solid ${D.border}`,
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
                  {loading ? (
                    <tr>
                      <td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: D.faint, fontSize: 13 }}>
                        Loading…
                      </td>
                    </tr>
                  ) : filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: D.faint, fontSize: 13 }}>
                        No messages yet
                      </td>
                    </tr>
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
                            borderBottom: i < filtered.length - 1 ? `1px solid ${D.border}` : "none",
                            background: isReply ? "rgba(46,160,67,0.03)" : "transparent",
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = D.inner; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = isReply ? "rgba(46,160,67,0.03)" : "transparent"; }}
                        >
                          <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                            <span
                              onClick={() => playerId && setDrawerPlayerId(playerId)}
                              style={{
                                fontWeight: 500,
                                fontSize: 13,
                                cursor: playerId ? "pointer" : "default",
                                color: playerId ? D.accent : D.text,
                              }}
                              onMouseEnter={(e) => { if (playerId) (e.currentTarget as HTMLElement).style.textDecoration = "underline"; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; }}
                            >
                              {player?.name ?? "—"}
                            </span>
                          </td>
                          <td
                            style={{
                              padding: "10px 16px",
                              fontSize: 12,
                              color: isReply ? D.text : D.muted,
                              fontStyle: isReply ? "normal" : "italic",
                              maxWidth: 340,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {m.body.length > 100 ? m.body.slice(0, 100) + "…" : m.body}
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <DirectionBadge direction={m.direction} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <StatusBadge
                              status={m.status}
                              deliveryStatus={m.delivery_status}
                              errorMessage={m.error_message}
                              direction={m.direction}
                            />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            {m.link_clicked ? (
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: D.green }}>clicked</span>
                            ) : (
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: D.faint }}>—</span>
                            )}
                          </td>
                          <td style={{ padding: "10px 16px", fontFamily: "var(--font-mono)", fontSize: 11, color: D.faint, whiteSpace: "nowrap" }}>
                            {safeDate(dateToShow)}
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
