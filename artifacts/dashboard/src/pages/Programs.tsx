/**
 * Programs — placeholder page.
 * Real screen (programming-agent decisions) comes in a later phase.
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

export default function Programs() {
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
          Programs
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
            <rect x="4" y="4" width="32" height="32" rx="4" />
            <path d="M13 16h14M13 20h10M13 24h7" />
          </svg>
          <div style={{ fontSize: 14, fontWeight: 500, color: C.textSub }}>
            No decisions recorded yet.
          </div>
          <div style={{ fontSize: 12, color: C.textDim, textAlign: "center", maxWidth: 320, lineHeight: 1.6 }}>
            The programming agent will track what sessions ran, what was cancelled,
            and what the model would change — once it's live.
          </div>
        </div>
      </main>
    </div>
  );
}
