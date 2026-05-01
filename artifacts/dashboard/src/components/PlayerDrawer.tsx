import { useEffect, useState, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useToast } from "./Toast";
import { relativeTime, formatDate, getEngagementState, toTitleCase, STATE_COLORS } from "@/lib/helpers";
import type { ProgressionStatus } from "@/lib/types";

interface FullPlayer {
  id: string;
  name: string;
  skill_level: string | null;
  membership_status: string | null;
  progression_status: ProgressionStatus;
  last_visit_date: string | null;
  phone: string | null;
  notes: string | null;
  club_id: string | null;
  coach_assigned_level: string | null;
  coach_level_notes: string | null;
  coach_level_set_at: string | null;
  dupr_rating: number | null;
  dupr_updated_at: string | null;
}

interface LevelConfidenceRow {
  level: string;
  score: number;
  certainty: number;
  sessions: number;
  peer_positive: number;
  peer_total: number;
  last_computed: string | null;
}

interface TaxonomyRow {
  level: string;
  rank: number;
}

interface Attendance {
  id: string;
  program_name: string | null;
  program_type: string | null;
  attended_at: string;
}

interface MessageRow {
  id: string;
  body: string;
  direction: string;
  twilio_message_sid: string | null;
}

interface ConversationRow {
  id: string;
  triggered_by: string | null;
  messages: MessageRow[];
}

interface PlayerDrawerProps {
  playerId: string | null;
  clubId: string | null;
  onClose: () => void;
  onDataChanged?: () => void;
}

const PROGRESSION_OPTIONS: { label: string; value: ProgressionStatus }[] = [
  { label: "Ready to Advance", value: "ready-to-advance" },
  { label: "Developing", value: "developing" },
  { label: "At Ceiling", value: "at-ceiling" },
  { label: "Unset", value: null },
];

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        border: "2px solid rgba(255,255,255,0.4)",
        borderTopColor: "#fff",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
        marginRight: 5,
        verticalAlign: "middle",
      }}
    />
  );
}

function MembershipPill({ status }: { status: string | null }) {
  if (!status) return <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>—</span>;
  const isMember = status.toLowerCase() === "member";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 9px",
        borderRadius: 4,
        background: isMember ? "rgba(46,160,67,0.10)" : "rgba(100,100,100,0.08)",
        color: isMember ? "#2ea043" : "#8b949e",
        fontSize: 12,
        fontWeight: 500,
        border: `1px solid ${isMember ? "rgba(46,160,67,0.20)" : "rgba(100,100,100,0.14)"}`,
      }}
    >
      {toTitleCase(status)}
    </span>
  );
}

