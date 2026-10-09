export const RUN_COLORS = { green: "#2ea043", amber: "#E8A838", red: "#ff6b6b", gray: "#8b949e" } as const;

export function statusMeta(status: string | null | undefined): { label: string; color: string } {
  switch (status) {
    case "success": return { label: "Success", color: RUN_COLORS.green };
    case "partial": return { label: "Partial", color: RUN_COLORS.amber };
    case "failed": return { label: "Failed", color: RUN_COLORS.red };
    case "skipped": return { label: "Skipped", color: RUN_COLORS.gray };
    default: return { label: "Running", color: RUN_COLORS.gray };
  }
}

export function fmtDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}
export function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}
export function dayKey(iso: string | number | Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
export function fmtDuration(start: string, end: string | null): string {
  if (!end) return "in progress";
  const s = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function isHistoryUnavailable(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 503;
}
export function errText(e: unknown): string {
  const x = e as { data?: { error?: string }; message?: string } | null;
  return x?.data?.error ?? x?.message ?? "Request failed";
}
export const RUN_QUERY = { refetchInterval: 30000, refetchOnWindowFocus: true, refetchIntervalInBackground: false, retry: false } as const;
