import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { PlayerDrawer } from "@/components/PlayerDrawer";
import { BulkMessageModal } from "@/components/BulkMessageModal";
import {
  getEngagementState,
  relativeTime,
  toTitleCase,
  STATE_COLORS,
  STATE_BG,
  dateOnlyMs,
} from "@/lib/helpers";
import type { Player, EngagementState, ProgressionStatus } from "@/lib/types";

const PAGE_SIZE = 50;

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
} as const;

const STATE_DISPLAY: Record<EngagementState, string> = {
  active: "Active",
  lapsing: "Drifting",
  dormant: "Inactive",
  "never-visited": "Never Visited",
};

const PROG_DISPLAY: Record<string, string> = {
  "ready-to-advance": "Move Up a Level",
  developing: "Still Developing",
  "at-ceiling": "At Their Level",
};

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
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: STATE_COLORS[state], flexShrink: 0 }} />
      {STATE_DISPLAY[state]}
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
        background: isUnset ? D.accentBg : D.inner,
        color: isUnset ? D.accent : D.muted,
        border: `1px solid ${isUnset ? "rgba(232,168,56,0.25)" : D.border}`,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {status === null ? "Needs Attention" : (PROG_DISPLAY[status] ?? toTitleCase(status))}
    </span>
  );
}

function Chip({
  label,
  active,
  onClick,
  dot,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: string;
}) {
  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 10px",
        borderRadius: 16,
        fontSize: 11,
        fontWeight: 500,
        cursor: "pointer",
        border: `1px solid ${active ? D.accent : D.border}`,
        background: active ? D.accentBg : D.inner,
        color: active ? D.accent : D.muted,
        transition: "all 0.1s",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flexShrink: 0 }} />}
      {label}
    </span>
  );
}

