import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { toTitleCase } from "@/lib/helpers";

interface ClubRow {
  id: string;
  name: string;
  agent_config: Record<string, unknown> | null;
}

const KNOWN_LABELS: Record<string, string> = {
  max_messages_per_day: "Max messages per day",
  max_messages_per_week: "Max messages per week",
  tone: "Agent tone",
  language: "Language",
  signup_link_base: "Signup link base URL",
  follow_up_days: "Follow-up window (days)",
  enabled: "Agent enabled",
};

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  return String(val);
}

export default function Settings() {
  const [club, setClub] = useState<ClubRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from("clubs")
      .select("id, name, agent_config")
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setClub(data as ClubRow);
        setLoading(false);
      });
  }, []);

  const configEntries: [string, unknown][] = club?.agent_config
    ? Object.entries(club.agent_config)
    : [];

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <Sidebar clubName={club?.name ?? ""} />
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
            padding: "0 28px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-surface)",
            position: "sticky",
            top: 0,
            zIndex: 5,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 14 }}>Settings</span>
        </header>

        <main
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "28px",
            background: "var(--bg-surface-2)",
          }}
        >
          {loading ? (
            <div
              style={{
                color: "var(--text-tertiary)",
                fontSize: 13,
              }}
            >
              Loading…
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 16,
                maxWidth: 560,
              }}
            >
              {/* Club card */}
              <div
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
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      fontWeight: 500,
                      color: "var(--text-tertiary)",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      marginBottom: 6,
                    }}
                  >
                    Club
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 18 }}>
                    {club?.name ?? "—"}
                  </div>
                </div>
              </div>

              {/* Agent config card */}
              <div
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
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      fontWeight: 500,
                      color: "var(--text-tertiary)",
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}
                  >
                    Agent Configuration
                  </div>
                </div>
                <div style={{ padding: "4px 0" }}>
                  {configEntries.length === 0 ? (
                    <div
                      style={{
                        padding: "20px",
                        fontSize: 13,
                        color: "var(--text-tertiary)",
                      }}
                    >
                      No configuration set
                    </div>
                  ) : (
                    configEntries.map(([key, val]) => (
                      <div
                        key={key}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "10px 20px",
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13,
                            color: "var(--text-secondary)",
                          }}
                        >
                          {KNOWN_LABELS[key] ?? toTitleCase(key)}
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            fontFamily: typeof val === "boolean" ? "var(--font-sans)" : "var(--font-mono)",
                            color:
                              typeof val === "boolean"
                                ? val
                                  ? "var(--state-active)"
                                  : "var(--state-dormant)"
                                : "var(--text-primary)",
                          }}
                        >
                          {formatValue(val)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
