import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { relativeTime } from "@/lib/helpers";
import type { Player } from "@/lib/types";

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

const PROG_DISPLAY: Record<string, { label: string; color: string; bg: string; border: string }> = {
  "ready-to-advance": {
    label: "Move Up a Level",
    color: D.green,
    bg: "rgba(46,160,67,0.12)",
    border: "rgba(46,160,67,0.25)",
  },
  developing: {
    label: "Still Developing",
    color: D.accent,
    bg: D.accentBg,
    border: "rgba(232,168,56,0.25)",
  },
  "at-ceiling": {
    label: "At Their Level",
    color: D.muted,
    bg: D.inner,
    border: D.border,
  },
};

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
    default: { background: D.inner, color: D.text, border: `1px solid ${D.border}` },
    primary: { background: D.accent, color: "#fff", border: "none" },
    danger: { background: D.redBg, color: "#ff6b6b", border: `1px solid rgba(207,34,46,0.25)` },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles[variant],
        padding: "5px 12px",
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

function ProgPill({ status }: { status: string }) {
  const meta = PROG_DISPLAY[status];
  if (!meta) return <span style={{ fontSize: 11, color: D.muted }}>{status}</span>;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 500,
        fontFamily: "var(--font-mono)",
        background: meta.bg,
        color: meta.color,
        border: `1px solid ${meta.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

export default function Assessments() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [recentPlayers, setRecentPlayers] = useState<Player[]>([]);
  const [clubName, setClubName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [checkmarks, setCheckmarks] = useState<Set<string>>(new Set());

  const fetchData = async () => {
    const clubRes = await supabase.from("clubs").select("name").limit(1).maybeSingle();
    if (clubRes.data?.name) setClubName(clubRes.data.name);

    const allPlayers: Player[] = [];
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from("players")
        .select(
          "id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id"
        )
        .is("progression_status", null)
        .order("last_visit_date", { ascending: false, nullsFirst: false })
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      allPlayers.push(...(data as Player[]));
      if (data.length < 1000) break;
      offset += 1000;
    }
    setPlayers(allPlayers);
    setLoading(false);

    const { data: recentData } = await supabase
      .from("players")
      .select(
        "id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id"
      )
      .not("progression_status", "is", null)
      .order("last_visit_date", { ascending: false, nullsFirst: false })
      .limit(20);
    if (recentData) setRecentPlayers(recentData as Player[]);
  };

  useEffect(() => { fetchData(); }, []);

  const updateProgression = async (playerId: string, status: string) => {
    setLoadingKey(playerId + status);
    await fetch(`/api/players/${playerId}/progression`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, assessed_by: "operator" }),
    });
    setLoadingKey(null);
    setCheckmarks((prev) => new Set([...prev, playerId]));
    setTimeout(() => {
      setCheckmarks((prev) => {
        const next = new Set(prev);
        next.delete(playerId);
        return next;
      });
      setPlayers((prev) => prev.filter((p) => p.id !== playerId));
    }, 600);
  };

  const cardStyle: React.CSSProperties = {
    background: D.card,
    border: `1px solid ${D.border}`,
    borderRadius: 8,
    overflow: "hidden",
    flex: 1,
    minWidth: 0,
  };

  const cardHeadStyle: React.CSSProperties = {
    padding: "14px 20px",
    borderBottom: `1px solid ${D.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  };

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
          <span style={{ fontWeight: 600, fontSize: 14, color: D.text }}>Progress</span>
        </header>

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px 28px",
            background: D.bg,
            display: "flex",
            gap: 20,
            alignItems: "flex-start",
          }}
        >
          {/* ── Left: Needs Assessment ── */}
          <div style={cardStyle}>
            <div style={cardHeadStyle}>
              <span style={{ fontWeight: 600, fontSize: 13, color: D.text }}>Needs Assessment</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  padding: "2px 7px",
                  borderRadius: 3,
                  background: D.accentBg,
                  color: D.accent,
                  border: "1px solid rgba(232,168,56,0.25)",
                }}
              >
                {players.length} players
              </span>
            </div>

            {loading ? (
              <div style={{ padding: "40px 20px", textAlign: "center", color: D.faint, fontSize: 13 }}>
                Loading…
              </div>
            ) : players.length === 0 ? (
              <div style={{ padding: "60px 20px", textAlign: "center", color: D.faint, fontSize: 13 }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>✓</div>
                All players assessed
              </div>
            ) : (
              players.map((p, i) => (
                <div
                  key={p.id}
                  style={{
                    padding: "16px 20px",
                    borderBottom: i < players.length - 1 ? `1px solid ${D.border}` : "none",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = D.inner; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 3, color: D.text }}>{p.name}</div>
                      <div style={{ fontSize: 12, color: D.faint }}>
                        {[p.skill_level, relativeTime(p.last_visit_date), p.membership_status]
                          .filter(Boolean).join(" · ")}
                      </div>
                      {p.notes && (
                        <div style={{ fontSize: 12, color: D.muted, marginTop: 6, fontStyle: "italic", maxWidth: 460 }}>
                          {p.notes}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {checkmarks.has(p.id) ? (
                      <span style={{ fontSize: 18, color: D.green, fontWeight: 600 }}>✓</span>
                    ) : (
                      <>
                        <ActionBtn
                          label="Move Up a Level"
                          variant="primary"
                          disabled={loadingKey === p.id + "ready-to-advance"}
                          onClick={() => updateProgression(p.id, "ready-to-advance")}
                        />
                        <ActionBtn
                          label="Still Developing"
                          disabled={loadingKey === p.id + "developing"}
                          onClick={() => updateProgression(p.id, "developing")}
                        />
                        <ActionBtn
                          label="At Their Level"
                          disabled={loadingKey === p.id + "at-ceiling"}
                          onClick={() => updateProgression(p.id, "at-ceiling")}
                        />
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* ── Right: Recently Assessed ── */}
          <div style={{ ...cardStyle, maxWidth: 340, flexShrink: 0 }}>
            <div style={cardHeadStyle}>
              <span style={{ fontWeight: 600, fontSize: 13, color: D.text }}>Recently Assessed</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  padding: "2px 7px",
                  borderRadius: 3,
                  background: D.inner,
                  color: D.faint,
                  border: `1px solid ${D.border}`,
                }}
              >
                last 20
              </span>
            </div>

            {recentPlayers.length === 0 ? (
              <div style={{ padding: "32px 20px", textAlign: "center", color: D.faint, fontSize: 13 }}>
                No assessments yet
              </div>
            ) : (
              recentPlayers.map((p, i) => (
                <div
                  key={p.id}
                  style={{
                    padding: "12px 16px",
                    borderBottom: i < recentPlayers.length - 1 ? `1px solid ${D.border}` : "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 500,
                        fontSize: 13,
                        color: D.text,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {p.name}
                    </div>
                    <div style={{ fontSize: 11, color: D.faint, marginTop: 2 }}>
                      {p.skill_level ?? "—"} · {relativeTime(p.last_visit_date)}
                    </div>
                  </div>
                  {p.progression_status && <ProgPill status={p.progression_status} />}
                </div>
              ))
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
