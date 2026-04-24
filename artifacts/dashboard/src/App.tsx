import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

function Home() {
  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Dashboard</h1>
      <p>Your dashboard is ready. Start building pages in <code>src/pages/</code>.</p>
    </div>
  );
}

function NotFound() {
  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>404 — Page not found</h1>
      <a href={import.meta.env.BASE_URL}>Go home</a>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
