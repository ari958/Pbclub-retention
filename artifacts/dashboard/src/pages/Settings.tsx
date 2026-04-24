import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Sidebar } from "@/components/Sidebar";
import { useToast } from "@/components/Toast";
import { toTitleCase } from "@/lib/helpers";

interface ClubRow {
  id: string;
  name: string;
  agent_config: Record<string, unknown> | null;
  scheduled_sync_time: string | null;
  timezone: string | null;
}

const KNOWN_LABELS: Record<string, string> = {
  max_messages_per_day: "Max messages per day",
  max_messages_per_week: "Max messages per week",
  tone: "Agent tone",
  language: "Language",
  signup_link_base: "Signup link base URL",
  follow_up_days: "Follow-up window (days)",
  enabled: "Agent enabled",
  dormant_threshold_days: "Dormant Threshold Days",
  lapsing_threshold_days: "Lapsing Threshold Days",
  max_messages_per_thread: "Max Messages Per Thread",
};

const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Paris",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  return String(val);
}

const inputStyle: React.CSSProperties = {
  padding: "7px 10px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg-surface-2)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--text-tertiary)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
  display: "block",
};

export default function Settings() {
  const toast = useToast();
  const [club, setClub] = useState<ClubRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncTime, setSyncTime] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [saving, setSaving] = useState(false);
  const [hasScheduleColumns, setHasScheduleColumns] = useState(true);

  useEffect(() => {
    supabase
      .from("clubs")
      .select("id, name, agent_config, scheduled_sync_time, timezone")
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error?.message?.includes("scheduled_sync_time") || error?.code === "42703") {
          setHasScheduleColumns(false);
          supabase
            .from("clubs")
            .select("id, name, agent_config")
            .limit(1)
            .maybeSingle()
            .then(({ data: fallback }) => {
              if (fallback) setClub(fallback as ClubRow);
              setLoading(false);
            });
        } else {
          if (data) {
            setClub(data as ClubRow);
            setSyncTime(data.scheduled_sync_time ?? "02:00");
            setTimezone(data.timezone ?? "America/New_York");
          }
          setLoading(false);
        }
      });
  }, []);

  const saveSchedule = async () => {
    if (!club) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("clubs")
        .update({ scheduled_sync_time: syncTime, timezone })
        .eq("id", club.id);

      if (error) {
        toast.error(error.message);
      } else {
        setClub((prev) => prev ? { ...prev, scheduled_sync_time: syncTime, timezone } : prev);
        toast.success("Schedule saved");
      }
    } finally {
      setSaving(false);
    }
  };

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
            <div style={{ color: "var(--text-tertiary)", fontSize: 13 }}>
              Loading…
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>

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

              {/* Sync schedule card */}
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
                    Sync Schedule
                  </div>
                </div>

                {!hasScheduleColumns ? (
                  <div style={{ padding: "16px 20px" }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--state-lapsing)",
                        background: "rgba(212,129,58,0.08)",
                        border: "1px solid rgba(212,129,58,0.2)",
                        borderRadius: 5,
                        padding: "10px 14px",
                        lineHeight: 1.6,
                      }}
                    >
                      Schedule columns not yet added to the clubs table. Run the following in Supabase SQL editor:
                      <pre
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          marginTop: 8,
                          marginBottom: 0,
                          whiteSpace: "pre-wrap",
                        }}
                      >
{`ALTER TABLE clubs
  ADD COLUMN IF NOT EXISTS scheduled_sync_time time,
  ADD COLUMN IF NOT EXISTS timezone text DEFAULT 'America/New_York';`}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <label style={labelStyle}>Nightly sync time (24h)</label>
                      <input
                        type="time"
                        value={syncTime}
                        onChange={(e) => setSyncTime(e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={labelStyle}>Timezone</label>
                      <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        style={{ ...inputStyle, cursor: "pointer" }}
                      >
                        {COMMON_TIMEZONES.map((tz) => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 4 }}>
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--text-tertiary)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {club?.scheduled_sync_time
                          ? `Currently: ${club.scheduled_sync_time} ${club.timezone ?? "UTC"}`
                          : "Not set — defaults to 02:00"}
                      </span>
                      <button
                        onClick={saveSchedule}
                        disabled={saving}
                        style={{
                          padding: "6px 14px",
                          borderRadius: 5,
                          background: "var(--accent)",
                          color: "#fff",
                          border: "none",
                          fontSize: 12,
                          fontWeight: 500,
                          fontFamily: "var(--font-sans)",
                          cursor: saving ? "not-allowed" : "pointer",
                          opacity: saving ? 0.6 : 1,
                        }}
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                )}
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
                        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                          {KNOWN_LABELS[key] ?? toTitleCase(key)}
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            fontFamily: typeof val === "boolean" ? "var(--font-sans)" : "var(--font-mono)",
                            color:
                              typeof val === "boolean"
                                ? val ? "var(--state-active)" : "var(--state-dormant)"
                                : "var(--text-primary)",
                          }}
                        >
                          {formatValue(val)}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                {/* Scheduling note */}
                <div
                  style={{
                    padding: "14px 20px",
                    borderTop: "1px solid var(--border)",
                    background: "var(--bg-surface-2)",
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>ℹ</span>
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--text-tertiary)",
                      lineHeight: 1.6,
                    }}
                  >
                    Sync and agent runs are scheduled nightly at your configured time. Manual triggers are available for testing but may affect PodPlay performance during business hours.
                  </span>
                </div>
              </div>

            </div>
          )}
        </main>
      </div>
    </div>
  );
}
