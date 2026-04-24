import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import Dashboard from "./pages/Dashboard";
import Players from "./pages/Players";
import Assessments from "./pages/Assessments";
import Messages from "./pages/Messages";
import Settings from "./pages/Settings";

function NotFound() {
  return (
    <div style={{ padding: "2rem", fontFamily: "var(--font-sans)" }}>
      <h1>404 — Page not found</h1>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/players" element={<Players />} />
          <Route path="/assessments" element={<Assessments />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
