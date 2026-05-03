import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { Component, type ReactNode } from "react";
import Dashboard from "./pages/Dashboard";
import Players from "./pages/Players";
import Assessments from "./pages/Assessments";
import Messages from "./pages/Messages";
import Settings from "./pages/Settings";
import SessionFeedback from "./pages/SessionFeedback";

// ─── Error Boundary ───────────────────────────────────────────────────────────
// Catches runtime errors in any page so a crash in one doesn't blank the whole app.

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<
  { children: ReactNode; pageName: string },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode; pageName: string }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(`[ErrorBoundary] ${this.props.pageName} crashed:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            marginLeft: 240,
            padding: "48px 40px",
            fontFamily: "var(--font-sans)",
            display: "flex",
            flexDirection: "column",
            gap: 16,
            maxWidth: 520,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 500,
              color: "var(--state-dormant)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {this.props.pageName} — unexpected error
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
            Something went wrong on this page
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              lineHeight: 1.6,
            }}
          >
            {this.state.error?.message ?? "An unknown error occurred."}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-tertiary)",
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "10px 12px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {this.state.error?.stack?.slice(0, 600) ?? "No stack trace available"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              alignSelf: "flex-start",
              padding: "7px 16px",
              borderRadius: 5,
              fontSize: 13,
              fontWeight: 500,
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── 404 ──────────────────────────────────────────────────────────────────────

function NotFound() {
  return (
    <div style={{ padding: "2rem", fontFamily: "var(--font-sans)" }}>
      <h1>404 — Page not found</h1>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ToastProvider>
        <Routes>
          <Route
            path="/"
            element={
              <ErrorBoundary pageName="Dashboard">
                <Dashboard />
              </ErrorBoundary>
            }
          />
          <Route
            path="/players"
            element={
              <ErrorBoundary pageName="Players">
                <Players />
              </ErrorBoundary>
            }
          />
          <Route
            path="/assessments"
            element={
              <ErrorBoundary pageName="Assessments">
                <Assessments />
              </ErrorBoundary>
            }
          />
          <Route
            path="/messages"
            element={
              <ErrorBoundary pageName="Messages">
                <Messages />
              </ErrorBoundary>
            }
          />
          <Route
            path="/settings"
            element={
              <ErrorBoundary pageName="Settings">
                <Settings />
              </ErrorBoundary>
            }
          />
          <Route
            path="/feedback"
            element={
              <ErrorBoundary pageName="Session Feedback">
                <SessionFeedback />
              </ErrorBoundary>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