function SortTh({
  label,
  col,
  sortCol,
  sortDir,
  onSort,
  minWidth,
}: {
  label: string;
  col: SortCol;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
  minWidth?: number;
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
        color: active ? D.accent : D.faint,
        borderBottom: `1px solid ${D.border}`,
        letterSpacing: "0.05em",
        whiteSpace: "nowrap",
        cursor: "pointer",
        userSelect: "none",
        minWidth: minWidth ?? undefined,
        background: D.inner,
      }}
    >
      {label}{" "}
      {active ? (
        <span style={{ color: D.accent }}>{sortDir === "asc" ? "↑" : "↓"}</span>
      ) : (
        <span style={{ color: D.border, fontSize: 9 }}>↕</span>
      )}
    </th>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="skeleton-row" style={{ borderBottom: `1px solid ${D.border}` }}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} style={{ padding: "12px 16px" }}>
              <div className="skeleton-bar" style={{ width: j === 0 ? 140 : j === cols - 1 ? 60 : 90, height: 11 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function Players() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [clubName, setClubName] = useState("");
  const [clubId, setClubId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [misfitPlayerIds, setMisfitPlayerIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [engFilter, setEngFilter] = useState("");
  const [progFilter, setProgFilter] = useState("");
  const [memberFilter, setMemberFilter] = useState("");
  const [misfitFilter, setMisfitFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("state");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  const fetchData = async () => {
    const clubRes = await supabase.from("clubs").select("id, name").limit(1).maybeSingle();
    if (clubRes.data?.name) setClubName(clubRes.data.name);
    if (clubRes.data?.id) setClubId(clubRes.data.id);

    const allPlayers: Player[] = [];
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from("players")
        .select(
          "id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id, sms_opt_in, dupr_rating"
        )
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      allPlayers.push(...(data as Player[]));
      if (data.length < 1000) break;
      offset += 1000;
    }
    setPlayers(allPlayers);
    setLoading(false);

    const { data: misfitRows } = await supabase
      .from("session_feedback")
      .select("player_id")
      .eq("self_fit", 0);
    const counts = new Map<string, number>();
    for (const row of (misfitRows ?? []) as { player_id: string }[]) {
      counts.set(row.player_id, (counts.get(row.player_id) ?? 0) + 1);
    }
    const ids = new Set<string>();
    for (const [id, count] of counts) {
      if (count >= 2) ids.add(id);
    }
    setMisfitPlayerIds(ids);
  };

  useEffect(() => { fetchData(); }, []);

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
    setPage(1);
  };

  useEffect(() => { setPage(1); }, [search, engFilter, progFilter, memberFilter, misfitFilter]);

  const hasFilters = search || engFilter || progFilter || memberFilter || misfitFilter;

  const clearFilters = () => {
    setSearch("");
    setEngFilter("");
    setProgFilter("");
    setMemberFilter("");
    setMisfitFilter("");
    setPage(1);
  };

  const displayed = useMemo(() => {
    let list = [...players];
    if (search) list = list.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
    if (engFilter) list = list.filter((p) => getEngagementState(p.last_visit_date) === engFilter);
    if (progFilter) {
      list = list.filter((p) =>
        progFilter === "null" ? p.progression_status === null : p.progression_status === progFilter
      );
    }
    if (memberFilter === "member") list = list.filter((p) => p.membership_status === "member");
    if (memberFilter === "non-member") list = list.filter((p) => p.membership_status !== "member");
    if (misfitFilter === "misfit") list = list.filter((p) => misfitPlayerIds.has(p.id));

    list.sort((a, b) => {
      let cmp = 0;
      if (sortCol === "name") {
        cmp = a.name.localeCompare(b.name);
      } else if (sortCol === "state") {
        cmp =
          STATE_SORT_ORDER[getEngagementState(a.last_visit_date)] -
          STATE_SORT_ORDER[getEngagementState(b.last_visit_date)];
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
        cmp = dateOnlyMs(a.last_visit_date!) - dateOnlyMs(b.last_visit_date!);
      } else if (sortCol === "skill") {
        cmp = (a.skill_level ?? "").localeCompare(b.skill_level ?? "");
      } else if (sortCol === "membership") {
        cmp = (a.membership_status ?? "").localeCompare(b.membership_status ?? "");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return list;
  }, [players, search, engFilter, progFilter, memberFilter, misfitFilter, misfitPlayerIds, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(displayed.length / PAGE_SIZE));
  const paginated = displayed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const exportCSV = () => {
    const headers = ["Name", "Phone", "Membership", "Engagement State", "Progression", "Last Visit"];
    const rows = displayed.map((p) => [
      p.name,
      p.phone ?? "",
      p.membership_status ?? "",
      getEngagementState(p.last_visit_date),
      p.progression_status ?? "",
      p.last_visit_date ?? "",
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `players-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const thProps = { sortCol, sortDir, onSort: handleSort };

  const filterSummary = useMemo(() => {
    const parts: string[] = [`${displayed.length} recipients`];
    if (engFilter) parts.push(STATE_DISPLAY[engFilter as EngagementState] ?? toTitleCase(engFilter));
    if (memberFilter === "member") parts.push("Member");
    if (memberFilter === "non-member") parts.push("Non-member");
    if (progFilter === "null") parts.push("Needs Attention");
    else if (progFilter) parts.push(PROG_DISPLAY[progFilter] ?? toTitleCase(progFilter));
    if (search) parts.push(`"${search}"`);
    return parts.join(" · ");
  }, [displayed.length, engFilter, memberFilter, progFilter, search]);

  const btnStyle = (variant: "default" | "accent" = "default"): React.CSSProperties => ({
    padding: "6px 14px",
    borderRadius: 5,
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    border: `1px solid ${variant === "accent" ? D.accent : D.border}`,
    background: variant === "accent" ? D.accent : D.inner,
    color: variant === "accent" ? "#fff" : D.muted,
    fontFamily: "var(--font-sans)",
    whiteSpace: "nowrap" as const,
  });

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
          <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>Players</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: D.faint }}>
            {loading ? "…" : `Showing ${displayed.length} of ${players.length}`}
          </span>
        </header>

        <main style={{ flex: 1, overflowY: "auto", padding: "20px 28px", background: D.bg }}>
          {/* ── Toolbar ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
            {/* Top row: search + actions */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                placeholder="Search players…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  flex: "1 1 200px",
                  maxWidth: 280,
                  padding: "7px 12px",
                  borderRadius: 5,
                  border: `1px solid ${D.border}`,
                  background: D.card,
                  color: D.text,
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  outline: "none",
                }}
              />
              {hasFilters && (
                <button onClick={clearFilters} style={{ ...btnStyle(), color: D.accent, borderColor: "rgba(232,168,56,0.3)" }}>
                  Clear filters
                </button>
              )}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button onClick={exportCSV} style={btnStyle()}>Export CSV</button>
                <button onClick={() => setBulkModalOpen(true)} style={btnStyle("accent")}>
                  Message All ({displayed.length})
                </button>
              </div>
            </div>

            {/* Status chips */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: D.faint, letterSpacing: "0.05em", textTransform: "uppercase", marginRight: 2 }}>Status</span>
              <Chip label="All" active={!engFilter && !misfitFilter} onClick={() => { setEngFilter(""); setMisfitFilter(""); }} />
              <Chip label="Active" active={engFilter === "active"} dot={STATE_COLORS.active} onClick={() => { setEngFilter("active"); setMisfitFilter(""); }} />
              <Chip label="Drifting" active={engFilter === "lapsing"} dot={STATE_COLORS.lapsing} onClick={() => { setEngFilter("lapsing"); setMisfitFilter(""); }} />
              <Chip label="Inactive" active={engFilter === "dormant"} dot={STATE_COLORS.dormant} onClick={() => { setEngFilter("dormant"); setMisfitFilter(""); }} />
              <Chip label="Never Visited" active={engFilter === "never-visited"} onClick={() => { setEngFilter("never-visited"); setMisfitFilter(""); }} />
              <Chip label="Level Concern" active={misfitFilter === "misfit"} onClick={() => { setMisfitFilter("misfit"); setEngFilter(""); }} />
            </div>

            {/* Progress chips */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: D.faint, letterSpacing: "0.05em", textTransform: "uppercase", marginRight: 2 }}>Progress</span>
              <Chip label="All" active={!progFilter} onClick={() => setProgFilter("")} />
              <Chip label="Needs Attention" active={progFilter === "null"} onClick={() => setProgFilter("null")} />
              <Chip label="Move Up a Level" active={progFilter === "ready-to-advance"} onClick={() => setProgFilter("ready-to-advance")} />
              <Chip label="Still Developing" active={progFilter === "developing"} onClick={() => setProgFilter("developing")} />
              <Chip label="At Their Level" active={progFilter === "at-ceiling"} onClick={() => setProgFilter("at-ceiling")} />
            </div>

            {/* Member chips */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: D.faint, letterSpacing: "0.05em", textTransform: "uppercase", marginRight: 2 }}>Member</span>
              <Chip label="All" active={!memberFilter} onClick={() => setMemberFilter("")} />
              <Chip label="Members" active={memberFilter === "member"} onClick={() => setMemberFilter("member")} />
              <Chip label="Non-members" active={memberFilter === "non-member"} onClick={() => setMemberFilter("non-member")} />
            </div>
          </div>

          {/* ── Table ── */}
          <div
            style={{
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <SortTh label="PLAYER" col="name" minWidth={160} {...thProps} />
                    <SortTh label="STATUS" col="state" minWidth={110} {...thProps} />
                    <SortTh label="PROGRESS" col="progression" minWidth={150} {...thProps} />
                    <SortTh label="SKILL" col="skill" minWidth={80} {...thProps} />
                    <SortTh label="LAST VISIT" col="lastVisit" minWidth={100} {...thProps} />
                    <SortTh label="MEMBER" col="membership" minWidth={80} {...thProps} />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <SkeletonRows cols={6} />
                  ) : paginated.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        style={{ padding: "40px 16px", textAlign: "center", color: D.faint, fontSize: 13 }}
                      >
                        {hasFilters ? "No players match these filters." : "No players found."}
                      </td>
                    </tr>
                  ) : (
                    paginated.map((p, i) => {
                      const state = getEngagementState(p.last_visit_date);
                      return (
                        <tr
                          key={p.id}
                          onClick={() => setDrawerPlayerId(p.id)}
                          style={{
                            borderBottom: i < paginated.length - 1 ? `1px solid ${D.border}` : "none",
                            cursor: "pointer",
                            borderLeft: `3px solid ${STATE_COLORS[state]}`,
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = D.inner; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                        >
                          <td
                            style={{
                              padding: "12px 16px",
                              fontWeight: 500,
                              fontSize: 13,
                              color: D.text,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              maxWidth: 200,
                            }}
                          >
                            {p.name}
                          </td>
                          <td style={{ padding: "12px 16px" }}>
                            <StatePill state={state} />
                          </td>
                          <td style={{ padding: "12px 16px" }}>
                            <ProgBadge status={p.progression_status} />
                          </td>
                          <td
                            style={{
                              padding: "12px 16px",
                              fontSize: 12,
                              color: D.muted,
                              fontFamily: "var(--font-mono)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {p.skill_level ?? "—"}
                          </td>
                          <td
                            style={{
                              padding: "12px 16px",
                              fontSize: 12,
                              color: D.muted,
                              fontFamily: "var(--font-mono)",
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {relativeTime(p.last_visit_date)}
                          </td>
                          <td
                            style={{
                              padding: "12px 16px",
                              fontSize: 12,
                              color: D.muted,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
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

            {!loading && displayed.length > PAGE_SIZE && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 16px",
                  borderTop: `1px solid ${D.border}`,
                  background: D.inner,
                }}
              >
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 5,
                    border: `1px solid ${D.border}`,
                    background: D.card,
                    color: D.muted,
                    fontFamily: "var(--font-sans)",
                    fontSize: 12,
                    cursor: page === 1 ? "not-allowed" : "pointer",
                    opacity: page === 1 ? 0.4 : 1,
                  }}
                >
                  ← Previous
                </button>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: D.faint, fontVariantNumeric: "tabular-nums" }}>
                  Page {page} of {totalPages} · {displayed.length} players
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 5,
                    border: `1px solid ${D.border}`,
                    background: D.card,
                    color: D.muted,
                    fontFamily: "var(--font-sans)",
                    fontSize: 12,
                    cursor: page === totalPages ? "not-allowed" : "pointer",
                    opacity: page === totalPages ? 0.4 : 1,
                  }}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </main>
      </div>

      <PlayerDrawer
        playerId={drawerPlayerId}
        clubId={clubId}
        onClose={() => setDrawerPlayerId(null)}
        onDataChanged={fetchData}
      />

      {bulkModalOpen && (
        <BulkMessageModal
          recipients={displayed}
          filterSummary={filterSummary}
          onClose={() => setBulkModalOpen(false)}
        />
      )}
    </div>
  );
}
