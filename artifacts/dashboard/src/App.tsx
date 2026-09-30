import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate, useLocation } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { Component, type ReactNode, useEffect, useState } from "react";
import { ClubProvider, useClubStatus } from "./lib/ClubContext";
import Dashboard from "./pages/Dashboard";
import Players from "./pages/Players";
import Assessments from "./pages/Assessments";
import Messages from "./pages/Messages";
import Settings from "./pages/Settings";
import SessionFeedback from "./pages/SessionFeedback";
import Programming from "./pages/Programming";
import Programs from "./pages/Programs";
import Rules from "./pages/Rules";
import Onboarding from "./pages/Onboarding";

// ─── Error Boundary ───────────────────────────────────────────────────────────

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

// ─── Onboarding guard ─────────────────────────────────────────────────────────
// Checks onboarding status on first load. If the club has not completed
// onboarding it redirects to /onboarding before rendering any dashboard page.

function OnboardingGuard({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Never block the onboarding page itself
    if (location.pathname === "/onboarding") {
      setReady(true);
      return;
    }

    // A deep link must check its own club, not the first club in the database.
    const encodedSlug = location.pathname.match(/^\/c\/([^/]+)/)?.[1]
      ?? (location.pathname === "/" ? "pb-club" : null);
    const query = encodedSlug ? `?slug=${encodedSlug}` : "";
    const controller = new AbortController();
    const api = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";
    fetch(`${api}/onboarding/status${query}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { onboarded?: boolean }) => {
        if (!controller.signal.aborted && data.onboarded === false) {
          navigate("/onboarding", { replace: true });
        }
      })
      .catch(() => {
        // On any network error fall through and show the dashboard
      })
      .finally(() => { if (!controller.signal.aborted) setReady(true); });
    return () => controller.abort();
  }, [location.pathname, navigate]);

  if (!ready) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0d1117",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "#6e7681",
        }}
      >
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}

// ─── Club layout ──────────────────────────────────────────────────────────────
// Mounts ClubProvider (which reads :slug from the URL) and gates the child
// routes on the resolved club status.

function ClubGate() {
  const ctx = useClubStatus();

  if (ctx.status === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0d1117",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "#6e7681",
        }}
      >
        Loading club…
      </div>
    );
  }

  if (ctx.status === "not_found") {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0d1117",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          color: "#6e7681",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "#cf222e" }}>
          Club not found
        </span>
        <span style={{ color: "#30363d" }}>/c/{ctx.slug}</span>
      </div>
    );
  }

  if (ctx.status === "error") {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#0d1117",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          color: "#cf222e",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Error loading club
        </span>
        <span style={{ color: "#8b949e", fontSize: 12 }}>{ctx.error}</span>
      </div>
    );
  }

  return <Outlet />;
}

function ClubLayout() {
  return (
    <ClubProvider>
      <ClubGate />
    </ClubProvider>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ToastProvider>
        <OnboardingGuard>
          <Routes>
            {/* Standalone onboarding flow — no sidebar */}
            <Route path="/onboarding" element={<Onboarding />} />

            {/* Root redirect → default club (single-club Phase 0) */}
            <Route path="/" element={<Navigate to="/c/pb-club/dashboard" replace />} />

            {/* Club-scoped routes — all gated by ClubLayout */}
            <Route path="/c/:slug" element={<ClubLayout />}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route
                path="dashboard"
                element={
                  <ErrorBoundary pageName="Dashboard">
                    <Dashboard />
                  </ErrorBoundary>
                }
              />
              <Route
                path="players"
                element={
                  <ErrorBoundary pageName="Players">
                    <Players />
                  </ErrorBoundary>
                }
              />
              <Route
                path="assessments"
                element={
                  <ErrorBoundary pageName="Assessments">
                    <Assessments />
                  </ErrorBoundary>
                }
              />
              <Route
                path="messages"
                element={
                  <ErrorBoundary pageName="Messages">
                    <Messages />
                  </ErrorBoundary>
                }
              />
              <Route
                path="settings"
                element={
                  <ErrorBoundary pageName="Settings">
                    <Settings />
                  </ErrorBoundary>
                }
              />
              <Route
                path="feedback"
                element={
                  <ErrorBoundary pageName="Session Feedback">
                    <SessionFeedback />
                  </ErrorBoundary>
                }
              />
              <Route
                path="programming"
                element={
                  <ErrorBoundary pageName="Programming">
                    <Programming />
                  </ErrorBoundary>
                }
              />
              <Route
                path="programs"
                element={
                  <ErrorBoundary pageName="Programs">
                    <Programs />
                  </ErrorBoundary>
                }
              />
              <Route
                path="rules"
                element={
                  <ErrorBoundary pageName="Rules">
                    <Rules />
                  </ErrorBoundary>
                }
              />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </OnboardingGuard>
      </ToastProvider>
    </BrowserRouter>
  );
}
