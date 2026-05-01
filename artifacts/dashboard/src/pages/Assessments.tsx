import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { relativeTime } from "@/lib/helpers";
import type { Player } from "@/lib/types";

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

export default function Assessments() {
  const [players, setPlayers] = useState<Player[]>([]);
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
  };

  useEffect(() => { fetchData(); }, []);

  const updateProgression = async (playerId: string, status: string) => {
    setLoadingKey(playerId + status);
    await supabase
      .from("players")
      .update({ progression_status: status })
      .eq("id", playerId);
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
          <span style={{ fontWeight: 600, fontSize: 14 }}>Assessments</span>
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
              maxWidth: 680,
            }}
          >
            {loading ? (
              <div
                style={{
                  padding: "40px 20px",
                  textAlign: "center",
                  color: "var(--text-tertiary)",
                  fontSize: 13,
                }}
              >
                Loading…
              </div>
            ) : players.length === 0 ? (
              <div
                style={{
                  padding: "60px 20px",
                  textAlign: "center",
                  color: "var(--text-tertiary)",
                  fontSize: 13,
                }}
              >
                <div style={{ fontSize: 28, marginBottom: 10 }}>✓</div>
                All players assessed
              </div>
            ) : (
              players.map((p, i) => (
                <div
                  key={p.id}
                  style={{
                    padding: "16px 20px",
                    borderBottom:
                      i < players.length - 1
                        ? "1px solid var(--border)"
                        : "none",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <div
                        style={{ fontWeight: 500, fontSize: 14, marginBottom: 3 }}
                      >
                        {p.name}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-tertiary)",
                        }}
                      >
                        {p.skill_level ?? "No skill level"} ·{" "}
                        {relativeTime(p.last_visit_date)}
                        {p.membership_status &&
                          ` · ${p.membership_status}`}
                      </div>
                      {p.notes && (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            marginTop: 6,
                            fontStyle: "italic",
                            maxWidth: 460,
                          }}
                        >
                          {p.notes}
                        </div>
                      )}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    {checkmarks.has(p.id) ? (
                      <span
                        style={{
                          fontSize: 18,
                          color: "var(--state-active)",
                          fontWeight: 600,
                        }}
                      >
                        ✓
                      </span>
                    ) : (
                      <>
                        <ActionBtn
                          label="Ready to advance"
                          variant="primary"
                          disabled={loadingKey === p.id + "ready-to-advance"}
                          onClick={() =>
                            updateProgression(p.id, "ready-to-advance")
                          }
                        />
                        <ActionBtn
                          label="Developing"
                          disabled={loadingKey === p.id + "developing"}
                          onClick={() => updateProgression(p.id, "developing")}
                        />
                        <ActionBtn
                          label="At ceiling"
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
        </main>
      </div>
    </div>
  );
}
