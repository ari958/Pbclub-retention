import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/components/Toast";
import { Sidebar } from "@/components/Sidebar";
import { PlayerDrawer } from "@/components/PlayerDrawer";
import { useClub, clubApiUrl } from "@/lib/ClubContext";
import {
  getEngagementState,
  relativeTime,
  toTitleCase,
} from "@/lib/helpers";
import type { EngagementState, Player, MessageQueueItem } from "@/lib/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const C = {
  bg: "#0f1117",
  surface: "#161b22",
  border: "#30363d",
  innerBorder: "#1e2530",
  textPrimary: "#e6edf3",
  textSecondary: "#8b949e",
  accent: "#E8A838",
  green: "#2ea043",
  orange: "#d4813a",
  red: "#cf222e",
  redText: "#ff6b6b",
} as const;

function getCooldownLabel(lastOutboundAt: string | null): string | null {
  if (!lastOutboundAt) return null;
  const elapsed = Date.now() - new Date(lastOutboundAt).getTime();
  const remaining = COOLDOWN_MS - elapsed;
  if (remaining <= 0) return null;
  const hours = Math.floor(remaining / 3600000);
  const mins = Math.ceil((remaining % 3600000) / 60000);
  return hours > 0 ? `${hours}h ${mins}m cooldown` : `${mins}m cooldown`;
}

// ─── Small shared components ──────────────────────────────────────────────────

function ProgressBar({ active }: { active: boolean }) {
  return (
    <div
      style={{
        height: 2,
        borderRadius: 1,
        marginTop: 3,
        background: active ? C.accent : "transparent",
        width: active ? "100%" : "0%",
        animation: active ? "progressFill 20s linear forwards" : "none",
      }}
    />
  );
}

