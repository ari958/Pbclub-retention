/**
 * ClubSwitcher — sidebar dropdown for switching active clubs.
 *
 * Lists all clubs via /api/clubs. Selecting one navigates to
 * /c/<slug>/<current-page-path>, preserving the current page when possible.
 *
 * In Phase 0 (no auth) every dashboard user sees every club. Phase 0.5
 * adds a user→clubs join table and filters this list. The component's
 * shape doesn't change; only the data source narrows.
 *
 * Drop into Sidebar.tsx at the top, above the nav items.
 */

import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useClubStatus } from "../lib/ClubContext";

interface ClubListItem {
  id: string;
  slug: string;
  name: string;
  timezone: string;
}

export function ClubSwitcher() {
  const navigate = useNavigate();
  const location = useLocation();
  const ctx = useClubStatus();
  const [clubs, setClubs] = useState<ClubListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/clubs")
      .then((r) => r.json())
      .then((body: { clubs?: ClubListItem[] }) => {
        if (cancelled) return;
        setClubs(body.clubs ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newSlug = e.target.value;
    if (!newSlug) return;
    // Replace just the :slug segment, keep the rest of the path.
    // location.pathname looks like /c/<oldSlug>/players → /c/<newSlug>/players
    const parts = location.pathname.split("/");
    // parts: ["", "c", "<oldSlug>", "players", ...]
    if (parts[1] === "c" && parts.length >= 3) {
      parts[2] = newSlug;
      navigate(parts.join("/") + location.search);
    } else {
      // Fallback — go to the club root
      navigate(`/c/${newSlug}`);
    }
  }

  // While the current club is resolving and we have no list yet, render
  // a stable placeholder so the sidebar doesn't jump
  if (loading && ctx.status !== "ready") {
    return (
      <div style={{ padding: "8px 12px", fontSize: 12, opacity: 0.6 }}>
        Loading clubs…
      </div>
    );
  }

  const currentSlug = ctx.status === "ready" ? ctx.club.slug : "";

  // If only one club exists, render a static label (no need for a dropdown)
  if (clubs.length <= 1) {
    return (
      <div
        style={{
          padding: "8px 12px",
          fontSize: 13,
          fontWeight: 500,
          borderBottom: "1px solid var(--border, #e4e5d8)",
        }}
      >
        {ctx.status === "ready" ? ctx.club.name : "—"}
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border, #e4e5d8)" }}>
      <label
        htmlFor="club-switcher"
        style={{
          display: "block",
          fontSize: 11,
          fontFamily: "var(--font-mono, monospace)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          opacity: 0.6,
          marginBottom: 4,
        }}
      >
        Active Club
      </label>
      <select
        id="club-switcher"
        value={currentSlug}
        onChange={handleChange}
        style={{
          width: "100%",
          padding: "6px 8px",
          fontSize: 14,
          fontFamily: "inherit",
          border: "1px solid var(--border, #e4e5d8)",
          borderRadius: 4,
          background: "var(--surface, #fff)",
        }}
      >
        {clubs.map((c) => (
          <option key={c.id} value={c.slug}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
