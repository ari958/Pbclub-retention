import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, CalendarDays, MessageSquareText, RefreshCw, ShieldAlert, Users } from "lucide-react";
import { getGetRetentionReportsQueryKey, useGetRetentionReports } from "@workspace/api-client-react";
import type { RetentionPlaybookOutcome, RetentionSmsOptout } from "@workspace/api-client-react";
import { Sidebar } from "@/components/Sidebar";
import { useClub } from "@/lib/ClubContext";
import "./Reports.css";

type Period = "30d" | "90d" | "all";
type SortKey = "name" | "lastSent" | "texts" | "status" | "program" | "days" | "step" | "code" | "opted";
type SortDirection = "asc" | "desc";

const periodLabels: Record<Period, string> = { "30d": "Last 30 days", "90d": "Last 90 days", all: "All time" };
const formatDate = (value: string | null | undefined) => value
  ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))
  : "—";
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const countRate = (count: number, total: number) => total > 0 ? `${count} of ${total} · ${percent(count / total)}` : `${count} of 0 · —`;
const stepCount = (outcome: RetentionPlaybookOutcome, step: 1 | 2) => Number(step === 1 ? outcome.step1_sent : outcome.step2_sent);

function StatCard({ label, value, detail, tone = "neutral", icon }: { label: string; value: string | number; detail: string; tone?: string; icon: ReactNode }) {
  return <article className={`report-stat report-stat-${tone}`}>
    <div className="report-stat-top"><span className="report-stat-icon">{icon}</span><span className="report-eyebrow">{label}</span></div>
    <strong>{value}</strong><span className="report-stat-detail">{detail}</span>
  </article>;
}

function Funnel({ step, outcomes }: { step: 1 | 2; outcomes: RetentionPlaybookOutcome[] }) {
  const fields = ["drafted", "approved", "sent", "delivered", "booked"] as const;
  const counts = fields.map((field) => outcomes.filter((item) => item[`step${step}_${field}`]).length);
  const max = Math.max(counts[0], 1);
  return <section className="report-panel funnel-panel">
    <header className="panel-heading"><div><span className="report-eyebrow">MESSAGE PATH</span><h3>Step {step}</h3></div><span className="funnel-total">{outcomes.length} players</span></header>
    <div className="funnel-steps">
      {fields.map((field, index) => <div className="funnel-stage" key={field}>
        <div className="funnel-stage-meta"><span>{field}</span><strong>{counts[index]} <small>{countRate(counts[index], index ? counts[index - 1] : outcomes.length)}</small></strong></div>
        <div className="funnel-track"><i style={{ width: `${Math.max(3, (counts[index] / max) * 100)}%` }} /></div>
      </div>)}
    </div>
  </section>;
}

function displayStatus(status: string) {
  return status.replaceAll("_", " ");
}