function StatePillDark({ state }: { state: EngagementState }) {
  const map: Record<EngagementState, { label: string; bg: string; color: string }> = {
    active: { label: "Active", bg: "rgba(46,160,67,0.15)", color: C.green },
    lapsing: { label: "Drifting", bg: "rgba(212,129,58,0.15)", color: C.orange },
    dormant: { label: "Inactive", bg: "rgba(207,34,46,0.15)", color: C.redText },
    "never-visited": { label: "Never Visited", bg: "rgba(139,148,158,0.15)", color: C.textSecondary },
  };
  const s = map[state];
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 9, padding: "1px 6px", borderRadius: 8, fontWeight: 500, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

function PanelHeader({
  title,
  badge,
  urgentBadge = false,
  viewLabel = "View All →",
  onView,
}: {
  title: string;
  badge?: string;
  urgentBadge?: boolean;
  viewLabel?: string;
  onView?: () => void;
}) {
  return (
    <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.innerBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.textPrimary }}>{title}</span>
        {badge !== undefined && (
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            background: urgentBadge ? "rgba(207,34,46,0.12)" : C.innerBorder,
            border: `1px solid ${urgentBadge ? "rgba(207,34,46,0.25)" : C.border}`,
            color: urgentBadge ? C.redText : C.textSecondary,
            padding: "1px 6px",
            borderRadius: 8,
          }}>
            {badge}
          </span>
        )}
      </div>
      {onView && (
        <span onClick={onView} style={{ fontSize: 10, color: C.accent, fontWeight: 500, cursor: "pointer" }}>
          {viewLabel}
        </span>
      )}
    </div>
  );
}

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <>
      <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 300 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 301, background: "#1a1f28", border: `1px solid ${C.border}`, borderRadius: 10, padding: "24px", maxWidth: 420, width: "calc(100% - 48px)", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", fontFamily: "var(--font-sans)" }}>
        <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.65, marginBottom: 20 }}>{message}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={{ background: C.innerBorder, border: `1px solid ${C.border}`, color: C.textSecondary, padding: "5px 12px", borderRadius: 5, fontSize: 12, fontFamily: "var(--font-sans)", cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ background: C.accent, color: C.bg, border: "none", padding: "5px 14px", borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-sans)", cursor: "pointer" }}>
            Continue
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Date formatting ──────────────────────────────────────────────────────────

function makeDateFmt(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function visitLabel(visitCount: number): string {
  const n = visitCount + 1;
  if (n === 1) return "1st visit";
  if (n === 2) return "2nd visit";
  if (n === 3) return "3rd visit";
  return `${n}th visit`;
}

// ─── Recommendation types & components ───────────────────────────────────────

type RecUrgency = "critical" | "high" | "medium" | "info" | "good";

interface Recommendation {
  id: string;
  urgency: RecUrgency;
  icon: string;
  title: string;
  body: string;
  action: string;
  navigate: string;
  navigateState?: any;
}

function RecIcon({ name, stroke }: { name: string; stroke: string }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke, strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "alert") return <svg {...p}><path d="M8 2L14 13H2L8 2z"/><path d="M8 6v3M8 11v.5"/></svg>;
  if (name === "message") return <svg {...p}><path d="M2 2h12a1 1 0 011 1v8a1 1 0 01-1 1H5l-3 3V3a1 1 0 011-1z"/></svg>;
  if (name === "progress") return <svg {...p}><path d="M8 14V2M3 7l5-5 5 5"/></svg>;
  if (name === "refresh") return <svg {...p}><path d="M2 8a6 6 0 016-6 6 6 0 014.2 1.8L14 2v4h-4l1.4-1.4A4 4 0 104 10"/></svg>;
  return <svg {...p}><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>;
}

const URGENCY_CFG: Record<RecUrgency, { iconBg: string; iconStroke: string; badgeBg: string; badgeColor: string; badgeLabel: string }> = {
  critical: { iconBg: "rgba(207,34,46,0.1)",   iconStroke: "#ff6b6b", badgeBg: "rgba(207,34,46,0.12)",   badgeColor: "#ff6b6b", badgeLabel: "Act now"   },
  high:     { iconBg: "rgba(232,168,56,0.1)",  iconStroke: "#E8A838", badgeBg: "rgba(232,168,56,0.12)",  badgeColor: "#E8A838", badgeLabel: "This week" },
  medium:   { iconBg: "rgba(56,139,253,0.1)",  iconStroke: "#79c0ff", badgeBg: "rgba(56,139,253,0.12)",  badgeColor: "#79c0ff", badgeLabel: "Coaching"  },
  good:     { iconBg: "rgba(46,160,67,0.1)",   iconStroke: "#2ea043", badgeBg: "rgba(46,160,67,0.12)",   badgeColor: "#2ea043", badgeLabel: "Good news" },
  info:     { iconBg: "rgba(139,148,158,0.1)", iconStroke: "#8b949e", badgeBg: "rgba(139,148,158,0.1)",  badgeColor: "#8b949e", badgeLabel: "Setup"     },
};

function RecTile({
  rec,
  dismissing,
  onDismiss,
  onNavigate,
}: {
  rec: Recommendation;
  dismissing: boolean;
  onDismiss: (id: string) => void;
  onNavigate: (path: string, state?: any) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const s = URGENCY_CFG[rec.urgency];
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onNavigate(rec.navigate, rec.navigateState)}
      style={{
        background: "#0f1117",
        border: `1px solid ${hovered ? "#E8A838" : "#30363d"}`,
        borderRadius: 10,
        padding: "14px 16px",
        flex: "0 0 calc(25% - 8px)",
        cursor: "pointer",
        transition: "border-color 0.15s, opacity 0.2s, transform 0.15s",
        opacity: dismissing ? 0 : 1,
        transform: hovered && !dismissing ? "scale(1.01)" : "scale(1)",
        userSelect: "none",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: s.iconBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <RecIcon name={rec.icon} stroke={s.iconStroke} />
          </div>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 600, background: s.badgeBg, color: s.badgeColor, padding: "1px 6px", borderRadius: 4 }}>
            {s.badgeLabel}
          </span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(rec.id); }}
          style={{
            width: 20, height: 20, borderRadius: "50%",
            background: "#1e2530", border: "1px solid #30363d",
            color: "#8b949e", fontSize: 14, lineHeight: 1,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", padding: 0, flexShrink: 0,
            opacity: hovered ? 1 : 0, transition: "opacity 0.15s",
          }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", marginTop: 8, lineHeight: 1.3 }}>
        {rec.title}
      </div>
      <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5, marginTop: 4 }}>
        {rec.body}
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#E8A838", marginTop: 8 }}>
        {rec.action}
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const club = useClub();

  // ─── Core state ─────────────────────────────────────────────────────────────
  const [players, setPlayers] = useState<Player[]>([]);
  const [messages, setMessages] = useState<MessageQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [drawerPlayerId, setDrawerPlayerId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [responseRate, setResponseRate] = useState<number | null>(null);
  const [winbackRate, setWinbackRate] = useState<number | null>(null);
  const [sentThisMonth, setSentThisMonth] = useState(0);
  const [introCards, setIntroCards] = useState<any[]>([]);
  const [introCardsLoading, setIntroCardsLoading] = useState(true);
  const [dismissedIds, setDismissedIds] = useState<Record<string, number>>({});
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());
  const [tileOffset, setTileOffset] = useState(0);

  // ─── Needs Attention panel state ─────────────────────────────────────────────
  const [atRiskRunning, setAtRiskRunning] = useState<string | null>(null);
  const [atRiskSucceeded, setAtRiskSucceeded] = useState<Set<string>>(new Set());

  // ─── Outreach Queue panel state ───────────────────────────────────────────────
  const [sending, setSending] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [sentSucceeded, setSentSucceeded] = useState<Set<string>>(new Set());

  // ─── Data fetching ───────────────────────────────────────────────────────────

  const fetchMessages = useCallback(async () => {
    const res = await supabase
      .from("messages")
      .select(
        "id, body, signup_url, status, conversation_id, conversations!conversation_id(id, triggered_by, player_id, players!player_id(id, name, skill_level, progression_status, last_outbound_at))"
      )
      .eq("direction", "outbound")
      .eq("sent_by", "agent")
      .eq("status", "pending")
      .returns<MessageQueueItem[]>();
    if (res.data) setMessages(res.data);
  }, []);

  const fetchData = useCallback(async () => {
    const [outboundRes, inboundRes, winbackData] = await Promise.all([
      supabase.from("messages").select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .eq("status", "sent")
        .gte("sent_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      supabase.from("messages").select("id", { count: "exact", head: true })
        .eq("direction", "inbound")
        .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()),
      fetch(clubApiUrl(club.slug, "/api/players/winback-stats")).then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);

    const allPlayers: Player[] = [];
    let offset = 0;
    let churnColAvailable: boolean | null = null;
    while (true) {
      const selectCols = churnColAvailable === false
        ? "id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id, last_outbound_at"
        : "id, external_id, name, skill_level, membership_status, progression_status, last_visit_date, phone, notes, club_id, last_outbound_at, churn_risk";
      const { data, error } = await supabase
        .from("players")
        .select(selectCols)
        .range(offset, offset + 999)
        .returns<Player[]>();
      if (error?.code === "42703") {
        churnColAvailable = false;
        continue;
      }
      if (!data || data.length === 0) break;
      allPlayers.push(...data);
      if (data.length < 1000) break;
      offset += 1000;
    }

    setPlayers(allPlayers);
    const outCount = outboundRes.count ?? 0;
    const inCount = inboundRes.count ?? 0;
    setSentThisMonth(outCount);
    setResponseRate(outCount > 0 ? Math.round((inCount / outCount) * 100) : null);
    setWinbackRate(winbackData?.conversion_rate_pct ?? null);
    await fetchMessages();
    setLoading(false);
  }, [fetchMessages, club.slug]);

  const runAgent = useCallback(async (playerId: string) => {
    const res = await fetch(clubApiUrl(club.slug, "/api/agent/run"), {
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
  }, [fetchMessages, toast, club.slug]);

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
        setBatchStatus(`Generating ${i + 1} of ${targets.length}…`);
        const res = await fetch(clubApiUrl(club.slug, "/api/agent/run"), {
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
  }, [players, fetchMessages, toast, club.slug]);

  const syncAll = useCallback(async () => {
    setSyncRunning(true);
    try {
      const res = await fetch(clubApiUrl(club.slug, "/api/sync/events"), { method: "POST" });
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
  }, [toast, club.slug]);

  useEffect(() => {
    fetch(clubApiUrl(club.slug, "/api/sync/events/status"))
      .then((r) => r.json())
      .then((data) => { if (data.status === "running") setSyncRunning(true); })
      .catch(() => {});
  }, [club.slug]);

  useEffect(() => {
    if (!syncRunning) return;
    const interval = setInterval(() => {
      fetch(clubApiUrl(club.slug, "/api/sync/events/status"))
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
        const res = await fetch(clubApiUrl(club.slug, "/api/social-graph/staff-intro-cards"));
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
  }, [club.slug]);

  useEffect(() => {
    const stored = localStorage.getItem("pulse_dismissed_recs");
    if (stored) {
      try { setDismissedIds(JSON.parse(stored)); } catch {}
    }
  }, []);

  // ─── Outreach queue actions ───────────────────────────────────────────────────

  const handleRunAgent = async (playerId: string) => {
    setAtRiskRunning(playerId);
    try {
      await runAgent(playerId);
      setAtRiskSucceeded((prev) => new Set([...prev, playerId]));
      setTimeout(() => {
        setAtRiskSucceeded((prev) => { const next = new Set(prev); next.delete(playerId); return next; });
      }, 1500);
    } finally {
      setAtRiskRunning(null);
    }
  };

  const sendMessage = async (messageId: string) => {
    setSending(messageId);
    try {
      const res = await fetch(clubApiUrl(club.slug, "/api/messages/send"), {
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
          setSentSucceeded((prev) => new Set([...prev, messageId]));
          setTimeout(() => {
            setSentSucceeded((prev) => { const next = new Set(prev); next.delete(messageId); return next; });
          }, 1500);
        }
      } else {
        if (data.unresolved_vars?.length) {
          toast.error(`Unresolved variables: ${data.unresolved_vars.join(", ")}`);
        } else {
          toast.error(data.error ?? "Send failed");
        }
      }
      await fetchMessages();
    } finally {
      setSending(null);
    }
  };

  const skipMessage = async (messageId: string) => {
    setSkipping(messageId);
    try {
      const res = await fetch(clubApiUrl(club.slug, "/api/messages/skip"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_id: messageId }),
      });
      if (res.ok) toast.info("Message dismissed");
      else toast.error("Failed to dismiss message");
      await fetchMessages();
    } finally {
      setSkipping(null);
    }
  };

  const saveEdit = async (messageId: string) => {
    setSaving(true);
    try {
      const res = await fetch(clubApiUrl(club.slug, `/api/messages/${messageId}/draft`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draftBody }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? "Failed to save edit");
        return;
      }
      setEditingId(null);
      setDraftBody("");
      await fetchMessages();
    } finally {
      setSaving(false);
    }
  };

  // ─── Derived values ───────────────────────────────────────────────────────────

  const active = players.filter((p) => getEngagementState(p.last_visit_date) === "active").length;
  const lapsing = players.filter((p) => getEngagementState(p.last_visit_date) === "lapsing").length;
  const dormant = players.filter((p) => getEngagementState(p.last_visit_date) === "dormant").length;
  const neverVisited = players.filter((p) => p.last_visit_date === null).length;
  const needsAssessment = players.filter(
    (p) => !p.progression_status && p.last_visit_date !== null
  );
  const needsAttentionCount = lapsing + dormant;
  const total = players.length || 1;

  const highRiskPlayers = players.filter(
    (p) => p.churn_risk === "high" && p.last_visit_date !== null
  );

  const highRiskDrifting = players.filter(
    (p) =>
      p.churn_risk === "high" &&
      (getEngagementState(p.last_visit_date) === "lapsing" ||
        getEngagementState(p.last_visit_date) === "dormant")
  );

  // ─── Recommendation engine ────────────────────────────────────────────────────

  const recommendations = useMemo((): Recommendation[] => {
    const recs: Recommendation[] = [];

    // REC 1 — High churn risk
    if (highRiskPlayers.length > 0) {
      recs.push({
        id: "churn-high",
        urgency: "critical",
        icon: "alert",
        title: `${highRiskPlayers.length} players at high churn risk`,
        body: "Non-members who haven't been back in 60+ days. Every week you wait, more are gone for good.",
        action: "Start with top 10 →",
        navigate: `/c/${club.slug}/players`,
        navigateState: { filter: "high-churn" },
      });
    }

    // REC 2 — Messages queued
    if (messages.length > 0) {
      const names = messages
        .slice(0, 3)
        .map((m) => m.conversations?.players?.name)
        .filter(Boolean) as string[];
      let body = "";
      if (names.length === 1) {
        body = `Personalized outreach is queued for ${names[0]}. Review and send.`;
      } else if (names.length === 2) {
        body = `Personalized outreach is queued for ${names[0]} and ${names[1]}. Review and send.`;
      } else {
        const rem = messages.length - 2;
        body = `Personalized outreach is queued for ${names[0]}, ${names[1]}, and ${rem} other${rem !== 1 ? "s" : ""}. Review and send.`;
      }
      recs.push({
        id: "messages-queued",
        urgency: "high",
        icon: "message",
        title: `${messages.length} message${messages.length !== 1 ? "s" : ""} ready to send`,
        body,
        action: "Review outreach queue →",
        navigate: `/c/${club.slug}/messages`,
      });
    }

    // REC 3 — Unassessed players
    if (needsAssessment.length > 50) {
      recs.push({
        id: "unassessed-players",
        urgency: "medium",
        icon: "progress",
        title: `${needsAssessment.length} players need assessment`,
        body: "No progress status set. Assessing players helps the agent recommend the right programs and level up your coaching data.",
        action: "Go to Progress →",
        navigate: `/c/${club.slug}/assessments`,
      });
    }

    // REC 4 — New players this week
    const newPlayerCount = introCards.reduce((sum, card) => sum + (card.new_players?.length ?? 0), 0);
    if (introCards.length > 0 && newPlayerCount > 0) {
      recs.push({
        id: "new-players-week",
        urgency: "good",
        icon: "star",
        title: `${newPlayerCount} new player${newPlayerCount !== 1 ? "s" : ""} this week`,
        body: "First-timers joining sessions this week. Introduce them to familiar faces before they drift.",
        action: "See new player intros →",
        navigate: `/c/${club.slug}/feedback`,
      });
    }

    // REC 5 — Individual urgent lapsing high-risk player
    const urgentLapsing = [...highRiskDrifting]
      .filter((p) => getEngagementState(p.last_visit_date) === "lapsing")
      .sort((a, b) => {
        const aDate = a.last_visit_date ? new Date(a.last_visit_date).getTime() : 0;
        const bDate = b.last_visit_date ? new Date(b.last_visit_date).getTime() : 0;
        return aDate - bDate;
      })[0] ?? null;

    if (urgentLapsing) {
      const parts = urgentLapsing.name.trim().split(" ");
      const firstName = parts[0];
      const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] + "." : "";
      const displayName = lastInitial ? `${firstName} ${lastInitial}` : firstName;
      const daysAway = urgentLapsing.last_visit_date
        ? Math.floor((Date.now() - new Date(urgentLapsing.last_visit_date).getTime()) / 86400000)
        : 0;
      const timeAway =
        daysAway < 30 ? "a few weeks"
        : daysAway < 60 ? "over a month"
        : daysAway < 120 ? "a couple of months"
        : "several months";
      recs.push({
        id: "urgent-player",
        urgency: "critical",
        icon: "person",
        title: `${displayName} needs a nudge today`,
        body: `${firstName} is at high churn risk and hasn't been back in ${timeAway}. A personal message could bring them back.`,
        action: "Send outreach →",
        navigate: `/c/${club.slug}/players`,
        navigateState: { openPlayer: urgentLapsing.id },
      });
    }

    // REC 6 — Session ratings not set up
    if (responseRate === null || responseRate === 0) {
      recs.push({
        id: "no-ratings",
        urgency: "info",
        icon: "star",
        title: "Session ratings not set up yet",
        body: "Post-session feedback texts will help you track level fit and improve session quality automatically.",
        action: "Set up Session Ratings →",
        navigate: `/c/${club.slug}/feedback`,
      });
    }

    // REC 7 — Win-back rate
    if (winbackRate === null || winbackRate === 0) {
      recs.push({
        id: "winback-zero",
        urgency: "info",
        icon: "refresh",
        title: "No win-backs recorded yet",
        body: "Send outreach to inactive players to start building your win-back rate. Even 1–2 returning players per week makes a difference.",
        action: "View inactive players →",
        navigate: `/c/${club.slug}/players`,
        navigateState: { filter: "inactive" },
      });
    }

    const urgencyOrder: Record<RecUrgency, number> = { critical: 0, high: 1, medium: 2, good: 3, info: 4 };
    recs.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);
    return recs;
  }, [players, messages, introCards, responseRate, winbackRate, highRiskPlayers, highRiskDrifting, needsAssessment, club.slug]);

  const DISMISS_TTL = 48 * 60 * 60 * 1000;
  const visibleRecs = recommendations.filter((r) => {
    const ts = dismissedIds[r.id];
    return !ts || Date.now() - ts >= DISMISS_TTL;
  });
  const clampedOffset = Math.min(tileOffset, Math.max(0, visibleRecs.length - 4));
  const visibleTiles = visibleRecs.slice(clampedOffset, clampedOffset + 4);

  const dismissRec = useCallback((id: string) => {
    setDismissingIds((prev) => new Set([...prev, id]));
    setTimeout(() => {
      setDismissedIds((prev) => {
        const updated = { ...prev, [id]: Date.now() };
        localStorage.setItem("pulse_dismissed_recs", JSON.stringify(updated));
        return updated;
      });
      setDismissingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 200);
  }, []);

  const CHURN_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

  const atRiskPlayers = [...players]
    .filter((p) => ["lapsing", "dormant"].includes(getEngagementState(p.last_visit_date)))
    .sort((a, b) => {
      const sa = getEngagementState(a.last_visit_date);
      const sb = getEngagementState(b.last_visit_date);
      if (sa === "lapsing" && sb !== "lapsing") return -1;
      if (sa !== "lapsing" && sb === "lapsing") return 1;
      const ca = CHURN_ORDER[a.churn_risk ?? ""] ?? 3;
      const cb = CHURN_ORDER[b.churn_risk ?? ""] ?? 3;
      if (ca !== cb) return ca - cb;
      const da = a.last_visit_date ? new Date(a.last_visit_date).getTime() : 0;
      const db = b.last_visit_date ? new Date(b.last_visit_date).getTime() : 0;
      return da - db;
    })
    .slice(0, 4);

  const queueDeduped = messages
    .reduce<MessageQueueItem[]>((acc, m) => {
      const pid = m.conversations?.player_id ?? m.conversations?.players?.id ?? null;
      if (!pid || !acc.some((x) => (x.conversations?.player_id ?? x.conversations?.players?.id) === pid)) {
        acc.push(m);
      }
      return acc;
    }, []);
  const queueToShow = queueDeduped.slice(0, 3);

  const allNewPlayers: { player: any; card: any }[] = [];
  for (const card of introCards) {
    for (const np of (card.new_players ?? [])) {
      allNewPlayers.push({ player: np, card });
    }
  }
  const newPlayersToShow = allNewPlayers.slice(0, 4);
  const totalNewPlayers = allNewPlayers.length;

  const introGrouped = new Map<string, typeof newPlayersToShow>();
  for (const item of newPlayersToShow) {
    const key = makeDateFmt(club.timezone).format(new Date(item.card.start_time)).toUpperCase().replace(",", "");
    if (!introGrouped.has(key)) introGrouped.set(key, []);
    introGrouped.get(key)!.push(item);
  }



  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: C.surface }}>
      <Sidebar messageCount={messages.length} />

      <div style={{ marginLeft: 240, flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: C.surface }}>

        {/* ── Topbar ── */}
        <header style={{ height: 52, minHeight: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", borderBottom: `1px solid ${C.border}`, background: C.bg, position: "sticky", top: 0, zIndex: 5 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>Dashboard</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {batchStatus && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: C.textSecondary }}>{batchStatus}</span>
            )}
            <button
              disabled={syncRunning}
              onClick={() => setConfirmDialog({
                message: "This will pull the latest attendance from PodPlay. Best run during off-hours to avoid affecting active users. Continue?",
                onConfirm: () => { setConfirmDialog(null); syncAll(); },
              })}
              style={{ background: "#1e2530", border: `1px solid ${C.border}`, color: C.textSecondary, padding: "5px 12px", borderRadius: 5, fontSize: 12, fontWeight: 500, fontFamily: "var(--font-sans)", cursor: syncRunning ? "not-allowed" : "pointer", opacity: syncRunning ? 0.5 : 1 }}
            >
              {syncRunning ? "Refreshing…" : "Refresh Data"}
            </button>
            <button
              disabled={batchRunning}
              onClick={() => {
                const targetCount = players.filter((p) => ["lapsing", "dormant"].includes(getEngagementState(p.last_visit_date))).slice(0, 50).length;
                const estMin = Math.max(1, Math.round(targetCount * 20 / 60));
                setConfirmDialog({
                  message: `This will generate outreach for ${targetCount} drifting and inactive players (~${estMin} min). Best run during off-hours. Continue?`,
                  onConfirm: () => { setConfirmDialog(null); runBatchAgent(); },
                });
              }}
              style={{ background: C.accent, color: C.bg, border: "none", padding: "5px 14px", borderRadius: 5, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-sans)", cursor: batchRunning ? "not-allowed" : "pointer", opacity: batchRunning ? 0.5 : 1 }}
            >
              {batchRunning ? "Generating…" : "Send Outreach to All"}
            </button>
          </div>
        </header>

        <main style={{ flex: 1, overflowY: "auto", background: C.surface }}>

          {/* ── Recommendation Tiles ── */}
          {!loading && visibleRecs.length > 0 && (
            <div style={{ padding: "16px 24px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, color: "#8b949e", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  Recommendations
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {visibleRecs.length > 4 && (
                    <span
                      style={{ fontSize: 10, color: "#E8A838", cursor: "pointer", fontWeight: 500 }}
                      onClick={() => setTileOffset(0)}
                    >
                      View all {visibleRecs.length} →
                    </span>
                  )}
                  {visibleRecs.length > 4 && (
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        onClick={() => setTileOffset((o) => Math.max(0, o - 4))}
                        disabled={clampedOffset === 0}
                        style={{ width: 28, height: 28, borderRadius: "50%", background: "#1e2530", border: "1px solid #30363d", color: "#8b949e", display: "flex", alignItems: "center", justifyContent: "center", cursor: clampedOffset === 0 ? "not-allowed" : "pointer", opacity: clampedOffset === 0 ? 0.3 : 1, fontSize: 14, padding: 0 }}
                      >‹</button>
                      <button
                        onClick={() => setTileOffset((o) => Math.min(o + 4, Math.max(0, visibleRecs.length - 4)))}
                        disabled={clampedOffset + 4 >= visibleRecs.length}
                        style={{ width: 28, height: 28, borderRadius: "50%", background: "#1e2530", border: "1px solid #30363d", color: "#8b949e", display: "flex", alignItems: "center", justifyContent: "center", cursor: clampedOffset + 4 >= visibleRecs.length ? "not-allowed" : "pointer", opacity: clampedOffset + 4 >= visibleRecs.length ? 0.3 : 1, fontSize: 14, padding: 0 }}
                      >›</button>
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, overflow: "visible" }}>
                {visibleTiles.map((rec) => (
                  <RecTile
                    key={rec.id}
                    rec={rec}
                    dismissing={dismissingIds.has(rec.id)}
                    onDismiss={dismissRec}
                    onNavigate={(path, state) => navigate(path, { state })}
                  />
                ))}
              </div>
              {visibleRecs.length > 4 && (
                <div style={{ display: "flex", justifyContent: "center", gap: 4, marginTop: 10 }}>
                  {Array.from({ length: Math.min(7, visibleRecs.length) }, (_, i) => {
                    const isActive = i >= clampedOffset && i < clampedOffset + 4;
                    return (
                      <div
                        key={i}
                        onClick={() => setTileOffset(Math.min(i, Math.max(0, visibleRecs.length - 4)))}
                        style={{ height: 5, width: isActive ? 12 : 5, borderRadius: 3, background: isActive ? "#E8A838" : "#30363d", cursor: "pointer", transition: "width 0.2s, background 0.2s" }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Stat Strip ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, padding: "16px 24px 0" }}>
            {[
              { label: "ACTIVE PLAYERS", value: active, color: C.green, sub: "playing regularly", onClick: () => navigate(`/c/${club.slug}/players`) },
              highRiskPlayers.length > 10
                ? { label: "HIGH CHURN RISK", value: highRiskPlayers.length, color: "#cf222e", sub: "need outreach now", onClick: () => navigate(`/c/${club.slug}/players`) }
                : { label: "NEED ATTENTION", value: needsAttentionCount, color: C.red, sub: "drifting or inactive", onClick: () => navigate(`/c/${club.slug}/players`) },
              { label: "OUTREACH QUEUE", value: messages.length, color: C.accent, sub: "messages ready to send", onClick: () => navigate(`/c/${club.slug}/messages`) },
            ].map((card) => (
              <div
                key={card.label}
                onClick={card.onClick}
                style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 18px", cursor: "pointer", transition: "border-color 0.15s", userSelect: "none" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = C.accent)}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = C.border)}
              >
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, color: C.textSecondary, letterSpacing: "0.06em", marginBottom: 6 }}>
                  {card.label}
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, color: loading ? C.textSecondary : card.color, lineHeight: 1, fontVariantNumeric: "tabular-nums", marginBottom: 4 }}>
                  {loading ? "—" : card.value}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: C.textSecondary }}>
                  {card.sub}
                </div>
              </div>
            ))}
          </div>

          {/* ── Bento Grid ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "auto auto", gap: 10, padding: "10px 24px 24px" }}>

            {/* Row 1, cols 1–2: Needs Attention */}
            <div style={{ gridColumn: "1 / 3", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
              <PanelHeader
                title="Needs Attention"
                badge={`${needsAttentionCount}`}
                urgentBadge
                onView={() => navigate(`/c/${club.slug}/players`)}
              />
              {atRiskPlayers.length === 0 ? (
                <div style={{ padding: "28px 14px", textAlign: "center", color: C.textSecondary, fontSize: 12 }}>
                  {loading ? "Loading…" : "No players need attention right now ✓"}
                </div>
              ) : (
                <>
                  {atRiskPlayers.map((p) => {
                    const state = getEngagementState(p.last_visit_date);
                    const isRunning = atRiskRunning === p.id;
                    const succeeded = atRiskSucceeded.has(p.id);
                    return (
                      <div key={p.id} style={{ padding: "9px 14px", borderBottom: `1px solid ${C.innerBorder}`, display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            onClick={() => setDrawerPlayerId(p.id)}
                            style={{ fontSize: 12, fontWeight: 500, color: C.textPrimary, cursor: "pointer", marginBottom: 2 }}
                          >
                            {p.name}
                          </div>
                          <div style={{ fontSize: 10, color: C.textSecondary, fontFamily: "var(--font-mono)" }}>
                            {p.skill_level ? `${toTitleCase(p.skill_level)} · ` : ""}{relativeTime(p.last_visit_date)}
                          </div>
                        </div>
                        <StatePillDark state={state} />
                        <div style={{ flexShrink: 0, minWidth: 90, textAlign: "right" }}>
                          {succeeded ? (
                            <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>✓ Added</span>
                          ) : isRunning ? (
                            <div style={{ display: "inline-block", minWidth: 80 }}>
                              <span style={{ fontSize: 10, color: C.textSecondary }}>Sending…</span>
                              <ProgressBar active />
                            </div>
                          ) : (
                            <button
                              onClick={() => handleRunAgent(p.id)}
                              style={{ background: C.accent, color: C.bg, border: "none", fontSize: 10, padding: "3px 10px", borderRadius: 4, fontWeight: 600, fontFamily: "var(--font-sans)", cursor: "pointer" }}
                            >
                              Send Outreach
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div
                    onClick={() => navigate(`/c/${club.slug}/players`)}
                    style={{ padding: "8px 14px", textAlign: "center", fontSize: 10, color: C.accent, cursor: "pointer", borderTop: `1px solid ${C.innerBorder}`, fontWeight: 500 }}
                  >
                    View all {needsAttentionCount} players →
                  </div>
                </>
              )}
            </div>

            {/* Row 1, col 3: Club Health */}
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
              <PanelHeader title="Club Health" viewLabel="View Players →" onView={() => navigate(`/c/${club.slug}/players`)} />
              <div style={{ padding: "12px 14px" }}>
                <div style={{ display: "flex", height: 24, borderRadius: 5, overflow: "hidden", gap: 1, marginBottom: 10 }}>
                  {[
                    { count: active, color: C.green },
                    { count: lapsing, color: C.orange },
                    { count: dormant, color: C.red },
                  ].filter((s) => s.count > 0).map((seg, i) => (
                    <div
                      key={i}
                      style={{ flex: seg.count, minWidth: 4, background: seg.color, display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      {(seg.count / total) > 0.12 && (
                        <span style={{ fontSize: 10, color: "#fff", fontWeight: 600 }}>{seg.count}</span>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "5px 12px", marginBottom: 14 }}>
                  {[
                    { label: "Active", count: active, color: C.green },
                    { label: "Drifting", count: lapsing, color: C.orange },
                    { label: "Inactive", count: dormant, color: C.red },
                    { label: "Never", count: neverVisited, color: C.textSecondary },
                  ].map((item) => (
                    <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: item.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: C.textSecondary }}>{item.label}</span>
                      <span style={{ fontSize: 10, color: C.textPrimary, fontWeight: 600 }}>{item.count}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {[
                    { label: "Response Rate", value: responseRate !== null ? `${responseRate}%` : "—", color: C.accent },
                    { label: "Win-Back Rate", value: winbackRate !== null ? `${winbackRate}%` : "—", color: C.green },
                    { label: "Sent This Month", value: String(sentThisMonth), color: C.textPrimary },
                    { label: "Never Visited", value: String(neverVisited), color: C.textSecondary },
                  ].map((kpi) => (
                    <div key={kpi.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 10, color: C.textSecondary }}>{kpi.label}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: kpi.color, fontFamily: "var(--font-mono)" }}>{kpi.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Row 2, cols 1–2: Outreach Queue */}
            <div style={{ gridColumn: "1 / 3", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
              <PanelHeader
                title="Outreach Queue"
                badge={`${messages.length} pending`}
                onView={() => navigate(`/c/${club.slug}/messages`)}
              />
              {queueToShow.length === 0 ? (
                <div style={{ padding: "28px 14px", textAlign: "center", color: C.textSecondary, fontSize: 12 }}>
                  No messages queued. Use "Send Outreach to All" to generate personalized messages.
                </div>
              ) : (
                <>
                  {queueToShow.map((m) => {
                    const player = m.conversations?.players;
                    const routingTag = m.conversations?.triggered_by;
                    const playerId = m.conversations?.player_id ?? player?.id ?? null;
                    const isEditing = editingId === m.id;
                    const isSending = sending === m.id;
                    const isSkipping = skipping === m.id;
                    const busy = isSending || isSkipping || saving;
                    const cooldownLabel = getCooldownLabel(player?.last_outbound_at ?? null);
                    const didSend = sentSucceeded.has(m.id);

                    return (
                      <div key={m.id} style={{ padding: "10px 14px", borderBottom: `1px solid ${C.innerBorder}`, display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                            <span
                              onClick={() => playerId && setDrawerPlayerId(playerId)}
                              style={{ fontSize: 12, fontWeight: 500, color: C.accent, cursor: playerId ? "pointer" : "default" }}
                            >
                              {player?.name ?? "Unknown"}
                            </span>
                            {routingTag && (
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, padding: "1px 5px", borderRadius: 3, background: C.innerBorder, color: C.textSecondary, border: `1px solid ${C.border}` }}>
                                {routingTag}
                              </span>
                            )}
                            {cooldownLabel && (
                              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "rgba(207,34,46,0.06)", color: C.redText, border: "1px solid rgba(207,34,46,0.15)" }}>
                                {cooldownLabel}
                              </span>
                            )}
                          </div>
                          {isEditing ? (
                            <textarea
                              value={draftBody}
                              onChange={(e) => setDraftBody(e.target.value)}
                              rows={3}
                              style={{ width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 11, fontFamily: "var(--font-sans)", lineHeight: 1.5, border: `1px solid ${C.border}`, borderRadius: 4, background: "#1e2530", color: C.textPrimary, resize: "vertical", outline: "none", marginBottom: 6 }}
                            />
                          ) : (
                            <div style={{ fontSize: 11, color: C.textSecondary, fontStyle: "italic", lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", textOverflow: "ellipsis" } as React.CSSProperties}>
                              {m.body}
                            </div>
                          )}
                        </div>
                        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", paddingTop: 2 }}>
                          {isEditing ? (
                            <>
                              <button
                                onClick={() => saveEdit(m.id)}
                                disabled={saving || draftBody.trim() === ""}
                                style={{ background: C.accent, color: C.bg, border: "none", fontSize: 10, padding: "3px 10px", borderRadius: 4, fontWeight: 600, fontFamily: "var(--font-sans)", cursor: (saving || draftBody.trim() === "") ? "not-allowed" : "pointer", opacity: (saving || draftBody.trim() === "") ? 0.5 : 1 }}
                              >
                                {saving ? "Saving…" : "Save"}
                              </button>
                              <button
                                onClick={() => { setEditingId(null); setDraftBody(""); }}
                                style={{ background: C.innerBorder, border: `1px solid ${C.border}`, color: C.textSecondary, fontSize: 10, padding: "3px 10px", borderRadius: 4, fontFamily: "var(--font-sans)", cursor: "pointer" }}
                              >
                                Cancel
                              </button>
                            </>
                          ) : didSend ? (
                            <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>✓ Sent</span>
                          ) : isSending ? (
                            <div style={{ minWidth: 60, textAlign: "right" }}>
                              <span style={{ fontSize: 10, color: C.textSecondary }}>Sending…</span>
                              <ProgressBar active />
                            </div>
                          ) : (
                            <>
                              <button
                                disabled={busy || !!cooldownLabel}
                                title={cooldownLabel ? `On cooldown — ${cooldownLabel}` : undefined}
                                onClick={() => sendMessage(m.id)}
                                style={{ background: C.accent, color: C.bg, border: "none", fontSize: 10, padding: "3px 10px", borderRadius: 4, fontWeight: 600, fontFamily: "var(--font-sans)", cursor: (busy || !!cooldownLabel) ? "not-allowed" : "pointer", opacity: (busy || !!cooldownLabel) ? 0.4 : 1 }}
                              >
                                Send
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => { setEditingId(m.id); setDraftBody(m.body); }}
                                style={{ background: C.innerBorder, border: `1px solid ${C.border}`, color: C.textSecondary, fontSize: 10, padding: "3px 10px", borderRadius: 4, fontFamily: "var(--font-sans)", cursor: busy ? "not-allowed" : "pointer" }}
                              >
                                Edit
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => skipMessage(m.id)}
                                style={{ background: C.innerBorder, border: `1px solid ${C.border}`, color: C.textSecondary, fontSize: 10, padding: "3px 10px", borderRadius: 4, fontFamily: "var(--font-sans)", cursor: busy ? "not-allowed" : "pointer" }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(207,34,46,0.15)"; (e.currentTarget as HTMLElement).style.color = C.redText; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = C.innerBorder; (e.currentTarget as HTMLElement).style.color = C.textSecondary; }}
                              >
                                {isSkipping ? "Dismissing…" : "Dismiss"}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div
                    onClick={() => navigate(`/c/${club.slug}/messages`)}
                    style={{ padding: "8px 14px", textAlign: "center", fontSize: 10, color: C.accent, cursor: "pointer", borderTop: `1px solid ${C.innerBorder}`, fontWeight: 500 }}
                  >
                    View all {messages.length} messages →
                  </div>
                </>
              )}
            </div>

            {/* Row 2, col 3: New Player Intros */}
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
              <PanelHeader
                title="New Player Intros"
                badge="7 days"
                viewLabel="View All →"
                onView={() => navigate(`/c/${club.slug}/feedback`)}
              />
              {introCardsLoading ? (
                <div style={{ padding: "28px 14px", textAlign: "center", color: C.textSecondary, fontSize: 12 }}>
                  Loading upcoming sessions…
                </div>
              ) : newPlayersToShow.length === 0 ? (
                <div style={{ padding: "28px 14px", textAlign: "center", color: C.textSecondary, fontSize: 12 }}>
                  No new players in the next 7 days
                </div>
              ) : (
                <>
                  {[...introGrouped.entries()].map(([dateLabel, items]) => (
                    <div key={dateLabel}>
                      <div style={{ padding: "4px 12px", fontSize: 9, fontFamily: "var(--font-mono)", color: C.textSecondary, textTransform: "uppercase", letterSpacing: "0.05em", background: C.surface, borderBottom: `1px solid ${C.innerBorder}` }}>
                        {dateLabel}
                      </div>
                      {items.map((item) => (
                        <div key={item.player.player_id} style={{ padding: "8px 12px", borderBottom: `1px solid ${C.innerBorder}` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, flexWrap: "wrap" }}>
                            <span style={{ background: C.green, color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, flexShrink: 0 }}>
                              NEW
                            </span>
                            <span style={{ fontSize: 11, fontWeight: 500, color: C.textPrimary }}>{item.player.name}</span>
                            <span style={{ fontSize: 10, color: C.textSecondary, fontFamily: "var(--font-mono)" }}>
                              {visitLabel(item.player.visit_count)}
                            </span>
                          </div>
                          {(item.player.buddy_connections ?? []).length > 0 && (
                            <div style={{ fontSize: 10, color: C.textSecondary, fontStyle: "italic", marginLeft: 2 }}>
                              → knows {(item.player.buddy_connections as any[]).slice(0, 2).map((b: any) => b.name.split(" ")[0]).join(" & ")}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                  {totalNewPlayers > 4 && (
                    <div
                      onClick={() => navigate(`/c/${club.slug}/feedback`)}
                      style={{ padding: "8px 14px", textAlign: "center", fontSize: 10, color: C.accent, cursor: "pointer", borderTop: `1px solid ${C.innerBorder}`, fontWeight: 500 }}
                    >
                      View {totalNewPlayers - 4} more this week →
                    </div>
                  )}
                </>
              )}
            </div>

          </div>
        </main>

        {drawerPlayerId && (
          <PlayerDrawer
            playerId={drawerPlayerId}
            clubId={club.id}
            onClose={() => setDrawerPlayerId(null)}
          />
        )}

        {confirmDialog && (
          <ConfirmDialog
            message={confirmDialog.message}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => setConfirmDialog(null)}
          />
        )}
      </div>
    </div>
  );
}
