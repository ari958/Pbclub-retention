import type { EngagementState } from "./types";

/** Parse a date-only string (YYYY-MM-DD) as a local date, not UTC midnight. */
function parseDateOnly(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function getEngagementState(lastVisitDate: string | null): EngagementState {
  if (!lastVisitDate) return "never-visited";
  const daysSince = (Date.now() - parseDateOnly(lastVisitDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 14) return "active";
  if (daysSince <= 30) return "lapsing";
  return "dormant";
}

export function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const days = Math.floor((Date.now() - parseDateOnly(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return parseDateOnly(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function dateOnlyMs(dateStr: string): number {
  return parseDateOnly(dateStr).getTime();
}

export const STATE_COLORS: Record<EngagementState, string> = {
  active: "var(--state-active)",
  lapsing: "var(--state-lapsing)",
  dormant: "var(--state-dormant)",
  "never-visited": "var(--text-tertiary)",
};

export const STATE_BG: Record<EngagementState, string> = {
  active: "rgba(46,160,67,0.10)",
  lapsing: "rgba(212,129,58,0.10)",
  dormant: "rgba(207,34,46,0.10)",
  "never-visited": "rgba(100,100,100,0.08)",
};

export function toTitleCase(key: string): string {
  return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
