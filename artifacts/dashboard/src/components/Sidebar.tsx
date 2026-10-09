import { Link, useLocation } from "react-router-dom";
import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { clubApiUrl, useClubStatus } from "@/lib/ClubContext";
import { ClubSwitcher } from "./ClubSwitcher";

// ─── Nav mode ─────────────────────────────────────────────────────────────────
// VITE_NAV_MODE controls which nav entries are visible.
//   programming  (default) — programming-agent surfaces only
//   pulse                  — Pulse retention surfaces only (original nav)
//   all                    — both sets visible
//   retention    (default) — Approvals, Players, Messages, Settings; rest parked
import { NAV_MODE, RETENTION } from "@/lib/navMode";

// ─── SVG Icons ────────────────────────────────────────────────────────────────

function IconDashboard() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6.5L8 2L14 6.5V13C14 13.6 13.6 14 13 14H10.5V10H5.5V14H3C2.4 14 2 13.6 2 13V6.5Z" />
    </svg>
  );
}

function IconPlayers() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5" r="2.5" />
      <path d="M1 13c0-2.5 2.2-4 5-4s5 1.5 5 4" />
      <circle cx="12" cy="5.5" r="2" />
      <path d="M11.5 10c1.6.3 2.5 1.2 2.5 2.5" />
    </svg>
  );
}

function IconProgress() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1.5,11.5 5.5,7 8.5,9.5 14.5,3" />
      <polyline points="11,3 14.5,3 14.5,6.5" />
    </svg>
  );
}

function IconStar() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="8,1.5 9.9,6 14.8,6.4 11.2,9.5 12.3,14.3 8,11.8 3.7,14.3 4.8,9.5 1.2,6.4 6.1,6" />
    </svg>
  );
}

function IconMessages() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <polyline points="1.5,3.5 8,9 14.5,3.5" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5V3M8 13V14.5M3 3L4.5 4.5M11.5 11.5L13 13M1.5 8H3M13 8H14.5M3 13L4.5 11.5M11.5 4.5L13 3" />
    </svg>
  );
}

function IconProgramming() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M5 6.5L3 8.5L5 10.5" />
      <path d="M11 6.5L13 8.5L11 10.5" />
      <path d="M9 5.5L7 11.5" />
    </svg>
  );
}

function IconPrograms() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4 6h8M4 8.5h5M4 11h6" />
    </svg>
  );
}

function IconApprovals() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 8.2L7.2 9.9L10.5 6.3" />
    </svg>
  );
}

function IconRules() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5l2.5 2" />
    </svg>
  );
}

// ─── Nav item type ────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  path: string;
  icon: ReactNode;
  badge?: number;
  replyAlert?: boolean;
}

interface SidebarProps {
  lastSynced?: string | null;
  messageCount?: number;
}