export default function Reports() {
  const club = useClub();
  const [period, setPeriod] = useState<Period>("30d");
  const [playbook, setPlaybook] = useState("ltp_followup");
  const [sortKey, setSortKey] = useState<SortKey>("lastSent");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const params = useMemo(() => ({ slug: club.slug, playbook_key: playbook, period }), [club.slug, playbook, period]);
  const query = useGetRetentionReports(params, { query: { queryKey: getGetRetentionReportsQueryKey(params), staleTime: 30_000, refetchInterval: 60_000 } });
  const data = query.data;
  const outcomes = data?.outcomes ?? [];
  const sentCount = outcomes.filter(item => item.step1_sent || item.step2_sent).length;
  const textCount = outcomes.reduce((sum, item) => sum + stepCount(item, 1) + stepCount(item, 2), 0);
  const bookedCount = outcomes.filter((item) => item.booked).length;
  const replies = outcomes.filter((item) => item.replied).length;
  const codes = outcomes.filter((item) => Boolean(item.coupon_code_used)).length;
  const step1Sent = outcomes.filter((item) => item.step1_sent).length;
  const step2Sent = outcomes.filter((item) => item.step2_sent).length;
  const step1Optouts = outcomes.filter((item) => item.opted_out && item.optout_after_step === 1).length;
  const step2Optouts = outcomes.filter((item) => item.opted_out && item.optout_after_step === 2).length;

  const sortedOutcomes = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    const values = (row: RetentionPlaybookOutcome): string | number | boolean => {
      switch (sortKey) {
        case "name": return row.name.toLocaleLowerCase();
        case "lastSent": return row.last_sent_at ? new Date(row.last_sent_at).getTime() : 0;
        case "texts": return Number(row.step1_sent) + Number(row.step2_sent);
        case "status": return row.sequence_status;
        case "program": return row.booked_program_name ?? "";
        case "days": return row.days_to_book ?? -1;
        case "step": return row.credited_step ?? 0;
        case "code": return row.coupon_code_used ?? "";
        case "opted": return row.opted_out;
      }
    };
    return [...outcomes].sort((a, b) => {
      const av = values(a), bv = values(b);
      return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv))) * direction;
    });
  }, [outcomes, sortDirection, sortKey]);

  const changeSort = (key: SortKey) => {
    if (key === sortKey) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDirection(key === "lastSent" ? "desc" : "asc"); }
  };

  const activeKeys = data?.playbook_keys ?? [];
  const availableKeys = activeKeys.includes(playbook) ? activeKeys : [...activeKeys, playbook];
  const optouts = [...(data?.optouts ?? [])].sort((a, b) => new Date(b.opted_out_at ?? 0).getTime() - new Date(a.opted_out_at ?? 0).getTime());
  const sortMark = (key: SortKey) => sortKey === key ? (sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null;

  return <div className="reports-page">
    <div className={`reports-sidebar-nav${mobileNavOpen ? " is-open" : ""}`}>
      <button type="button" className="reports-mobile-menu" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)} data-testid="button-toggle-navigation">
        {mobileNavOpen ? "Close navigation" : "Menu · Navigation"}
      </button>
      <Sidebar />
    </div>
    <div className="reports-shell">
      <header className="reports-topbar"><div className="topbar-title"><span className="topbar-mark"><BarChart3 size={16} /></span><span>Retention / Reports</span></div><span className="club-tag">{club.name}</span></header>
      <main className="reports-content">
        <section className="reports-intro">
          <div className="intro-copy"><span className="report-eyebrow">RETENTION INTELLIGENCE <i /></span><h1>Reports</h1><p>See what happens after the first message — from delivery through return visit.</p></div>
          <div className="reports-filters">
            <label><span>PLAYBOOK</span><select aria-label="Select playbook" data-testid="select-playbook" value={playbook} onChange={(event) => setPlaybook(event.target.value)}>
              {availableKeys.length ? availableKeys.map((key) => <option value={key} key={key}>{key === "ltp_followup" ? "Learn to Play follow-up" : key.replaceAll("_", " ")}</option>) : <option value="ltp_followup">Learn to Play follow-up</option>}
            </select></label>
            <label><span>WINDOW</span><select aria-label="Select date range" data-testid="select-period" value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
              {(Object.entries(periodLabels) as [Period, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          </div>
        </section>

        {query.isLoading && <section className="report-loading" aria-label="Loading reports" data-testid="status-reports-loading">
          <div className="loading-line wide" /><div className="loading-stats">{[0, 1, 2, 3].map((item) => <div className="loading-card" key={item}><i /><i /><i /></div>)}</div><div className="loading-table"><i /><i /><i /><i /></div>
        </section>}
        {query.isError && <section className="reports-state error-state" role="alert" data-testid="status-reports-error"><span className="state-icon"><AlertTriangle size={20} /></span><h2>Reports couldn’t load</h2><p>{query.error instanceof Error ? query.error.message : "The club report is temporarily unavailable."}</p><button type="button" onClick={() => query.refetch()} data-testid="button-retry-reports"><RefreshCw size={14} /> Try again</button></section>}

        {!query.isLoading && !query.isError && data && <>
          <section className="club-optout-banner" data-testid="value-club-opt-out-total"><div className="optout-banner-mark"><ShieldAlert size={18} /></div><div><span className="report-eyebrow">CLUB-WIDE OPT-OUTS</span><p>Across all retention flows, independent of the selected playbook.</p></div><strong>{data.club_opt_out_total.toLocaleString()}</strong><span className="banner-unit">events</span></section>

          <section className="report-stat-grid" aria-label="Retention summary">
            <StatCard label="Texted" value={sentCount} detail={`${textCount} texts · ${outcomes.length} sequences`} icon={<MessageSquareText size={16} />} tone="gold" />
            <StatCard label="Booked" value={bookedCount} detail={countRate(bookedCount, sentCount)} icon={<CalendarDays size={16} />} tone="mint" />
            <StatCard label="Baseline rate" value={data.baseline ? percent(data.baseline.rate ?? 0) : "—"} detail={data.baseline ? `${data.baseline.n_booked} of ${data.baseline.n_players}` : "No baseline defined."} icon={<Users size={16} />} />
            <StatCard label="Code redemptions" value={codes} detail={countRate(codes, sentCount)} icon={<span className="code-glyph">%</span>} tone="violet" />
            <StatCard label="Replies" value={replies} detail={countRate(replies, sentCount)} icon={<MessageSquareText size={16} />} />
          </section>

          <section className="report-panel optout-rates">
            <div className="panel-heading"><div><span className="report-eyebrow">FLOW HEALTH</span><h3>Opt-out by step</h3></div><span className="panel-note">Rate among messages sent</span></div>
            <div className="optout-rate-grid">
              <div className="optout-rate-item"><span>Step 1</span><strong>{percent(step1Sent ? step1Optouts / step1Sent : 0)}</strong><small>{step1Optouts} of {step1Sent} sent</small><div className="rate-track"><i style={{ width: `${step1Sent ? Math.min(100, step1Optouts / step1Sent * 100) : 0}%` }} /></div></div>
              <div className="optout-rate-item step-two"><span>Step 2</span><strong>{percent(step2Sent ? step2Optouts / step2Sent : 0)}</strong><small>{step2Optouts} of {step2Sent} sent</small><div className="rate-track"><i style={{ width: `${step2Sent ? Math.min(100, step2Optouts / step2Sent * 100) : 0}%` }} /></div></div>
            </div>
          </section>

          <section className="funnel-grid" aria-label="Message step funnels"><Funnel step={1} outcomes={outcomes} /><Funnel step={2} outcomes={outcomes} /></section>

          <section className="report-panel player-panel">
            <header className="panel-heading player-panel-heading"><div><span className="report-eyebrow">PLAYER OUTCOMES</span><h3>Flow participants <span>{outcomes.length}</span></h3></div><span className="sort-hint">Select a column to sort</span></header>
            {outcomes.length === 0 ? <div className="inline-empty"><span className="empty-dot" /><div><strong>No outcomes in this window</strong><p>When this playbook has sent messages, player-level results will appear here.</p></div></div> : <div className="report-table-wrap"><table className="report-table">
              <thead><tr>{([["name", "Player"], ["lastSent", "Last sent"], ["texts", "Texts sent"], ["status", "Sequence status"], ["program", "Booked program"], ["days", "Days to book"], ["step", "Credited step"], ["code", "Code used"], ["opted", "Opted out"]] as [SortKey, string][]).map(([key, label]) => <th key={key}><button type="button" onClick={() => changeSort(key)} data-testid={`sort-${key}`}>{label}{sortMark(key)}</button></th>)}</tr></thead>
              <tbody>{sortedOutcomes.map((row) => {
                const sent = Number(row.step1_sent) + Number(row.step2_sent);
                return <tr key={row.sequence_id} data-testid={`row-player-${row.sequence_id}`}>
                  <td><strong className="player-name">{row.name || "Unknown player"}</strong><span className="player-last-sent">{formatDate(row.last_sent_at)}</span></td>
                  <td>{formatDate(row.last_sent_at)}</td>
                  <td><span className="table-count">{sent}</span><span className="table-subtext">{row.step1_sent_at ? "S1" : ""}{row.step1_sent_at && row.step2_sent_at ? " · " : ""}{row.step2_sent_at ? "S2" : ""}</span></td>
                  <td><span className={`status-pill status-${row.sequence_status}`}>{displayStatus(row.sequence_status)}</span></td>
                  <td>{row.booked_program_name || "—"}</td>
                  <td>{row.days_to_book == null ? "—" : `${row.days_to_book} days`}</td>
                  <td>{row.credited_step == null ? "—" : `Step ${row.credited_step}`}</td>
                  <td>{row.coupon_code_used ? <span className="coupon-chip">{row.coupon_code_used}</span> : "—"}</td>
                  <td><span className={`opt-state ${row.opted_out ? "yes" : "no"}`}>{row.opted_out ? "Yes" : "No"}</span></td>
                </tr>;
              })}</tbody>
            </table></div>}
          </section>

          <section className="report-panel optouts-panel">
            <header className="panel-heading"><div><span className="report-eyebrow">COMPLIANCE ACTIVITY</span><h3>Recent opt-outs <span>{optouts.length}</span></h3></div><span className="panel-note">Newest first</span></header>
            {optouts.length === 0 ? <div className="inline-empty"><span className="empty-dot quiet" /><div><strong>No recorded opt-outs</strong><p>This panel covers all flows and dates.</p></div></div> : <div className="optout-list">
              {optouts.map((item: RetentionSmsOptout) => <article className="optout-event" key={item.id} data-testid={`row-optout-${item.id}`}>
                <div className="optout-event-date">{formatDate(item.opted_out_at)}<span>{item.name || "Unknown player"}</span></div>
                <div className="optout-message"><p>{item.body || "No preceding text is available."}</p><span>{item.playbook_key ? item.playbook_key.replaceAll("_", " ") : "No playbook attributed"}</span></div>
                <div className="optout-meta"><span className="step-chip">{item.step == null ? "Step —" : `Step ${item.step}`}</span><span className={`source-chip ${item.source === "unattributed" ? "unattributed" : ""}`}>{item.source}</span></div>
              </article>)}
            </div>}
          </section>
          <footer className="reports-footnote"><span>Club-scoped report</span><span>{periodLabels[data.period as Period] ?? periodLabels[period]} · read only</span></footer>
        </>}
      </main>
    </div>
  </div>;
}
