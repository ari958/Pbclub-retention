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
}: {
  label: string;
  variant?: "default" | "primary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
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
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const select = async (val: ProgressionStatus) => {
    setSaving(true);
    setOpen(false);
    await supabase
      .from("players")
      .update({ progression_status: val })
      .eq("id", playerId);
    setSaving(false);
    onUpdate();
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <div
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
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
              onClick={(e) => {
                e.stopPropagation();
                select(opt.value);
              }}
              style={{
                padding: "7px 12px",
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                color:
                  opt.value === status ? "var(--accent)" : "var(--text-primary)",
                background: "transparent",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.background = "var(--bg-surface-2)")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.background = "transparent")
              }
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

  // Sync engagement filter when stat card is clicked
  useEffect(() => {
    setEngFilter(filterState);
  }, [filterState]);

  const handleRun = async (e: React.MouseEvent, playerId: string) => {
    e.stopPropagation();
    setRunning(playerId);
    try {
      await onRunAgent(playerId);
    } finally {
      setRunning(null);
    }
  };

  const handleEngChange = (val: string) => {
    const v = val === "" ? null : (val as EngagementState);
    setEngFilter(v);
    onFilterStateChange(v);
  };

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const clearFilters = () => {
    setSearch("");
    setEngFilter(null);
    setProgFilter("");
    setMemberFilter("");
    setSortCol("state");
    setSortDir("asc");
    onFilterStateChange(null);
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
      if (sortCol === "name") {
        cmp = a.name.localeCompare(b.name);
      } else if (sortCol === "state") {
        cmp = STATE_SORT_ORDER[getEngagementState(a.last_visit_date)] - STATE_SORT_ORDER[getEngagementState(b.last_visit_date)];
      } else if (sortCol === "progression") {
        const ak = a.progression_status ?? "null";
        const bk = b.progression_status ?? "null";
        cmp = (PROG_SORT_ORDER[ak] ?? 99) - (PROG_SORT_ORDER[bk] ?? 99);
      } else if (sortCol === "lastVisit") {
        // never-visited always sorts last regardless of direction
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
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "14px 20px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>Players</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-tertiary)",
          }}
        >
          {loading ? "…" : `Showing ${displayed.length} of ${players.length}`}
        </span>
      </div>

      {/* Filter bar */}
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          background: "var(--bg-surface-2)",
        }}
      >
        <input
          type="text"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...filterSelectStyle, width: 160 }}
        />
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
          <button
            onClick={clearFilters}
            style={{ ...filterSelectStyle, color: "var(--text-tertiary)" }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
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
            {loading ? (
              <SkeletonRows cols={5} />
            ) : displayed.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
                  {hasFilters ? (
                    <span>
                      No players match these filters{" "}
                      <button
                        onClick={clearFilters}
                        style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}
                      >
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
                    style={{
                      borderBottom: i < displayed.length - 1 ? "1px solid var(--border)" : "none",
                      cursor: "pointer",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = AMBER_HOVER)}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
                  >
                    <td style={{ padding: "12px 16px", whiteSpace: "nowrap", borderLeft: `3px solid ${STATE_ROW_BORDER[state]}` }}>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                      {p.skill_level && (
                        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>
                          {toTitleCase(p.skill_level)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <StatePill state={state} />
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <ProgressionDropdown
                        status={p.progression_status}
                        playerId={p.id}
                        onUpdate={onProgressionChange}
                      />
                    </td>
                    <td style={{ padding: "12px 16px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {relativeTime(p.last_visit_date)}
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      <ActionBtn
                        label={isRunning ? "Running…" : "Run Agent"}
                        variant="default"
                        disabled={isRunning}
                        onClick={(e) => handleRun(e as unknown as React.MouseEvent, p.id)}
                      />
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

function NeedsAssessmentPanel({
  players,
  onUpdate,
}: {
  players: Player[];
  onUpdate: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [checkmarks, setCheckmarks] = useState<Set<string>>(new Set());

  const updateProgression = async (playerId: string, status: string) => {
    setLoading(playerId + status);
    await supabase
      .from("players")
      .update({ progression_status: status })
      .eq("id", playerId);
    setLoading(null);
    setCheckmarks((prev) => new Set([...prev, playerId]));
    setTimeout(() => {
      setCheckmarks((prev) => {
        const next = new Set(prev);
        next.delete(playerId);
        return next;
      });
      onUpdate();
    }, 600);
  };

  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 20px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>Needs Assessment</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--state-lapsing)",
            background: "rgba(212,129,58,0.08)",
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid rgba(212,129,58,0.2)",
          }}
        >
          {players.length} pending
        </span>
      </div>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {players.length === 0 ? (
          <div
            style={{
              padding: "28px 20px",
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
            }}
          >
            All players assessed ✓
          </div>
        ) : (
          players.map((p, i) => (
            <div
              key={p.id}
              style={{
                padding: "12px 16px",
                borderBottom:
                  i < players.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 8,
                }}
              >
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                    }}
                  >
                    {p.skill_level ? toTitleCase(p.skill_level) : "No skill level"} · {relativeTime(p.last_visit_date)}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
                {checkmarks.has(p.id) ? (
                  <span
                    style={{
                      fontSize: 14,
                      color: "var(--state-active)",
                      fontWeight: 600,
                    }}
                  >
                    ✓
                  </span>
                ) : (
                  <>
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
      if (res.ok) {
        toast.success("Message sent");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? data.reason ?? "Send failed");
      }
      onSent();
    } finally {
      setSending(null);
    }
  };

  const skipMessage = async (messageId: string, conversationId: string) => {
    setSkipping(messageId);
    try {
      await supabase
        .from("messages")
        .update({ twilio_message_sid: "skipped" })
        .eq("id", messageId);
      await supabase
        .from("conversations")
        .update({ triggered_by: "skipped" })
        .eq("id", conversationId);
      onSent();
    } finally {
      setSkipping(null);
    }
  };

  const startEdit = (messageId: string, body: string) => {
    setEditingId(messageId);
    setDraftBody(body);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftBody("");
  };

  const saveEdit = async (messageId: string) => {
    setSaving(true);
    try {
      await supabase
        .from("messages")
        .update({ body: draftBody })
        .eq("id", messageId);
      setEditingId(null);
      setDraftBody("");
      onSent();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 20px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>Message Queue</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-tertiary)",
            background: "var(--bg-surface-2)",
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid var(--border)",
          }}
        >
          {messages.length} pending
        </span>
      </div>
      <div style={{ maxHeight: 380, overflowY: "auto" }}>
        {messages.length === 0 ? (
          <div
            style={{
              padding: "28px 20px",
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
            }}
          >
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

            return (
              <div
                key={m.id}
                style={{
                  padding: "12px 16px",
                  borderBottom:
                    i < messages.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 6,
                  }}
                >
                  <span
                    onClick={() => playerId && onOpenPlayer(playerId)}
                    style={{
                      fontWeight: 500,
                      fontSize: 13,
                      cursor: playerId ? "pointer" : "default",
                      color: playerId ? "var(--accent)" : "inherit",
                      textDecoration: playerId ? "none" : undefined,
                    }}
                    onMouseEnter={(e) => {
                      if (playerId)
                        (e.currentTarget as HTMLElement).style.textDecoration =
                          "underline";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.textDecoration =
                        "none";
                    }}
                  >
                    {player?.name ?? "Unknown"}
                  </span>
                  {routingTag && routingTag !== "skipped" && (
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        padding: "1px 5px",
                        borderRadius: 3,
                        background: "var(--bg-surface-2)",
                        color: "var(--text-tertiary)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {routingTag}
                    </span>
                  )}
                </div>

                {isEditing ? (
                  <textarea
                    value={draftBody}
                    onChange={(e) => setDraftBody(e.target.value)}
                    rows={4}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "8px 10px",
                      fontSize: 12,
                      fontFamily: "var(--font-sans)",
                      lineHeight: 1.5,
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      background: "var(--bg-surface-2)",
                      color: "var(--text-primary)",
                      resize: "vertical",
                      outline: "none",
                      marginBottom: 8,
                    }}
                  />
                ) : (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      fontStyle: "italic",
                      lineHeight: 1.5,
                      marginBottom: 10,
                    }}
                  >
                    {m.body.length > 120 ? m.body.slice(0, 120) + "…" : m.body}
                  </div>
                )}

                {isEditing ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <ActionBtn
                      label={saving ? "Saving…" : "Save"}
                      variant="primary"
                      disabled={saving || draftBody.trim() === ""}
                      onClick={() => saveEdit(m.id)}
                    />
                    <ActionBtn
                      label="Cancel"
                      disabled={saving}
                      onClick={cancelEdit}
                    />
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <ActionBtn
                      label={isSending ? "Sending…" : "Send"}
                      variant="primary"
                      disabled={busy}
                      onClick={() => sendMessage(m.id)}
                    />
                    <ActionBtn
                      label="Edit"
                      disabled={busy}
                      onClick={() => startEdit(m.id, m.body)}
                    />
                    <ActionBtn
                      label={isSkipping ? "Skipping…" : "Skip"}
                      variant="danger"
                      disabled={busy}
                      onClick={() => skipMessage(m.id, m.conversation_id)}
                    />
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

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div
        onClick={onCancel}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 300,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 301,
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "24px",
          maxWidth: 420,
          width: "calc(100% - 48px)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <div
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.65,
            marginBottom: 20,
          }}
        >
          {message}
        </div>
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
  const [loading, setLoading] = useState(true);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [filterState, setFilterState] = useState<EngagementState | null>(null);
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const fetchMessages = useCallback(async () => {
    const res = await supabase
      .from("messages")
      .select(
        "id, body, signup_url, conversation_id, conversations!conversation_id(id, triggered_by, player_id, players!player_id(id, name, skill_level, progression_status))"
      )
      .eq("direction", "outbound")
      .eq("sent_by", "agent")
      .is("twilio_message_sid", null);
    if (res.data) setMessages(res.data as MessageQueueItem[]);
  }, []);

  const fetchData = useCallback(async () => {
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
    await fetchMessages();
    setLoading(false);
  }, [fetchMessages]);

  const runAgent = useCallback(
    async (playerId: string) => {
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
    },
    [fetchMessages, toast]
  );

  const runBatchAgent = useCallback(async () => {
    setBatchRunning(true);
    setBatchStatus(null);
    try {
      const targets = players
        .filter((p) =>
          ["lapsing", "dormant"].includes(getEngagementState(p.last_visit_date))
        )
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
      toast.success(
        `${generated} message${generated !== 1 ? "s" : ""} generated`
      );
    } finally {
      setBatchRunning(false);
      setBatchStatus(null);
    }
  }, [players, fetchMessages, toast]);

  const syncAll = useCallback(async () => {
    setSyncRunning(true);
    try {
      const res = await fetch("/api/sync/all", { method: "POST" });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.success(`Sync complete — ${data.synced ?? 0} players updated`);
        await fetchData();
      } else {
        toast.error("Sync failed");
      }
    } finally {
      setSyncRunning(false);
    }
  }, [fetchData, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const needsAssessment = players.filter((p) => p.progression_status === null);
  const active = players.filter((p) => getEngagementState(p.last_visit_date) === "active").length;
  const lapsing = players.filter((p) => getEngagementState(p.last_visit_date) === "lapsing").length;
  const dormant = players.filter((p) => getEngagementState(p.last_visit_date) === "dormant").length;
  const neverVisited = players.filter((p) => p.last_visit_date === null).length;

  const handleCardClick = (key: EngagementState) => {
    setFilterState((prev) => (prev === key ? null : key));
  };

  const statCards = [
    {
      key: "active" as EngagementState,
      label: "ACTIVE PLAYERS",
      value: active,
      color: "var(--state-active)",
    },
    {
      key: "lapsing" as EngagementState,
      label: "LAPSING",
      value: lapsing,
      color: "var(--state-lapsing)",
    },
    {
      key: "dormant" as EngagementState,
      label: "DORMANT",
      value: dormant,
      color: "var(--state-dormant)",
    },
    {
      key: "never-visited" as EngagementState,
      label: "NEVER VISITED",
      value: neverVisited,
      color: "var(--text-tertiary)",
    },
  ];

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <Sidebar clubName={clubName} messageCount={messages.length} />

      <div
        style={{
          marginLeft: 220,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {/* Top bar */}
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
          <span style={{ fontWeight: 600, fontSize: 14 }}>Dashboard</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {batchStatus && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                }}
              >
                {batchStatus}
              </span>
            )}
            <ActionBtn
              label={syncRunning ? "Syncing…" : "Sync All"}
              disabled={syncRunning}
              onClick={() =>
                setConfirmDialog({
                  message:
                    "Manual sync may affect booking performance for players currently using PodPlay. Best run during off-hours. Continue?",
                  onConfirm: () => {
                    setConfirmDialog(null);
                    syncAll();
                  },
                })
              }
            />
            <ActionBtn
              label={batchRunning ? "Running…" : "Run Batch Agent"}
              variant="primary"
              disabled={batchRunning}
              onClick={() =>
                setConfirmDialog({
                  message:
                    "Running the agent for all players makes multiple API calls. For best performance, schedule this during off-hours. Continue?",
                  onConfirm: () => {
                    setConfirmDialog(null);
                    runBatchAgent();
                  },
                })
              }
            />
          </div>
        </header>

        {/* Content */}
        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "24px 28px",
            background: "var(--bg-surface-2)",
          }}
        >
          {/* Stat cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 12,
              marginBottom: 20,
            }}
          >
            {statCards.map((s) => (
              <div
                key={s.key}
                onClick={() => handleCardClick(s.key)}
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "16px 20px 14px",
                  cursor: "pointer",
                  userSelect: "none",
                  transition: "box-shadow 0.15s",
                  position: "relative",
                  overflow: "hidden",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.boxShadow = "0 4px 16px rgba(0,0,0,0.10)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.boxShadow = "none")}
              >
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontWeight: 500,
                    color: "var(--text-tertiary)",
                    letterSpacing: "0.06em",
                    marginBottom: 8,
                  }}
                >
                  {s.label}
                </div>
                <div
                  style={{
                    fontSize: 28,
                    fontWeight: 600,
                    color: loading ? "var(--text-tertiary)" : s.color,
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {loading ? "—" : s.value}
                </div>
                {/* Animated amber underline */}
                <div
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    height: 3,
                    background: "var(--accent)",
                    width: filterState === s.key ? "100%" : "0%",
                    transition: "width 150ms ease",
                    borderRadius: "0 0 0 0",
                  }}
                />
              </div>
            ))}
            {/* Response Rate card */}
            <div
              onClick={() => navigate("/messages")}
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "16px 20px",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 500,
                  color: "var(--text-tertiary)",
                  letterSpacing: "0.06em",
                  marginBottom: 8,
                }}
              >
                RESPONSE RATE
              </div>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  lineHeight: 1,
                }}
              >
                —
              </div>
            </div>
          </div>

          {/* Two-column layout */}
          <div
            style={{ display: "flex", gap: 12, alignItems: "flex-start" }}
          >
            <div style={{ flex: "0 0 60%", minWidth: 0 }}>
              <AtRiskPanel
                players={players}
                loading={loading}
                filterState={filterState}
                onFilterStateChange={setFilterState}
                onRunAgent={runAgent}
                onRowClick={setDrawerPlayerId}
                onProgressionChange={fetchData}
              />
            </div>
            <div
              style={{
                flex: "0 0 calc(40% - 12px)",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <NeedsAssessmentPanel
                players={needsAssessment}
                onUpdate={fetchData}
              />
              <MessageQueuePanel
                messages={messages}
                onSent={fetchData}
                onOpenPlayer={setDrawerPlayerId}
              />
            </div>
          </div>
        </main>
      </div>

      <PlayerDrawer
        playerId={drawerPlayerId}
        onClose={() => setDrawerPlayerId(null)}
        onDataChanged={fetchData}
      />

      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </div>
  );
}
