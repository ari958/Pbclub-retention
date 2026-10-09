import { Link } from "react-router-dom";

export interface RunResult { tone: "success" | "info" | "error"; message: string; runIds: string[] }
const TONE = { success: "#2ea043", info: "#E8A838", error: "#ff6b6b" } as const;

export function RunResultBanner({ result, onDismiss }: { result: RunResult; onDismiss: () => void }) {
  const c = TONE[result.tone];
  return (
    <div role="status" data-testid="banner-run-result" style={{ background: "#0f1117", border: `1px solid ${c}`, borderRadius: 7, padding: "10px 14px", fontSize: 12, lineHeight: 1.6, color: "#e6edf3", display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        <span style={{ color: c }}>{result.message}</span>
        {result.runIds.map((id, i) => (
          <Link key={id} to={`?generation_run=${encodeURIComponent(id)}`} data-testid={`link-view-run-${id}`} style={{ color: "#E8A838", marginLeft: 10 }}>
            View details{result.runIds.length > 1 ? ` (${i + 1})` : ""}
          </Link>
        ))}
      </div>
      <button type="button" onClick={onDismiss} data-testid="button-dismiss-run-result" style={{ background: "transparent", border: "1px solid #30363d", color: "#8b949e", borderRadius: 5, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>Dismiss</button>
    </div>
  );
}
