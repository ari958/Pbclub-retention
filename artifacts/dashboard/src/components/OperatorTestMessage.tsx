import { useEffect, useState } from "react";
import { useClub, clubApiUrl } from "@/lib/ClubContext";
import type { OperatorTestState } from "@workspace/api-client-react";

export function OperatorTestMessage() {
  const club = useClub();
  const [state, setState] = useState<OperatorTestState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = clubApiUrl(club.slug, "/api/operator-test-message");
  const refresh = async () => {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not load operator tests");
    setState(data);
  };
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load operator tests");
        if (active) setState(data);
      } catch (e) { if (active) setError(String(e)); }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [url]);
  const send = async () => {
    if (busy || !state?.available) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Operator test failed");
      setState(previous => ({
        available: previous?.available ?? true,
        messages: [data, ...(previous?.messages ?? []).filter(message => message.message_id !== data.message_id)],
      }));
      try { await refresh(); }
      catch { setError(`Twilio accepted ${data.twilio_sid}. Could not refresh the receipt yet; do not resend.`); }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section style={{ background: "#0f1117", border: "1px solid #30363d", borderRadius: 8, padding: 20 }}>
    <h2 style={{ margin: "0 0 10px", fontSize: 14, color: "#e6edf3" }}>Operator test message</h2>
    <p style={{ color: "#8b949e", fontSize: 13 }}>Sends only to the configured test override. Live sending, the kill switch, and the send window must all allow it. Creates no candidate or sequence.</p>
    <blockquote style={{ margin: "12px 0", color: "#e6edf3", fontSize: 13 }}>PB Club production test. No action needed.</blockquote>
    {state?.available ? <button type="button" onClick={() => void send()} disabled={busy}
      style={{ background: "#E8A838", color: "#161b22", border: 0, borderRadius: 6, padding: "10px 14px", cursor: busy ? "wait" : "pointer" }}>
      {busy ? "Sending…" : "Send operator test message"}
    </button> : <p style={{ color: "#8b949e", fontSize: 13 }}>{state ? "Unavailable: SMS_TEST_OVERRIDE_TO is not set." : "Loading test configuration…"}</p>}
    {error && <p role="alert" style={{ color: "#ff6b6b", fontSize: 13 }}>{error}</p>}
    <div aria-live="polite">
      {state?.messages.map(message => <div key={message.message_id} style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid #30363d", color: "#e6edf3", fontSize: 12, overflowWrap: "anywhere" }}>
        <div>Twilio SID: {message.twilio_sid ?? "Not submitted"}</div>
        <div>Delivery status: {message.delivery_status ?? message.status}</div>
        {message.error_message && <div style={{ color: "#ff6b6b" }}>{message.error_message}</div>}
      </div>)}
    </div>
  </section>;
}
