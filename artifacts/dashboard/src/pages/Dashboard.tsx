import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/components/Toast";
import { Sidebar } from "@/components/Sidebar";
import { PlayerDrawer } from "@/components/PlayerDrawer";
import {
  getEngagementState,
  relativeTime,
  toTitleCase,
  STATE_COLORS,
  STATE_BG,
  dateOnlyMs,
} from "@/lib/helpers";
import type { EngagementState, ProgressionStatus, Player, MessageQueueItem } from "@/lib/types";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getCooldownLabel(lastOutboundAt: string | null): string | null {
  if (!lastOutboundAt) return null;
  const elapsed = Date.now() - new Date(lastOutboundAt).getTime();
  const remaining = COOLDOWN_MS - elapsed;
  if (remaining <= 0) return null;
  const hours = Math.floor(remaining / 3600000);
  const mins = Math.ceil((remaining % 3600000) / 60000);
  return hours > 0 ? `${hours}h ${mins}m cooldown` : `${mins}m cooldown`;
}

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
      {toTitleCase(status ?? "unset")}
    </span>
  );
}

function ActionBtn({
  label,
  variant = "default",
  onClick,
  disabled,
  title,
}: {
  label: string;
  variant?: "default" | "primary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
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
      title={title}
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
  { label: "Ready to Advance", value: "ready-to-advance" },
  { label: "Developing", value: "developing" },
  { label: "At Ceiling", value: "at-ceiling" },
  { label: "Unset", value: null },
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
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const select = async (val: ProgressionStatus) => {
    setSaving(true);
    setOpen(false);
    await supabase.from("players").update({ progression_status: val }).eq("id", playerId);
    setSaving(false);
    onUpdate();
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <div
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
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
              onClick={(e) => { e.stopPropagation(); select(opt.value); }}
              style={{
                padding: "7px 12px",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                color: opt.value === status ? "var(--accent)" : "var(--text-primary)",
                background: "transparent",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--bg-surface-2)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
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

type SortCol = "name" | "state" | "progression" | "lastVisit";
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

const filterSelectStyle: React.CSSProperties = {
  padding: "5px 9px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg-surface-2)",
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
  style,
}: {
  label: string;
  col: SortCol;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
  style?: React.CSSProperties;
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
        ...style,
      }}
    >
      {label} {active ? (sortDir === "asc" ? "↑" : "↓") : ""}
    </th>
  );
}

const STATE_ROW_BORDER: Record<EngagementState, string> = {
  dormant: "var(--state-dormant)",
  lapsing: "var(--state-lapsing)",
  active: "var(--state-active)",
  "never-visited": "var(--text-tertiary)",
};

const AMBER_HOVER = "rgba(232,168,56,0.06)";

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="skeleton-row" style={{ borderBottom: "1px solid var(--border)" }}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} style={{ padding: "12px 16px" }}>
              <div className="skeleton-bar" style={{ width: j === 0 ? 120 : j === cols - 1 ? 60 : 80, height: 11 }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function AtRiskPanel({
  players,
  loading,
  filterState,
  onFilterStateChange,
  onRunAgent,
  onRowClick,
  onProgressionChange,
}: {
  players: Player[];
  loading: boolean;
  filterState: EngagementState | null;
  onFilterStateChange: (s: EngagementState | null) => void;
  onRunAgent: (playerId: string) => Promise<void>;
  onRowClick: (playerId: string) => void;
  onProgressionChange: () => void;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [engFilter, setEngFilter] = useState<EngagementState | null>(filterState);
  const [progFilter, setProgFilter] = useState("");
  const [memberFilter, setMemberFilter] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("state");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => { setEngFilter(filterState); }, [filterState]);

  const handleRun = async (playerId: string) => {
    setRunning(playerId);
    try { await onRunAgent(playerId); } finally { setRunning(null); }
  };

  const handleEngChange = (val: string) => {
    const v = val === "" ? null : (val as EngagementState);
    setEngFilter(v);
    onFilterStateChange(v);
  };

  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const clearFilters = () => {
    setSearch(""); setEngFilter(null); setProgFilter(""); setMemberFilter("");
    setSortCol("state"); setSortDir("asc"); onFilterStateChange(null);
  };

  const hasFilters = search || engFilter || progFilter || memberFilter;

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

    list.sort((a, b) => {
      let cmp = 0;
      if (sortCol === "name") cmp = a.name.localeCompare(b.name);
      else if (sortCol === "state") cmp = STATE_SORT_ORDER[getEngagementState(a.last_visit_date)] - STATE_SORT_ORDER[getEngagementState(b.last_visit_date)];
      else if (sortCol === "progression") {
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
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [players, search, engFilter, progFilter, memberFilter, sortCol, sortDir]);

  const thProps = { sortCol, sortDir, onSort: handleSort };

  return (
    <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Players</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
          {loading ? "…" : `Showing ${displayed.length} of ${players.length}`}
        </span>
      </div>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "var(--bg-surface-2)" }}>
        <input type="text" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...filterSelectStyle, width: 160 }} />
        <select value={engFilter ?? ""} onChange={(e) => handleEngChange(e.target.value)} style={filterSelectStyle}>
          <option value="">All states</option>
          <option value="active">Active</option>
          <option value="lapsing">Lapsing</option>
          <option value="dormant">Dormant</option>
          <option value="never-visited">Never Visited</option>
        </select>
        <select value={progFilter} onChange={(e) => setProgFilter(e.target.value)} style={filterSelectStyle}>
          <option value="">All progressions</option>
          <option value="null">Unset</option>
          <option value="developing">Developing</option>
          <option value="ready-to-advance">Ready to Advance</option>
          <option value="at-ceiling">At Ceiling</option>
        </select>
        <select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} style={filterSelectStyle}>
          <option value="">All members</option>
          <option value="member">Member</option>
          <option value="non-member">Non-member</option>
        </select>
        {hasFilters && (
          <button onClick={clearFilters} style={{ ...filterSelectStyle, color: "var(--text-tertiary)" }}>
            Clear filters
          </button>
        )}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-surface-2)" }}>
              <SortTh label="PLAYER" col="name" {...thProps} />
              <SortTh label="STATE" col="state" {...thProps} />
              <SortTh label="PROGRESSION" col="progression" {...thProps} />
              <SortTh label="LAST VISIT" col="lastVisit" {...thProps} />
              <th style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)" }} />
            </tr>
          </thead>
          <tbody>
            {loading ? <SkeletonRows cols={5} /> : displayed.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
                  {hasFilters ? (
                    <span>No players match these filters{" "}
                      <button onClick={clearFilters} style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}>
                        Clear filters
                      </button>
                    </span>
                  ) : "No players yet"}
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
                    style={{ borderBottom: i < displayed.length - 1 ? "1px solid var(--border)" : "none", cursor: "pointer", transition: "background 0.1s" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = AMBER_HOVER)}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                  >
                    <td style={{ padding: "12px 16px", whiteSpace: "nowrap", borderLeft: `3px solid ${STATE_ROW_BORDER[state]}` }}>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                      {p.skill_level && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>{toTitleCase(p.skill_level)}</div>}
                    </td>
                    <td style={{ padding: "12px 16px" }}><StatePill state={state} /></td>
                    <td style={{ padding: "12px 16px" }}>
                      <ProgressionDropdown status={p.progression_status} playerId={p.id} onUpdate={onProgressionChange} />
                    </td>
                    <td style={{ padding: "12px 16px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {relativeTime(p.last_visit_date)}
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      <ActionBtn label={isRunning ? "Running…" : "Run Agent"} variant="default" disabled={isRunning} onClick={() => handleRun(p.id)} />
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

// ─── Staff Intro Panel ────────────────────────────────────────────────────────

const ET_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const ET_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
});

