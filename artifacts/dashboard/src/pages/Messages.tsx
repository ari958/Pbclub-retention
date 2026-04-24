import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { PlayerDrawer } from "@/components/PlayerDrawer";
import { formatDate } from "@/lib/helpers";

interface MessageRow {
  id: string;
  body: string;
  direction: string;
  twilio_message_sid: string | null;
  link_clicked: boolean | null;
  link_clicked_at: string | null;
  conversation_id: string;
  conversations: {
    id: string;
    triggered_by: string | null;
    player_id: string | null;
    players: {
      id: string;
      name: string;
    } | null;
  } | null;
}

function DirectionBadge({ direction }: { direction: string }) {
  const isOut = direction === "outbound";
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        background: isOut
          ? "rgba(232,168,56,0.1)"
          : "rgba(46,160,67,0.1)",
        color: isOut ? "var(--accent)" : "var(--state-active)",
        border: `1px solid ${isOut ? "rgba(232,168,56,0.25)" : "rgba(46,160,67,0.25)"}`,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {direction}
    </span>
  );
}

function StatusBadge({ sid }: { sid: string | null }) {
  if (!sid) return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        background: "var(--accent-light)",
        color: "var(--accent)",
        border: "1px solid rgba(232,168,56,0.25)",
      }}
    >
      queued
    </span>
  );
  if (sid === "skipped") return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        background: "var(--bg-surface-2)",
        color: "var(--text-tertiary)",
        border: "1px solid var(--border)",
      }}
    >
      skipped
    </span>
  );
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "2px 6px",
        borderRadius: 3,
        background: "rgba(46,160,67,0.08)",
        color: "var(--state-active)",
        border: "1px solid rgba(46,160,67,0.2)",
      }}
    >
      sent
    </span>
  );
}

export default function Messages() {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [clubName, setClubName] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);

  const fetchData = async () => {
    const [msgRes, clubRes] = await Promise.all([
      supabase
        .from("messages")
        .select(
          "id, body, direction, twilio_message_sid, link_clicked, link_clicked_at, conversation_id, conversations!conversation_id(id, triggered_by, player_id, players!player_id(id, name))"
        )
        .order("id", { ascending: false })
        .limit(100),
      supabase.from("clubs").select("name").limit(1).maybeSingle(),
    ]);
    if (msgRes.data) setMessages(msgRes.data as MessageRow[]);
    if (clubRes.data?.name) setClubName(clubRes.data.name);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

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
          <span style={{ fontWeight: 600, fontSize: 14 }}>Messages</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-tertiary)",
            }}
          >
            {messages.length} shown
          </span>
        </header>

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px 28px",
            background: "var(--bg-surface-2)",
          }}
        >
          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "var(--bg-surface-2)" }}>
                    {[
                      "PLAYER",
                      "MESSAGE",
                      "DIRECTION",
                      "STATUS",
                      "LINK",
                      "DATE",
                    ].map((h) => (
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
                  {loading ? (
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          padding: "32px 16px",
                          textAlign: "center",
                          color: "var(--text-tertiary)",
                          fontSize: 13,
                        }}
                      >
                        Loading…
                      </td>
                    </tr>
                  ) : messages.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          padding: "32px 16px",
                          textAlign: "center",
                          color: "var(--text-tertiary)",
                          fontSize: 13,
                        }}
                      >
                        No messages yet
                      </td>
                    </tr>
                  ) : (
                    messages.map((m, i) => {
                      const player = m.conversations?.players;
                      const playerId =
                        m.conversations?.player_id ?? player?.id ?? null;
                      return (
                        <tr
                          key={m.id}
                          style={{
                            borderBottom:
                              i < messages.length - 1
                                ? "1px solid var(--border)"
                                : "none",
                          }}
                        >
                          <td
                            style={{
                              padding: "10px 16px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span
                              onClick={() =>
                                playerId && setDrawerPlayerId(playerId)
                              }
                              style={{
                                fontWeight: 500,
                                fontSize: 13,
                                cursor: playerId ? "pointer" : "default",
                                color: playerId
                                  ? "var(--accent)"
                                  : "var(--text-primary)",
                              }}
                              onMouseEnter={(e) => {
                                if (playerId)
                                  (
                                    e.currentTarget as HTMLElement
                                  ).style.textDecoration = "underline";
                              }}
                              onMouseLeave={(e) => {
                                (
                                  e.currentTarget as HTMLElement
                                ).style.textDecoration = "none";
                              }}
                            >
                              {player?.name ?? "—"}
                            </span>
                          </td>
                          <td
                            style={{
                              padding: "10px 16px",
                              fontSize: 12,
                              color: "var(--text-secondary)",
                              fontStyle: "italic",
                              maxWidth: 340,
                            }}
                          >
                            {m.body.length > 100
                              ? m.body.slice(0, 100) + "…"
                              : m.body}
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <DirectionBadge direction={m.direction} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <StatusBadge sid={m.twilio_message_sid} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            {m.link_clicked ? (
                              <span
                                style={{
                                  fontFamily: "var(--font-mono)",
                                  fontSize: 10,
                                  color: "var(--state-active)",
                                }}
                              >
                                clicked
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontFamily: "var(--font-mono)",
                                  fontSize: 10,
                                  color: "var(--text-tertiary)",
                                }}
                              >
                                —
                              </span>
                            )}
                          </td>
                          <td
                            style={{
                              padding: "10px 16px",
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              color: "var(--text-tertiary)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {m.link_clicked_at
                              ? formatDate(m.link_clicked_at)
                              : "—"}
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

      <PlayerDrawer
        playerId={drawerPlayerId}
        onClose={() => setDrawerPlayerId(null)}
      />
    </div>
  );
}
