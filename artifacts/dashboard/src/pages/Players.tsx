import { useEffect, useState, useMemo } from "react";
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

type SortCol = "name" | "state" | "progression" | "lastVisit" | "skill" | "membership";
type SortDir = "asc" | "desc";

const STATE_SORT_ORDER: Record<EngagementState, number> = {
  dormant: 0,
  lapsing: 1,
  active: 2,
  "never-visited": 3,
};

const PROG_SORT_ORDER: Record<string, number> = {
  null: 0,
  "ready-to-advance": 1,
  developing: 2,
  "at-ceiling": 3,
};

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  cursor: "pointer",
  outline: "none",
};

function SortTh({
  label,
  col,
  sortCol,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortCol;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
}) {
  const active = sortCol === col;
  return (
    <th
      onClick={() => onSort(col)}
      style={{
        padding: "8px 16px",
        textAlign: "left",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 500,
        color: active ? "var(--accent)" : "var(--text-tertiary)",
        borderBottom: "1px solid var(--border)",
        letterSpacing: "0.05em",
        whiteSpace: "nowrap",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {label} {active ? (sortDir === "asc" ? "↑" : "↓") : ""}
    </th>
  );
}

export default function Players() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [clubName, setClubName] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [engFilter, setEngFilter] = useState("");
  const [progFilter, setProgFilter] = useState("");
  const [memberFilter, setMemberFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("state");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);

  const fetchData = async () => {
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
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const hasFilters = search || engFilter || progFilter || memberFilter;

  const displayed = useMemo(() => {
    let list = [...players];

    if (search) list = list.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
    if (engFilter) {
      list = list.filter((p) => getEngagementState(p.last_visit_date) === engFilter);
    }
    if (progFilter) {
      list = list.filter((p) =>
        progFilter === "null" ? p.progression_status === null : p.progression_status === progFilter
      );
    }
    if (memberFilter === "member") list = list.filter((p) => p.membership_status === "member");
    if (memberFilter === "non-member") list = list.filter((p) => p.membership_status !== "member");

    list.sort((a, b) => {
      let cmp = 0;
      if (sortCol === "name") {
        cmp = a.name.localeCompare(b.name);
      } else if (sortCol === "state") {
        cmp = STATE_SORT_ORDER[getEngagementState(a.last_visit_date)] - STATE_SORT_ORDER[getEngagementState(b.last_visit_date)];
      } else if (sortCol === "progression") {
        const ak = a.progression_status ?? "null";
        const bk = b.progression_status ?? "null";
        cmp = (PROG_SORT_ORDER[ak] ?? 99) - (PROG_SORT_ORDER[bk] ?? 99);
      } else if (sortCol === "lastVisit") {
        const aNull = a.last_visit_date === null;
        const bNull = b.last_visit_date === null;
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;
        cmp = new Date(a.last_visit_date!).getTime() - new Date(b.last_visit_date!).getTime();
      } else if (sortCol === "skill") {
        cmp = (a.skill_level ?? "").localeCompare(b.skill_level ?? "");
      } else if (sortCol === "membership") {
        cmp = (a.membership_status ?? "").localeCompare(b.membership_status ?? "");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return list;
  }, [players, search, engFilter, progFilter, memberFilter, sortCol, sortDir]);

  const thProps = { sortCol, sortDir, onSort: handleSort };

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
              style={{ ...selectStyle, width: 200 }}
            />
            <select value={engFilter} onChange={(e) => setEngFilter(e.target.value)} style={selectStyle}>
              <option value="">All states</option>
              <option value="active">Active</option>
              <option value="lapsing">Lapsing</option>
              <option value="dormant">Dormant</option>
              <option value="never-visited">Never Visited</option>
            </select>
            <select value={progFilter} onChange={(e) => setProgFilter(e.target.value)} style={selectStyle}>
              <option value="">All progressions</option>
              <option value="null">Unset</option>
              <option value="ready-to-advance">Ready to Advance</option>
              <option value="developing">Developing</option>
              <option value="at-ceiling">At Ceiling</option>
            </select>
            <select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} style={selectStyle}>
              <option value="">All members</option>
              <option value="member">Member</option>
              <option value="non-member">Non-member</option>
            </select>
            {hasFilters && (
              <button
                onClick={() => {
                  setSearch("");
                  setEngFilter("");
                  setProgFilter("");
                  setMemberFilter("");
                }}
                style={{ ...selectStyle, color: "var(--text-tertiary)" }}
              >
                Clear filters
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
                    <SortTh label="PLAYER" col="name" {...thProps} />
                    <SortTh label="STATE" col="state" {...thProps} />
                    <SortTh label="PROGRESSION" col="progression" {...thProps} />
                    <SortTh label="SKILL LEVEL" col="skill" {...thProps} />
                    <SortTh label="LAST VISIT" col="lastVisit" {...thProps} />
                    <SortTh label="MEMBERSHIP" col="membership" {...thProps} />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
                        Loading…
                      </td>
                    </tr>
                  ) : displayed.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
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
                            borderBottom: i < displayed.length - 1 ? "1px solid var(--border)" : "none",
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) =>
                            ((e.currentTarget as HTMLElement).style.background = "var(--bg-surface-2)")
                          }
                          onMouseLeave={(e) =>
                            ((e.currentTarget as HTMLElement).style.background = "transparent")
                          }
                        >
                          <td style={{ padding: "10px 16px" }}>
                            <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <StatePill state={state} />
                          </td>
                          <td style={{ padding: "10px 16px" }}>
                            <ProgBadge status={p.progression_status} />
                          </td>
                          <td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-secondary)" }}>
                            {p.skill_level ? toTitleCase(p.skill_level) : "—"}
                          </td>
                          <td style={{ padding: "10px 16px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                            {relativeTime(p.last_visit_date)}
                          </td>
                          <td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-secondary)" }}>
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