function visitLabel(visitCount: number): string {
  const n = visitCount + 1;
  if (n === 1) return "1st visit";
  if (n === 2) return "2nd visit";
  if (n === 3) return "3rd visit";
  return `${n}th visit`;
}

function StaffIntroPanel({ cards, loading }: { cards: any[]; loading: boolean }) {
  const totalNew = cards.reduce((sum, c) => sum + (c.new_players?.length ?? 0), 0);

  const grouped = new Map<string, any[]>();
  for (const card of cards) {
    const key = ET_DATE_FMT.format(new Date(card.start_time)).toUpperCase().replace(",", "");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(card);
  }

  return (
    <section style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Upcoming — New Players</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", background: "var(--bg-surface-2)", padding: "2px 8px", borderRadius: 3, border: "1px solid var(--border)" }}>
          {loading ? "…" : `${totalNew} new · 7d`}
        </span>
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
            Loading upcoming sessions…
          </div>
        ) : cards.length === 0 ? (
          <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
            No new players in the next 7 days
          </div>
        ) : (
          [...grouped.entries()].map(([dateLabel, dayCards]) => (
            <div key={dateLabel}>
              <div style={{ padding: "5px 16px", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)", letterSpacing: "0.07em", background: "var(--bg-surface-2)", borderBottom: "1px solid var(--border)" }}>
                {dateLabel}
              </div>
              {dayCards.map((card: any, ci: number) => (
                <div key={card.event_id} style={{ padding: "10px 16px", borderBottom: ci < dayCards.length - 1 || grouped.size > 1 ? "1px solid var(--border)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {card.program_name}
                    </span>
                    {card.level && (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, padding: "1px 6px", borderRadius: 3, background: "rgba(232,168,56,0.10)", color: "var(--accent)", border: "1px solid rgba(232,168,56,0.20)", flexShrink: 0 }}>
                        {card.level}
                      </span>
                    )}
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0 }}>
                      {ET_TIME_FMT.format(new Date(card.start_time))}
                    </span>
                  </div>
                  {(card.new_players ?? []).map((np: any, ni: number) => (
                    <div key={np.player_id} style={{ marginBottom: ni < card.new_players.length - 1 ? 8 : 0, paddingLeft: 2 }}>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>
                        {np.name}
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--accent)", background: "rgba(232,168,56,0.10)", border: "1px solid rgba(232,168,56,0.20)", borderRadius: 3, padding: "1px 5px", marginLeft: 6, verticalAlign: "middle" }}>
                          NEW
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                        {visitLabel(np.visit_count)}
                        {(np.buddy_connections ?? []).length > 0 && (
                          <span style={{ fontStyle: "italic", marginLeft: 6 }}>
                            · knows {(np.buddy_connections as any[]).slice(0, 2).map((b: any) => b.name.split(" ")[0]).join(" & ")} ({(np.buddy_connections as any[])[0].shared_sessions} sessions)
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ─── Needs Assessment Panel ───────────────────────────────────────────────────

function NeedsAssessmentPanel({ players, onUpdate }: { players: Player[]; onUpdate: () => void }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [checkmarks, setCheckmarks] = useState<Set<string>>(new Set());

  const updateProgression = async (playerId: string, status: string) => {
    setLoading(playerId + status);
    await supabase.from("players").update({ progression_status: status }).eq("id", playerId);
    setLoading(null);
    setCheckmarks((prev) => new Set([...prev, playerId]));
    setTimeout(() => {
      setCheckmarks((prev) => { const next = new Set(prev); next.delete(playerId); return next; });
      onUpdate();
    }, 600);
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
          <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>All players assessed ✓</div>
        ) : (
          players.map((p, i) => (
            <div key={p.id} style={{ padding: "12px 16px", borderBottom: i < players.length - 1 ? "1px solid var(--border)" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    {p.skill_level ? toTitleCase(p.skill_level) : "No skill level"} · {relativeTime(p.last_visit_date)}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
                {checkmarks.has(p.id) ? (
                  <span style={{ fontSize: 14, color: "var(--state-active)", fontWeight: 600 }}>✓</span>
                ) : (
                  <>
                    <ActionBtn label="Ready" variant="primary" disabled={loading === p.id + "ready-to-advance"} onClick={() => updateProgression(p.id, "ready-to-advance")} />
                    <ActionBtn label="Developing" disabled={loading === p.id + "developing"} onClick={() => updateProgression(p.id, "developing")} />
                    <ActionBtn label="Ceiling" disabled={loading === p.id + "at-ceiling"} onClick={() => updateProgression(p.id, "at-ceiling")} />
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
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.skipped) {
          toast.info(data.reason ?? "Message skipped");
        } else {
          toast.success("Message sent");
        }
      } else {
        if (data.unresolved_vars?.length) {
          toast.error(`Unresolved variables: ${data.unresolved_vars.join(", ")}`);
        } else {
          toast.error(data.error ?? "Send failed");
        }
      }
      onSent();
    } finally {
      setSending(null);
    }
  };

  const skipMessage = async (messageId: string) => {
    setSkipping(messageId);
    try {
      const res = await fetch("/api/messages/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: messageId }),
      });
      if (res.ok) {
        toast.info("Message skipped");
      } else {
        toast.error("Failed to skip message");
      }
      onSent();
    } finally {
      setSkipping(null);
    }
  };

  const startEdit = (messageId: string, body: string) => {
    setEditingId(messageId);
    setDraftBody(body);
  };

  const cancelEdit = () => { setEditingId(null); setDraftBody(""); };

  const saveEdit = async (messageId: string) => {
    setSaving(true);
    try {
      await supabase.from("messages").update({ body: draftBody }).eq("id", messageId);
      setEditingId(null);
      setDraftBody("");
      onSent();
    } finally {
      setSaving(false);
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
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        {messages.length === 0 ? (
          <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
            No messages queued. Run the agent to generate personalized outreach.
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
            const cooldownLabel = getCooldownLabel(player?.last_outbound_at ?? null);

            return (
              <div key={m.id} style={{ padding: "12px 16px", borderBottom: i < messages.length - 1 ? "1px solid var(--border)" : "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                  <span
                    onClick={() => playerId && onOpenPlayer(playerId)}
                    style={{ fontWeight: 500, fontSize: 13, cursor: playerId ? "pointer" : "default", color: playerId ? "var(--accent)" : "inherit", textDecoration: "none" }}
                    onMouseEnter={(e) => { if (playerId) (e.currentTarget as HTMLElement).style.textDecoration = "underline"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; }}
                  >
                    {player?.name ?? "Unknown"}
                  </span>
                  {routingTag && (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "var(--bg-surface-2)", color: "var(--text-tertiary)", border: "1px solid var(--border)" }}>
                      {routingTag}
                    </span>
                  )}
                  {cooldownLabel && (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "rgba(207,34,46,0.06)", color: "var(--state-dormant)", border: "1px solid rgba(207,34,46,0.15)" }}>
                      {cooldownLabel}
                    </span>
                  )}
                </div>

                {isEditing ? (
                  <textarea
                    value={draftBody}
                    onChange={(e) => setDraftBody(e.target.value)}
                    rows={4}
                    style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: 12, fontFamily: "var(--font-sans)", lineHeight: 1.5, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-surface-2)", color: "var(--text-primary)", resize: "vertical", outline: "none", marginBottom: 8 }}
                  />
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", fontStyle: "italic", lineHeight: 1.5, marginBottom: 10 }}>
                    {m.body.length > 120 ? m.body.slice(0, 120) + "…" : m.body}
                  </div>
                )}

                {isEditing ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <ActionBtn label={saving ? "Saving…" : "Save"} variant="primary" disabled={saving || draftBody.trim() === ""} onClick={() => saveEdit(m.id)} />
                    <ActionBtn label="Cancel" disabled={saving} onClick={cancelEdit} />
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <ActionBtn
                      label={isSending ? "Sending…" : "Send"}
                      variant="primary"
                      disabled={busy || !!cooldownLabel}
                      title={cooldownLabel ? `On cooldown — ${cooldownLabel}` : undefined}
                      onClick={() => sendMessage(m.id)}
                    />
                    <ActionBtn label="Edit" disabled={busy} onClick={() => startEdit(m.id, m.body)} />
                    <ActionBtn label={isSkipping ? "Skipping…" : "Skip"} variant="danger" disabled={busy} onClick={() => skipMessage(m.id)} />
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

// ─── Confirm Dialog ───────────────────────────────────────────────────────────

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <>
      <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 300 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 301, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "24px", maxWidth: 420, width: "calc(100% - 48px)", boxShadow: "0 8px 32px rgba(0,0,0,0.24)", fontFamily: "var(--font-sans)" }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.65, marginBottom: 20 }}>{message}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <ActionBtn label="Cancel" onClick={onCancel} />
          <ActionBtn label="Continue" variant="primary" onClick={onConfirm} />
        </div>
      </div>
    </>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();

  const [players, setPlayers] = useState<Player[]>([]);
  const [messages, setMessages] = useState<MessageQueueItem[]>([]);
  const [clubName, setClubName] = useState("");
  const [clubId, setClubId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [filterState, setFilterState] = useState<EngagementState | null>(null);
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [responseRate, setResponseRate] = useState<number | null>(null);
  const [winbackRate, setWinbackRate] = useState<number | null>(null);
  const [introCards, setIntroCards] = useState<any[]>([]);
  const [introCardsLoading, setIntroCardsLoading] = useState(true);

  const fetchMessages = useCallback(async () => {
    const res = await supabase
      .from("messages")
      .select(
        "id, body, signup_url, status, conversation_id, conversations!conversation_id(id, triggered_by, player_id, players!player_id(id, name, skill_level, progression_status, last_outbound_at))"
      )
      .eq("direction", "outbound")
      .eq("sent_by", "agent")
      .eq("status", "pending");
    if (res.data) setMessages(res.data as unknown as MessageQueueItem[]);
  }, []);

  const fetchData = useCallback(async () => {
    const [clubRes, outboundRes, inboundRes, winbackData] = await Promise.all([
      supabase.from("clubs").select("id, name").limit(1).maybeSingle(),
      supabase.from("messages").select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .eq("status", "sent")
        .gte("sent_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      supabase.from("messages").select("id", { count: "exact", head: true })
        .eq("direction", "inbound")
        .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      fetch("/api/players/winback-stats").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);

    const allPlayers: Player[] = [];
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from("players")
        .select("id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id, last_outbound_at")
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      allPlayers.push(...(data as Player[]));
      if (data.length < 1000) break;
      offset += 1000;
    }
    setPlayers(allPlayers);
    if (clubRes.data?.name) setClubName(clubRes.data.name);
    if (clubRes.data?.id) setClubId(clubRes.data.id);
    const outCount = outboundRes.count ?? 0;
    const inCount = inboundRes.count ?? 0;
    setResponseRate(outCount > 0 ? Math.round((inCount / outCount) * 100) : null);
    setWinbackRate(winbackData?.conversion_rate_pct ?? null);
    await fetchMessages();
    setLoading(false);
  }, [fetchMessages]);

  const runAgent = useCallback(async (playerId: string) => {
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
  }, [fetchMessages, toast]);

  const runBatchAgent = useCallback(async () => {
    setBatchRunning(true);
    setBatchStatus(null);
    try {
      const targets = players
        .filter((p) => ["lapsing", "dormant"].includes(getEngagementState(p.last_visit_date)))
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
      toast.success(`${generated} message${generated !== 1 ? "s" : ""} generated`);
    } finally {
      setBatchRunning(false);
      setBatchStatus(null);
    }
  }, [players, fetchMessages, toast]);

  const syncAll = useCallback(async () => {
    setSyncRunning(true);
    try {
      const res = await fetch("/api/sync/events", { method: "POST" });
      if (res.ok) {
        toast.success("Sync started — check Settings → Sync Log for progress");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Sync failed");
        setSyncRunning(false);
      }
    } catch {
      toast.error("Sync failed");
      setSyncRunning(false);
    }
  }, [toast]);

  useEffect(() => {
    fetch("/api/sync/events/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.status === "running") setSyncRunning(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!syncRunning) return;
    const interval = setInterval(() => {
      fetch("/api/sync/events/status")
        .then((r) => r.json())
        .then((data) => {
          if (data.status !== "running") {
            setSyncRunning(false);
            if (data.status === "done") {
              toast.success(`Sync complete — ${data.stats?.attendancesUpserted ?? 0} records upserted`);
              fetchData();
            }
          }
        })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [syncRunning, fetchData, toast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/social-graph/staff-intro-cards");
        if (res.ok) {
          const d = await res.json();
          setIntroCards(d.cards ?? []);
        }
      } catch {
        // non-fatal
      } finally {
        setIntroCardsLoading(false);
      }
    };
    load();
  }, []);

  const needsAssessment = players.filter((p) => p.progression_status === null);
  const active = players.filter((p) => getEngagementState(p.last_visit_date) === "active").length;
  const lapsing = players.filter((p) => getEngagementState(p.last_visit_date) === "lapsing").length;
  const dormant = players.filter((p) => getEngagementState(p.last_visit_date) === "dormant").length;
  const neverVisited = players.filter((p) => p.last_visit_date === null).length;

  const handleCardClick = (key: EngagementState) => setFilterState((prev) => (prev === key ? null : key));

  const statCards = [
    { key: "active" as EngagementState, label: "ACTIVE PLAYERS", value: active, color: "var(--state-active)" },
    { key: "lapsing" as EngagementState, label: "LAPSING", value: lapsing, color: "var(--state-lapsing)" },
    { key: "dormant" as EngagementState, label: "DORMANT", value: dormant, color: "var(--state-dormant)" },
    { key: "never-visited" as EngagementState, label: "NEVER VISITED", value: neverVisited, color: "var(--text-tertiary)" },
  ];

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <Sidebar clubName={clubName} messageCount={messages.length} />
      <div style={{ marginLeft: 220, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <header style={{ height: 52, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 28px", borderBottom: "1px solid var(--border)", background: "var(--bg-surface)", position: "sticky", top: 0, zIndex: 5 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Dashboard</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {batchStatus && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{batchStatus}</span>}
            <ActionBtn label={syncRunning ? "Syncing…" : "Sync All"} disabled={syncRunning} onClick={() => setConfirmDialog({ message: "Manual sync may affect booking performance for players currently using PodPlay. Best run during off-hours. Continue?", onConfirm: () => { setConfirmDialog(null); syncAll(); } })} />
            <ActionBtn label={batchRunning ? "Running…" : "Run Batch Agent"} variant="primary" disabled={batchRunning} onClick={() => setConfirmDialog({ message: "Running the agent for all players makes multiple API calls. For best performance, schedule this during off-hours. Continue?", onConfirm: () => { setConfirmDialog(null); runBatchAgent(); } })} />
          </div>
        </header>
        <main style={{ flex: 1, overflowY: "auto", padding: "24px 28px", background: "var(--bg-surface-2)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 12, marginBottom: 20 }}>
            {statCards.map((s) => (
              <div key={s.key} onClick={() => handleCardClick(s.key)} style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "16px 20px 14px", cursor: "pointer", userSelect: "none", transition: "box-shadow 0.15s", position: "relative", overflow: "hidden" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.boxShadow = "0 4px 16px rgba(0,0,0,0.10)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.boxShadow = "none")}
              >
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)", letterSpacing: "0.06em", marginBottom: 8 }}>{s.label}</div>
                <div style={{ fontSize: 28, fontWeight: 600, color: loading ? "var(--text-tertiary)" : s.color, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{loading ? "—" : s.value}</div>
                <div style={{ position: "absolute", bottom: 0, left: 0, height: 3, background: "var(--accent)", width: filterState === s.key ? "100%" : "0%", transition: "width 150ms ease" }} />
              </div>
            ))}
            <div onClick={() => navigate("/messages")} style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "16px 20px", cursor: "pointer", userSelect: "none" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)", letterSpacing: "0.06em", marginBottom: 8 }}>RESPONSE RATE</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: responseRate !== null ? "var(--state-active)" : "var(--text-primary)", lineHeight: 1 }}>
                {loading ? "—" : responseRate !== null ? `${responseRate}%` : "—"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, fontFamily: "var(--font-mono)" }}>last 30 days</div>
            </div>
            <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "16px 20px", userSelect: "none" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)", letterSpacing: "0.06em", marginBottom: 8 }}>WIN-BACK RATE</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: winbackRate !== null ? "var(--accent)" : "var(--text-primary)", lineHeight: 1 }}>
                {loading ? "—" : winbackRate !== null ? `${winbackRate}%` : "—"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, fontFamily: "var(--font-mono)" }}>attended after msg</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ flex: "0 0 60%", minWidth: 0 }}>
              <AtRiskPanel players={players} loading={loading} filterState={filterState} onFilterStateChange={setFilterState} onRunAgent={runAgent} onRowClick={setDrawerPlayerId} onProgressionChange={fetchData} />
            </div>
            <div style={{ flex: "0 0 calc(40% - 12px)", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
              <NeedsAssessmentPanel players={needsAssessment} onUpdate={fetchData} />
              <StaffIntroPanel cards={introCards} loading={introCardsLoading} />
              <MessageQueuePanel messages={messages} onSent={fetchData} onOpenPlayer={setDrawerPlayerId} />
            </div>
          </div>
        </main>
      </div>
      <PlayerDrawer playerId={drawerPlayerId} clubId={clubId} onClose={() => setDrawerPlayerId(null)} onDataChanged={fetchData} />
      {confirmDialog && <ConfirmDialog message={confirmDialog.message} onConfirm={confirmDialog.onConfirm} onCancel={() => setConfirmDialog(null)} />}
    </div>
  );
}
