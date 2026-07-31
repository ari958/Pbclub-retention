/**
 * Rules — placeholder page.
 * Real screen (cancellation thresholds, offset config) comes in a later phase.
 */
import { Sidebar } from "@/components/Sidebar";

const C = {
  bg:      "#0d1117",
  surface: "#161b22",
  border:  "#21262d",
  text:    "#e6edf3",
  textSub: "#8b949e",
  textDim: "#484f58",
  accent:  "#e8a838",
  mono:    "var(--font-mono, 'JetBrains Mono', monospace)",
  sans:    "var(--font-sans, system-ui, sans-serif)",
};

export default function Rules() {
  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, fontFamily: C.sans }}>
      <Sidebar />
      <main style={{ marginLeft: 240, flex: 1, padding: "48px 40px", maxWidth: 900 }}>
        <div
          style={{
            fontFamily: C.mono,
            fontSize: 10,
            fontWeight: 500,
            color: C.textDim,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: 16,
          }}
        >
          Programming Agent
        </div>
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: C.text,
            letterSpacing: "-0.02em",
            marginBottom: 8,
          }}
        >
          Rules
        </div>

        {/* Empty state */}
        <div
          style={{
            marginTop: 64,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <svg
            width="40"
            height="40"
            viewBox="0 0 40 40"
            fill="none"
            stroke={C.textDim}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="20" cy="20" r="16" />
            <path d="M20 12v8l5 5" />
          </svg>
          <div style={{ fontSize: 14, fontWeight: 500, color: C.textSub }}>
            No rules configured yet.
          </div>
          <div style={{ fontSize: 12, color: C.textDim, textAlign: "center", maxWidth: 320, lineHeight: 1.6 }}>
            Cancellation thresholds, decision offsets, and program-type overrides
            will be managed here.
          </div>
        </div>
      </main>
    </div>
  );
}
