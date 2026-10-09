import { getGetPlayerSmsStatusQueryKey, useGetPlayerSmsStatus } from "@workspace/api-client-react";
import { playerSmsStatusLabel } from "@/lib/playerSmsStatus";

/** Read-only: private opt-out history stays behind the authenticated API. */
export function PlayerSmsStatus({ playerId, slug, timezone }: {
  playerId: string; slug: string; timezone: string;
}) {
  const params = { slug };
  const { data, isPending, isError } = useGetPlayerSmsStatus(playerId, params, {
    query: {
      queryKey: getGetPlayerSmsStatusQueryKey(playerId, params),
      refetchInterval: 30000,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      retry: false,
    },
  });
  const value = isError ? "Unavailable" : isPending || !data ? "Loading…" : playerSmsStatusLabel(data, timezone);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
      <span style={{ fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0 }}>SMS</span>
      <span aria-live="polite" style={{ fontSize: 12, color: "var(--text-primary)", textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}
