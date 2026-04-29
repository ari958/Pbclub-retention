import { Link, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

interface SidebarProps {
  clubName: string;
  lastSynced?: string | null;
  messageCount?: number;
}

export function Sidebar({ clubName, lastSynced, messageCount = 0 }: SidebarProps) {
  const location = useLocation();
  const [unreadReplies, setUnreadReplies] = useState(0);

  // Poll for unread inbound replies every 30 seconds
  useEffect(() => {
    const fetchUnread = async () => {
      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("direction", "inbound")
        .is("read_at", null);
      setUnreadReplies(count ?? 0);
    };

    fetchUnread();
    const interval = setInterval(fetchUnread, 30000);
    return () => clearInterval(interval);
  }, []);

  // Mark replies as read when navigating to /messages
  useEffect(() => {
    if (location.pathname === "/messages" && unreadReplies > 0) {
      const markRead = async () => {
        await supabase
          .from("messages")
          .update({ read_at: new Date().toISOString() })
          .eq("direction", "inbound")
          .is("read_at", null);
        setUnreadReplies(0);
      };
      // Small delay so the badge is visible briefly before clearing
      const timer = setTimeout(markRead, 1500);
      return () => clearTimeout(timer);
    }
  }, [location.pathname, unreadReplies]);

  // Total Messages badge: pending queue + unread replies
  const messagesBadge = messageCount + unreadReplies;

  const navItems = [
    { label: "Dashboard", path: "/" },
    { label: "Players", path: "/players" },
    { label: "Assessments", path: "/assessments" },
    {
      label: "Messages",
      path: "/messages",
      badge: messagesBadge > 0 ? messagesBadge : undefined,
      // Show reply indicator separately when there are unread replies
      replyAlert: unreadReplies > 0,
    },
    { label: "Settings", path: "/settings" },
  ];

  return (
    <aside
      style={{
        width: 220,
        minWidth: 220,
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
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 18,
            fontWeight: 500,
            color: "var(--accent)",
            letterSpacing: "-0.02em",
          }}
        >
          Pulse
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            marginTop: 4,
            fontWeight: 400,
          }}
        >
          {clubName || "—"}
        </div>
      </div>

      <div style={{ width: "100%", height: 1, background: "var(--border-dark)" }} />

      <nav style={{ flex: 1, padding: "12px 0" }}>
        {navItems.map((item) => {
          const isActive =
            item.path === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(item.path);

          return (
            <Link
              key={item.path}
              to={item.path}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 20px",
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
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {item.label}
                {/* Green dot for unread replies */}
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
                    background: "replyAlert" in item && item.replyAlert
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

      <div
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
      </div>
    </aside>
  );
}
