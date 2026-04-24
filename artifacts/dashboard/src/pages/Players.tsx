import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { PlayerDrawer } from "@/components/PlayerDrawer";
import { getEngagementState, relativeTime, toTitleCase, STATE_COLORS, STATE_BG } from "@/lib/helpers";
import type { Player, EngagementState, ProgressionStatus } from "@/lib/types";

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

function ProgBadge({ status }: { status: ProgressionStatus }) {
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
      {toTitleCase(status ?? "unset")}
    </span>
  );
}

const ENGAGEMENT_OPTIONS: { label: string; value: string }[] = [
  { label: "All states", value: "" },
  { label: "Active", value: "active" },
  { label: "Lapsing", value: "lapsing" },
  { label: "Dormant", value: "dormant" },
];

const PROGRESSION_OPTIONS: { label: string; value: string }[] = [
  { label: "All progressions", value: "" },
  { label: "Unset", value: "null" },
  { label: "Ready to advance", value: "ready-to-advance" },
  { label: "Developing", value: "developing" },
  { label: "At ceiling", value: "at-ceiling" },
];

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  cursor: "pointer",
};

export default function Players() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [clubName, setClubName] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [engFilter, setEngFilter] = useState("");
  const [progFilter, setProgFilter] = useState("");
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);

  const fetchData = async () => {
    const [playersRes, clubRes] = await Promise.all([
      supabase
        .from("players")
        .select(
          "id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id"
        )
        .order("last_visit_date", { ascending: false, nullsFirst: false }),
      supabase.from("clubs").select("name").limit(1).maybeSingle(),
    ]);
    if (playersRes.data) setPlayers(playersRes.data as Player[]);
    if (clubRes.data?.name) setClubName(clubRes.data.name);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const displayed = players.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (engFilter) {
      const state = getEngagementState(p.last_visit_date);
      if (state !== engFilter) return false;
    }
    if (progFilter) {
      if (progFilter === "null" && p.progression_status !== null) return false;
      if (progFilter !== "null" && p.progression_status !== progFilter) return false;
    }
    return true;
  });

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
          <span style={{ fontWeight: 600, fontSize: 14 }}>Players</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-tertiary)",
            }}
          >
            {displayed.length} of {players.length}
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
          {/* Filters */}
          <div
            style={{
              display: "flex",
              gap: 10,
              marginBottom: 16,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <input
              type="text"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                ...selectStyle,
                width: 200,
                outline: "none",
              }}
            />
            <select
              value={engFilter}
              onChange={(e) => setEngFilter(e.target.value)}
              style={selectStyle}
            >
              {ENGAGEMENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              value={progFilter}
              onChange={(e) => setProgFilter(e.target.value)}
              style={selectStyle}
            >
              {PROGRESSION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {(search || engFilter || progFilter) && (
              <button
                onClick={() => {
                  setSearch("");
                  setEngFilter("");
                  setProgFilter("");
                }}
                style={{
                  ...selectStyle,
                  color: "var(--text-tertiary)",
                  cursor: "pointer",
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Table */}
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
                      "STATE",
                      "PROGRESSION",
                      "SKILL LEVEL",
                      "LAST VISIT",
                      "MEMBERSHIP",
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
                  ) : displayed.length === 0 ? (
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
                        No players match your filters
                      </td>
                    </tr>
                  ) : (
                    displayed.map((p, i) => {
                      const state = getEngagementState(p.last_visit_date);
                      return (
                        <tr
                          key={p.id}
                          onClick={() => setDrawerPlayerId(p.id)}
                          style={{
                            borderBottom:
                              i < displayed.length - 1
                                ? "1px solid var(--border)"
                                : "none",
                            cursor: "pointer",
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
                          <td style={{ padding: "10px 16px" }}>
                            <div style={{ fontWeight: 500, fontSize: 13 }}>
                              {p.name}
                            </div>
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <StatePill state={state} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <ProgBadge status={p.progression_status} />
                          </td>
                          <td
                            style={{
                              padding: "10px 16px",
                              fontSize: 12,
                              color: "var(--text-secondary)",
                            }}
                          >
                            {p.skill_level ? toTitleCase(p.skill_level) : "—"}
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
                          <td
                            style={{
                              padding: "10px 16px",
                              fontSize: 12,
                              color: "var(--text-secondary)",
                            }}
                          >
                            {p.membership_status ? toTitleCase(p.membership_status) : "—"}
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
        onDataChanged={fetchData}
      />
    </div>
  );
}