export function Sidebar({ lastSynced, messageCount = 0 }: SidebarProps) {
  const location = useLocation();
  const ctx = useClubStatus();
  const slug = ctx.status === "ready" ? ctx.club.slug : "";
  const clubId = ctx.status === "ready" ? ctx.club.id : null;
  const clubDisplayName = ctx.status === "ready" ? ctx.club.name : "—";
  const [unreadReplies, setUnreadReplies] = useState(0);

  useEffect(() => {
    if (!clubId) {
      setUnreadReplies(0);
      return;
    }
    let active = true;
    const fetchUnread = async () => {
      const { count, error } = await supabase
        .from("messages")
        .select("id, players!player_id!inner(club_id)", { count: "exact", head: true })
        .eq("direction", "inbound")
        .eq("players.club_id", clubId)
        .is("read_at", null);
      if (active && !error) setUnreadReplies(count ?? 0);
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [clubId]);

  useEffect(() => {
    const messagesPath = slug ? `/c/${slug}/messages` : null;
    if (messagesPath && clubId && location.pathname === messagesPath && unreadReplies > 0) {
      let active = true;
      const markRead = async () => {
        // The dashboard's anon client is SELECT-only; the write goes through the API.
        const res = await fetch(clubApiUrl(slug, "/api/messages/mark-read"), { method: "POST" });
        const body = await res.json().catch(() => ({}));
        if (active && res.ok && typeof body.unread === "number") setUnreadReplies(body.unread);
      };
      const timer = setTimeout(markRead, 1500);
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }
    return undefined;
  }, [location.pathname, unreadReplies, slug, clubId]);

  const messagesBadge = messageCount + unreadReplies;

  // ── Nav entries by mode ─────────────────────────────────────────────────
  const pulseItems: NavItem[] = slug
    ? [
        { label: "Dashboard",       path: `/c/${slug}/dashboard`,  icon: <IconDashboard /> },
        { label: "Players",         path: `/c/${slug}/players`,    icon: <IconPlayers /> },
        { label: "Progress",        path: `/c/${slug}/assessments`,icon: <IconProgress /> },
        { label: "Session Ratings", path: `/c/${slug}/feedback`,   icon: <IconStar /> },
        {
          label: "Messages",
          path: `/c/${slug}/messages`,
          icon: <IconMessages />,
          badge: messagesBadge > 0 ? messagesBadge : undefined,
          replyAlert: unreadReplies > 0,
        },
        { label: "Programming", path: `/c/${slug}/programming`, icon: <IconProgramming /> },
      ]
    : [];

  const programmingItems: NavItem[] = slug
    ? [
        { label: "Programs", path: `/c/${slug}/programs`, icon: <IconPrograms /> },
        { label: "Rules",    path: `/c/${slug}/rules`,    icon: <IconRules /> },
      ]
    : [];

  const retentionItems: NavItem[] = slug
    ? [
        { label: "Dashboard", path: `/c/${slug}/dashboard`, icon: <IconDashboard /> },
        { label: "Approvals", path: `/c/${slug}/approvals`, icon: <IconApprovals /> },
        { label: "Reports", path: `/c/${slug}/reports`, icon: <IconDashboard /> },
        { label: "Players", path: `/c/${slug}/players`, icon: <IconPlayers /> },
        {
          label: "Messages",
          path: `/c/${slug}/messages`,
          icon: <IconMessages />,
          badge: messagesBadge > 0 ? messagesBadge : undefined,
          replyAlert: unreadReplies > 0,
        },
      ]
    : [];

  const sharedItems: NavItem[] = slug
    ? [{ label: "Settings", path: `/c/${slug}/settings`, icon: <IconSettings /> }]
    : [];

  const navItems: NavItem[] =
    [
      ...(NAV_MODE === "retention" ? retentionItems : []),
      ...(NAV_MODE === "pulse" || NAV_MODE === "all" ? pulseItems : []),
      ...(NAV_MODE === "programming" || NAV_MODE === "all" ? programmingItems : []),
      ...sharedItems,
    ];

  return (
    <aside
      style={{
        width: 240,
        minWidth: 240,
        height: "100vh",
        position: "fixed",
        top: 0,
        left: 0,
        background: "var(--bg-primary)",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid var(--border-dark)",
        zIndex: 10,
      }}
    >
      <div style={{ padding: "20px 20px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--accent)",
              flexShrink: 0,
              animation: "pulseBreath 2.4s ease-in-out infinite",
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 22,
              fontWeight: 700,
              color: "var(--accent)",
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            Pulse
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            marginTop: 7,
            fontWeight: 400,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {clubDisplayName}
        </div>
      </div>

      <div style={{ width: "100%", height: 1, background: "var(--border-dark)" }} />

      {/* Keep the switcher implementation parked during single-club retention testing. */}
      {NAV_MODE !== "retention" && <ClubSwitcher />}

      <nav style={{ flex: 1, padding: "12px 0" }}>
        {navItems.map((item) => {
          const isActive = location.pathname.startsWith(item.path);

          return (
            <Link
              key={item.path}
              to={item.path}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "9px 20px",
                fontSize: 13,
                fontWeight: isActive ? 500 : 400,
                color: isActive ? "#fff" : "var(--text-tertiary)",
                borderLeft: isActive
                  ? "3px solid var(--accent)"
                  : "3px solid transparent",
                background: isActive
                  ? "rgba(232,168,56,0.08)"
                  : "transparent",
                transition: "color 0.15s, background 0.15s",
                textDecoration: "none",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ opacity: isActive ? 1 : 0.65, display: "flex", flexShrink: 0 }}>
                  {item.icon}
                </span>
                {item.label}
                {"replyAlert" in item && item.replyAlert && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--state-active)",
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                )}
              </span>
              {item.badge !== undefined && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    fontFamily: "var(--font-mono)",
                    background:
                      "replyAlert" in item && item.replyAlert
                        ? "var(--state-active)"
                        : "var(--accent)",
                    color: "#fff",
                    borderRadius: 10,
                    padding: "1px 6px",
                    minWidth: 18,
                    textAlign: "center",
                  }}
                >
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <form action="/api/operator/logout" method="post" style={{ padding: "12px 20px" }}>
        <button type="submit" style={{ background: "transparent", color: "var(--text-tertiary)", border: "1px solid var(--border-dark)", borderRadius: 6, padding: "8px 14px", cursor: "pointer" }}>
          Log out
        </button>
      </form>

      {!RETENTION && <div
        style={{
          padding: "16px 20px",
          borderTop: "1px solid var(--border-dark)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--state-active)",
              flexShrink: 0,
              boxShadow: "0 0 4px var(--state-active)",
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-tertiary)",
            }}
          >
            {lastSynced ? `synced ${lastSynced}` : "sync live"}
          </span>
        </div>
      </div>}
    </aside>
  );
}
