import { useCallback, useEffect, useState } from "react";

type PastExperiment = {
  id: string;
  name: string;
  event_name: string;
  event_start: string | null;
  status: string;
  counts?: { treatment: number; control: number; sent: number };
};

export default function ArchivedExperiments({ api, clubId }: { api: string; clubId: string }) {
  const [experiments, setExperiments] = useState<PastExperiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${api}/experiments?clubId=${encodeURIComponent(clubId)}`, { signal });
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      const data = await response.json();
      if (!signal?.aborted) {
        setExperiments((data.experiments ?? []).filter(
          (exp: PastExperiment) => !exp.event_start || new Date(exp.event_start).getTime() <= Date.now(),
        ));
        setError(null);
      }
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : "Could not load archived experiments");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, clubId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const id = setInterval(() => { void load(controller.signal); }, 30_000);
    return () => { controller.abort(); clearInterval(id); };
  }, [load]);

  if (loading) return <div style={{ color: "#9ca3af", fontSize: 13 }}>Loading past experiments…</div>;
  if (error) return <div style={{ color: "#ef6c6c", fontSize: 13 }}>Could not load past experiments: {error}</div>;
  if (experiments.length === 0) return <div style={{ color: "#9ca3af", fontSize: 13 }}>No past experiments.</div>;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", color: "#e5e7eb", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#9ca3af", textAlign: "left", borderBottom: "1px solid #30343e" }}>
            {["Experiment", "Program", "Started", "Status", "Treatment", "Control", "Sent"].map(label => (
              <th key={label} style={{ padding: "8px 10px", fontWeight: 500 }}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {experiments.map(exp => (
            <tr key={exp.id} style={{ borderBottom: "1px solid #30343e" }}>
              <td style={{ padding: "10px" }}>{exp.name}</td>
              <td style={{ padding: "10px" }}>{exp.event_name}</td>
              <td style={{ padding: "10px", whiteSpace: "nowrap" }}>
                {exp.event_start ? new Date(exp.event_start).toLocaleString() : "Unknown"}
              </td>
              <td style={{ padding: "10px" }}>{exp.status}</td>
              <td style={{ padding: "10px" }}>{exp.counts?.treatment ?? "—"}</td>
              <td style={{ padding: "10px" }}>{exp.counts?.control ?? "—"}</td>
              <td style={{ padding: "10px" }}>{exp.counts?.sent ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}