export function PlayerDrawer({ playerId, clubId, onClose, onDataChanged }: PlayerDrawerProps) {
  const toast = useToast();
  const [player, setPlayer] = useState<FullPlayer | null>(null);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [runningAgent, setRunningAgent] = useState(false);
  const [savingProgression, setSavingProgression] = useState(false);

  // Notes
  const [notesDraft, setNotesDraft] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const noteSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Coach level
  const [taxonomy, setTaxonomy] = useState<TaxonomyRow[]>([]);
  const [savingCoachLevel, setSavingCoachLevel] = useState(false);
  const [coachLevelNotesDraft, setCoachLevelNotesDraft] = useState("");
  const [coachLevelNotesSaved, setCoachLevelNotesSaved] = useState(false);
  const coachNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DUPR
  const [duprDraft, setDuprDraft] = useState("");
  const [savingDupr, setSavingDupr] = useState(false);
  const [duprSaved, setDuprSaved] = useState(false);
  const duprTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Confidence
  const [confidence, setConfidence] = useState<LevelConfidenceRow[]>([]);
  const [loadingConfidence, setLoadingConfidence] = useState(false);

  // Agent inline result
  const [agentResult, setAgentResult] = useState<string | null>(null);
  const [editingResult, setEditingResult] = useState(false);
  const [resultDraft, setResultDraft] = useState("");
  const [sendingResult, setSendingResult] = useState(false);

  // Animation
  const [mounted, setMounted] = useState(false);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Trigger slide-in
  useEffect(() => {
    if (playerId) {
      setMounted(false);
      setAgentResult(null);
      requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    } else {
      setMounted(false);
    }
  }, [playerId]);

  useEffect(() => {
    if (!playerId) {
      setPlayer(null);
      setAttendance([]);
      setConversations([]);
      setNotesDraft("");
      return;
    }
    setLoadingData(true);

    Promise.all([
      supabase
        .from("players")
        .select("id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id, coach_assigned_level, coach_level_notes, coach_level_set_at, dupr_rating, dupr_updated_at")
        .eq("id", playerId)
        .single(),
      supabase
        .from("attendances")
        .select("id, program_name, program_type, attended_at")
        .eq("player_id", playerId)
        .order("attended_at", { ascending: false })
        .limit(15),
      supabase
        .from("conversations")
        .select("id, triggered_by, messages!conversation_id(id, body, direction, twilio_message_sid)")
        .eq("player_id", playerId)
        .order("id", { ascending: false }),
    ]).then(([pRes, aRes, cRes]) => {
      if (pRes.data) {
        const p = pRes.data as FullPlayer;
        setPlayer(p);
        setNotesDraft(p.notes ?? "");
        setCoachLevelNotesDraft(p.coach_level_notes ?? "");
        setDuprDraft(p.dupr_rating != null ? String(p.dupr_rating) : "");
      }
      if (aRes.data) setAttendance(aRes.data as Attendance[]);
      if (cRes.data) setConversations(cRes.data as ConversationRow[]);
    }).finally(() => setLoadingData(false));

    // Fetch confidence data via API
    setLoadingConfidence(true);
    fetch(`/api/players/${playerId}/confidence`)
      .then((r) => r.ok ? r.json() : [])
      .then((data) => setConfidence(Array.isArray(data) ? data : []))
      .catch(() => setConfidence([]))
      .finally(() => setLoadingConfidence(false));
  }, [playerId]);

  // Taxonomy depends on clubId — waits until club is known before fetching
  useEffect(() => {
    console.log("[taxonomy] effect fired — clubId:", clubId, "playerId:", playerId);
    if (!playerId || !clubId) {
      console.log("[taxonomy] bailing — missing id");
      return;
    }
    supabase
      .from("level_taxonomy")
      .select("level, rank")
      .eq("club_id", clubId)
      .order("rank", { ascending: true })
      .then(({ data, error }) => {
        console.log("[taxonomy] data:", data, "error:", error);
        if (data) setTaxonomy(data as TaxonomyRow[]);
      });
  }, [playerId, clubId]);

  const updateProgression = async (val: ProgressionStatus) => {
    if (!player) return;
    setSavingProgression(true);
    await supabase.from("players").update({ progression_status: val }).eq("id", player.id);
    setPlayer((p) => p ? { ...p, progression_status: val } : p);
    setSavingProgression(false);
    onDataChanged?.();
    toast.info(`Progression set to ${toTitleCase(val ?? "unset")}`);
  };

  const saveNotes = async () => {
    if (!player) return;
    const trimmed = notesDraft.trim();
    const current = player.notes ?? "";
    if (trimmed === current) return;
    await supabase.from("players").update({ notes: trimmed || null }).eq("id", player.id);
    setPlayer((p) => p ? { ...p, notes: trimmed || null } : p);
    setNoteSaved(true);
    if (noteSaveTimer.current) clearTimeout(noteSaveTimer.current);
    noteSaveTimer.current = setTimeout(() => setNoteSaved(false), 2000);
  };

  const assignCoachLevel = async (level: string) => {
    if (!player || savingCoachLevel) return;
    if (player.coach_assigned_level === level) return;
    setSavingCoachLevel(true);
    try {
      const res = await fetch(`/api/players/${player.id}/coach-level`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coach_assigned_level: level }),
      });
      if (res.ok) {
        const data = await res.json();
        setPlayer((p) => p ? { ...p, coach_assigned_level: level, coach_level_set_at: data.player?.coach_level_set_at ?? null } : p);
        if (data.level_confidence) setConfidence(data.level_confidence);
        toast.info(`Coach level set to ${level}`);
        onDataChanged?.();
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to set coach level");
      }
    } catch {
      toast.error("Failed to set coach level");
    } finally {
      setSavingCoachLevel(false);
    }
  };

  const saveCoachLevelNotes = async () => {
    if (!player) return;
    const trimmed = coachLevelNotesDraft.trim();
    if (trimmed === (player.coach_level_notes ?? "")) return;
    await supabase.from("players").update({ coach_level_notes: trimmed || null }).eq("id", player.id);
    setPlayer((p) => p ? { ...p, coach_level_notes: trimmed || null } : p);
    setCoachLevelNotesSaved(true);
    if (coachNoteTimer.current) clearTimeout(coachNoteTimer.current);
    coachNoteTimer.current = setTimeout(() => setCoachLevelNotesSaved(false), 2000);
  };

  const saveDupr = async () => {
    if (!player) return;
    const val = parseFloat(duprDraft);
    if (isNaN(val) || duprDraft.trim() === "") {
      if (player.dupr_rating === null) return;
    }
    const parsed = isNaN(val) ? null : Math.round(val * 100) / 100;
    if (parsed === player.dupr_rating) return;
    setSavingDupr(true);
    try {
      const res = await fetch(`/api/players/${player.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dupr_rating: parsed }),
      });
      if (res.ok) {
        const updated = await res.json();
        setPlayer((p) => p ? { ...p, dupr_rating: updated.dupr_rating, dupr_updated_at: updated.dupr_updated_at } : p);
        setDuprDraft(updated.dupr_rating != null ? String(updated.dupr_rating) : "");
        setDuprSaved(true);
        if (duprTimer.current) clearTimeout(duprTimer.current);
        duprTimer.current = setTimeout(() => setDuprSaved(false), 2000);
        // Refresh confidence scores
        fetch(`/api/players/${player.id}/confidence`).then((r) => r.ok ? r.json() : []).then((d) => setConfidence(Array.isArray(d) ? d : [])).catch(() => {});
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to save DUPR rating");
      }
    } catch {
      toast.error("Failed to save DUPR rating");
    } finally {
      setSavingDupr(false);
    }
  };

  const runAgent = async () => {
    if (!player) return;
    setRunningAgent(true);
    setAgentResult(null);
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: player.id }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data.message ?? data.body ?? null;
        if (msg) {
          setAgentResult(msg);
          setResultDraft(msg);
        }
        toast.success("Message ready in queue");
        onDataChanged?.();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Agent run failed");
      }
    } catch {
      toast.error("Failed — try again");
    } finally {
      setRunningAgent(false);
    }
  };

  const sendResult = async () => {
    setSendingResult(true);
    try {
      const { data: convData } = await supabase
        .from("conversations")
        .select("id, messages!conversation_id(id)")
        .eq("player_id", player!.id)
        .order("id", { ascending: false })
        .limit(1)
        .single();
      const msgId = (convData as any)?.messages?.[0]?.id;
      if (msgId) {
        const res = await fetch("/api/messages/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: msgId }),
        });
        if (res.ok) {
          toast.success("Message sent");
          setAgentResult(null);
          onDataChanged?.();
        } else {
          const d = await res.json().catch(() => ({}));
          toast.error(d.error ?? "Send failed");
        }
      }
    } finally {
      setSendingResult(false);
    }
  };

  if (!playerId) return null;

  const engState = player ? getEngagementState(player.last_visit_date) : null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          zIndex: 200,
          opacity: mounted ? 1 : 0,
          transition: "opacity 200ms ease-out",
        }}
      />

      {/* Drawer panel */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          width: 440,
          height: "100vh",
          background: "var(--bg-surface)",
          borderLeft: "1px solid var(--border)",
          zIndex: 201,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          transform: mounted ? "translateX(0)" : "translateX(100%)",
          transition: "transform 200ms ease-out",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            position: "sticky",
            top: 0,
            background: "var(--bg-surface)",
            zIndex: 1,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            {loadingData || !player ? (
              <div className="skeleton-bar" style={{ width: 140, height: 18, borderRadius: 4 }} />
            ) : (
              <>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 3 }}>{player.name}</div>
                {engState && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: STATE_COLORS[engState],
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontSize: 12, color: STATE_COLORS[engState], fontWeight: 500 }}>
                      {engState}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={runAgent}
              disabled={runningAgent || loadingData}
              style={{
                padding: "5px 12px",
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 500,
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                opacity: runningAgent || loadingData ? 0.65 : 1,
                cursor: runningAgent || loadingData ? "not-allowed" : "pointer",
                fontFamily: "var(--font-sans)",
                display: "flex",
                alignItems: "center",
              }}
            >
              {runningAgent && <Spinner />}
              {runningAgent ? "Running…" : "Run Agent"}
            </button>
            <button
              onClick={onClose}
              style={{
                width: 28,
                height: 28,
                borderRadius: 4,
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border)",
                fontSize: 16,
                color: "var(--text-tertiary)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontFamily: "var(--font-sans)",
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {loadingData ? (
          <div style={{ padding: "20px" }}>
            {[140, 100, 160, 80, 120].map((w, i) => (
              <div key={i} className="skeleton-bar" style={{ width: w, height: 12, marginBottom: 14, borderRadius: 4 }} />
            ))}
          </div>
        ) : player ? (
          <div style={{ flex: 1 }}>
            {/* Profile section */}
            <Section title="Profile">
              <ProfileRow label="Last visit" value={relativeTime(player.last_visit_date)} />
              <ProfileRow label="Phone" value={player.phone ?? "—"} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12 }}>
                <span style={{ fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0 }}>Skill level</span>
                {player.skill_level ? (
                  <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500 }}>{toTitleCase(player.skill_level)}</span>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>Not set</span>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}>
                <span style={{ fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0 }}>Membership</span>
                <MembershipPill status={player.membership_status} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-tertiary)",
                    marginBottom: 6,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Progression
                </label>
                <select
                  value={player.progression_status ?? ""}
                  disabled={savingProgression}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateProgression(v === "" ? null : (v as ProgressionStatus));
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 5,
                    border: "1px solid var(--border)",
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 13,
                    width: "100%",
                    opacity: savingProgression ? 0.5 : 1,
                    cursor: savingProgression ? "not-allowed" : "pointer",
                    outline: "none",
                  }}
                >
                  {PROGRESSION_OPTIONS.map((o) => (
                    <option key={String(o.value)} value={o.value ?? ""}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Coach Level Assessment */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <label style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Coach Level
                  </label>
                  {savingCoachLevel && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Saving…</span>}
                </div>
                {taxonomy.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                    No levels in taxonomy — add rows to level_taxonomy table
                  </div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {taxonomy.map((t) => {
                      const isActive = player.coach_assigned_level === t.level;
                      return (
                        <button
                          key={t.level}
                          onClick={() => assignCoachLevel(t.level)}
                          disabled={savingCoachLevel}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 4,
                            fontSize: 12,
                            fontWeight: 500,
                            fontFamily: "var(--font-sans)",
                            border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                            background: isActive ? "rgba(var(--accent-rgb,232,168,56),0.12)" : "var(--bg-surface-2)",
                            color: isActive ? "var(--accent)" : "var(--text-secondary)",
                            cursor: savingCoachLevel ? "not-allowed" : "pointer",
                            opacity: savingCoachLevel && !isActive ? 0.5 : 1,
                            transition: "all 120ms ease",
                          }}
                        >
                          {t.level}
                        </button>
                      );
                    })}
                    {player.coach_assigned_level && (
                      <button
                        onClick={() => {
                          supabase.from("players").update({ coach_assigned_level: null }).eq("id", player.id).then(() => {
                            setPlayer((p) => p ? { ...p, coach_assigned_level: null } : p);
                            toast.info("Coach level cleared");
                          });
                        }}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 4,
                          fontSize: 11,
                          fontFamily: "var(--font-sans)",
                          border: "1px solid var(--border)",
                          background: "transparent",
                          color: "var(--text-tertiary)",
                          cursor: "pointer",
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}
                {player.coach_assigned_level && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Coach notes</span>
                      {coachLevelNotesSaved && <span style={{ fontSize: 11, color: "var(--state-active)", fontWeight: 500 }}>Saved ✓</span>}
                    </div>
                    <textarea
                      value={coachLevelNotesDraft}
                      onChange={(e) => setCoachLevelNotesDraft(e.target.value)}
                      onBlur={saveCoachLevelNotes}
                      placeholder="Observations about this placement…"
                      rows={2}
                      style={{
                        width: "100%",
                        padding: "6px 10px",
                        fontSize: 12,
                        fontFamily: "var(--font-sans)",
                        lineHeight: 1.5,
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        background: "var(--bg-surface-2)",
                        color: "var(--text-primary)",
                        resize: "vertical",
                        outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                )}
              </div>

              {/* DUPR Rating */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    DUPR Rating
                  </label>
                  {duprSaved && <span style={{ fontSize: 11, color: "var(--state-active)", fontWeight: 500 }}>Saved ✓</span>}
                  {savingDupr && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Saving…</span>}
                </div>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  max="6"
                  value={duprDraft}
                  onChange={(e) => setDuprDraft(e.target.value)}
                  onBlur={saveDupr}
                  placeholder="e.g. 3.25"
                  style={{
                    width: "100%",
                    padding: "6px 10px",
                    fontSize: 13,
                    fontFamily: "var(--font-sans)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              {/* Level Confidence Scores */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: "block", fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Level Confidence
                </label>
                {loadingConfidence ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {[120, 80, 100].map((w, i) => (
                      <div key={i}>
                        <div className="skeleton-bar" style={{ width: w, height: 11, borderRadius: 3, marginBottom: 4 }} />
                        <div className="skeleton-bar" style={{ width: "100%", height: 4, borderRadius: 2 }} />
                      </div>
                    ))}
                  </div>
                ) : confidence.filter((r) => r.sessions > 0).length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                    No sessions recorded yet
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {confidence.filter((r) => r.sessions > 0).map((row) => {
                      // 5-tier system
                      let tier: string;
                      if      (row.score >= 60 && row.certainty >= 0.6) tier = "trusted";
                      else if (row.score >= 60)                          tier = "promising";
                      else if (row.score >= 40)                          tier = "emerging";
                      else if (row.certainty >= 0.3)                     tier = "misfit";
                      else                                               tier = "unknown";

                      // bar colour: green ≥60, amber 40-59, red <40
                      const barColor =
                        row.score >= 60 ? "#2ea043" :
                        row.score >= 40 ? "#e8a838" :
                        "#cf222e";

                      // tier label colour matches bar
                      const tierColor =
                        row.score >= 60 ? "#2ea043" :
                        row.score >= 40 ? "#e8a838" :
                        "#cf222e";

                      // certainty label
                      const certLabel =
                        row.certainty > 0.6 ? "high" :
                        row.certainty >= 0.3 ? "moderate" :
                        "low";

                      return (
                        <div key={row.level}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                            <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500 }}>
                              {row.level}
                            </span>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                              <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-tertiary)" }}>
                                {row.sessions}s · {certLabel}
                              </span>
                              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: tierColor, fontWeight: 600 }}>
                                {tier}
                              </span>
                              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", minWidth: 22, textAlign: "right" }}>
                                {row.score.toFixed(0)}
                              </span>
                            </div>
                          </div>
                          <div style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                            <div
                              style={{
                                height: "100%",
                                width: `${Math.min(100, row.score)}%`,
                                background: barColor,
                                borderRadius: 2,
                                transition: "width 400ms ease",
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <label
                    style={{
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-tertiary)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    Notes
                  </label>
                  {noteSaved && (
                    <span style={{ fontSize: 11, color: "var(--state-active)", fontWeight: 500 }}>
                      Saved ✓
                    </span>
                  )}
                </div>
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  onBlur={saveNotes}
                  placeholder="Add notes about this player…"
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    fontSize: 12,
                    fontFamily: "var(--font-sans)",
                    lineHeight: 1.55,
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    resize: "vertical",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </Section>

            {/* Agent Result inline */}
            {agentResult && (
              <Section title="Generated Message">
                {editingResult ? (
                  <>
                    <textarea
                      value={resultDraft}
                      onChange={(e) => setResultDraft(e.target.value)}
                      rows={5}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        fontSize: 12,
                        fontFamily: "var(--font-sans)",
                        lineHeight: 1.55,
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        background: "var(--bg-surface-2)",
                        color: "var(--text-primary)",
                        resize: "vertical",
                        outline: "none",
                        marginBottom: 8,
                      }}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => { setAgentResult(resultDraft); setEditingResult(false); }}
                        style={{ ...btnStyle, background: "var(--accent)", color: "#fff", border: "none" }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => { setResultDraft(agentResult); setEditingResult(false); }}
                        style={btnStyle}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        lineHeight: 1.6,
                        fontStyle: "italic",
                        padding: "10px 12px",
                        background: "var(--bg-surface-2)",
                        borderRadius: 5,
                        border: "1px solid var(--border)",
                        marginBottom: 10,
                      }}
                    >
                      {agentResult}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => { setEditingResult(true); setResultDraft(agentResult); }}
                        style={btnStyle}
                      >
                        Edit
                      </button>
                      <button
                        onClick={sendResult}
                        disabled={sendingResult}
                        style={{ ...btnStyle, background: "var(--accent)", color: "#fff", border: "none", opacity: sendingResult ? 0.65 : 1 }}
                      >
                        {sendingResult ? "Sending…" : "Send"}
                      </button>
                      <button
                        onClick={() => setAgentResult(null)}
                        style={{ ...btnStyle, color: "var(--text-tertiary)" }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </>
                )}
              </Section>
            )}

            {/* Attendance */}
            <Section title={`Attendance (last ${attendance.length})`}>
              {attendance.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No attendance records</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {attendance.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 0",
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <span style={{ fontSize: 12, color: "var(--text-primary)" }}>
                        {a.program_name ?? "Unknown program"}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-tertiary)",
                          flexShrink: 0,
                          marginLeft: 12,
                        }}
                      >
                        {formatDate(a.attended_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Conversation history */}
            <Section title={`Conversations (${conversations.length})`}>
              {conversations.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No conversations yet</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {conversations.map((c) => (
                    <div
                      key={c.id}
                      style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}
                    >
                      <div
                        style={{
                          padding: "6px 10px",
                          background: "var(--bg-surface-2)",
                          borderBottom: "1px solid var(--border)",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        {c.triggered_by && (
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: 10,
                              color: "var(--text-tertiary)",
                              padding: "1px 5px",
                              borderRadius: 3,
                              background: "var(--bg-surface)",
                              border: "1px solid var(--border)",
                            }}
                          >
                            {c.triggered_by}
                          </span>
                        )}
                      </div>
                      {c.messages.length > 0 ? (
                        c.messages.map((m) => (
                          <div
                            key={m.id}
                            style={{
                              padding: "8px 10px",
                              borderBottom: "1px solid var(--border)",
                              fontSize: 12,
                              lineHeight: 1.5,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 10,
                                fontFamily: "var(--font-mono)",
                                color: m.direction === "outbound" ? "var(--accent)" : "var(--state-active)",
                                marginBottom: 3,
                              }}
                            >
                              {m.direction}
                              {m.twilio_message_sid === "skipped" && " · skipped"}
                            </div>
                            <div style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>{m.body}</div>
                          </div>
                        ))
                      ) : (
                        <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-tertiary)" }}>
                          No messages
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
            }}
          >
            Player not found
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  background: "var(--bg-surface-2)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)" }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontWeight: 500,
          color: "var(--text-tertiary)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        marginBottom: 8,
        gap: 12,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}
