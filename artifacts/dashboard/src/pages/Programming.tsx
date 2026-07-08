/**
 * Programming — Program Catalog & Historical Fill Rates
 *
 * Two display slots per archetype: Peak Day and Off-Peak Day.
 * Season (peak/off-peak) is collapsed — fill and n aggregate across both seasons.
 * is_peak_season stays in event_fill but is not surfaced here.
 *
 * Expandable rows show raw program-name variants sourced from attendances.
 */

import { Fragment, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";

// ── Palette ───────────────────────────────────────────────────────────────────

const C = {
  bg:          "#0d1117",
  surface:     "#161b22",
  surface2:    "#1c2128",
  surface3:    "#13161b",
  border:      "#21262d",
  borderDark:  "#30363d",
  text:        "#e6edf3",
  textSub:     "#8b949e",
  textDim:     "#484f58",
  accent:      "#e8a838",
  accentDim:   "rgba(232,168,56,0.12)",
  green:       "#3fb950",
  greenDim:    "rgba(63,185,80,0.12)",
  yellow:      "#d29922",
  yellowDim:   "rgba(210,153,34,0.12)",
  red:         "#f85149",
  redDim:      "rgba(248,81,73,0.12)",
  clinic:      "#388bfd",
  clinicDim:   "rgba(56,139,253,0.12)",
  openplay:    "#bc8cff",
  openplayDim: "rgba(188,140,255,0.12)",
  mono:        "var(--font-mono, 'JetBrains Mono', monospace)",
  sans:        "var(--font-sans, system-ui, sans-serif)",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface RatingSlice {
  daily_peak: boolean;
  fill_rate: number | null;
  event_count: number;
  median_velocity_days: number | null;
  new_player_share: number | null;
}

interface VariantDayStats {
  fill_rate: number | null;
  event_count: number;
}

interface Variant {
  raw_name: string;
  event_count: number;
  peak_day: VariantDayStats | null;
  off_peak_day: VariantDayStats | null;
}

interface Archetype {
  id: string;
  canonical_name: string;
  canonical_type: "clinic" | "open_play";
  match_priority: number;
  overrides_podplay_type: boolean;
  ratings: RatingSlice[];
  variants: Variant[];
}

interface CatalogResponse {
  computed_at: string | null;
  archetypes: Archetype[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(v: number | null): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function confidenceColor(n: number): string {
  if (n >= 20) return C.green;
  if (n >= 5)  return C.yellow;
  return C.red;
}

function confidenceLabel(n: number): string {
  if (n >= 20) return "high";
  if (n >= 5)  return "low";
  return "thin";
}

function fillColor(rate: number | null): string {
  if (rate === null) return C.textDim;
  if (rate >= 0.8)   return C.green;
  if (rate >= 0.5)   return C.yellow;
  return C.red;
}

// ── Slot cell (archetype row) ─────────────────────────────────────────────────

function SlotCell({ rating }: { rating: RatingSlice | undefined }) {
  if (!rating) {
    return (
      <td style={{ padding: "10px 14px", color: C.textDim, fontFamily: C.mono, fontSize: 12, textAlign: "right" }}>
        —
      </td>
    );
  }
  const n = rating.event_count;
  const fill = rating.fill_rate;
  return (
    <td style={{ padding: "10px 14px", textAlign: "right", borderLeft: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end" }}>
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: fillColor(fill) }}>
          {pct(fill)}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: confidenceColor(n), background: n >= 20 ? C.greenDim : n >= 5 ? C.yellowDim : C.redDim, borderRadius: 3, padding: "1px 5px" }}>
          n={n} · {confidenceLabel(n)}
        </span>
      </div>
    </td>
  );
}

// ── Variant slot cell (sub-row) ───────────────────────────────────────────────

function VarCell({ stats }: { stats: VariantDayStats | null }) {
  if (!stats) {
    return (
      <td style={{ padding: "7px 14px", color: C.textDim, fontFamily: C.mono, fontSize: 11, textAlign: "right", borderLeft: `1px solid ${C.border}` }}>
        —
      </td>
    );
  }
  const n = stats.event_count;
  const fill = stats.fill_rate;
  return (
    <td style={{ padding: "7px 14px", textAlign: "right", borderLeft: `1px solid ${C.border}` }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end" }}>
        <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 600, color: fillColor(fill) }}>
          {pct(fill)}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 9, color: confidenceColor(n), background: n >= 20 ? C.greenDim : n >= 5 ? C.yellowDim : C.redDim, borderRadius: 3, padding: "1px 5px" }}>
          n={n} · {confidenceLabel(n)}
        </span>
      </div>
    </td>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type DaysFilter = 7 | 30 | 90 | null;

const FILTER_OPTIONS: { label: string; value: DaysFilter }[] = [
  { label: "All time", value: null },
  { label: "90d",      value: 90 },
  { label: "30d",      value: 30 },
  { label: "7d",       value: 7 },
];

export default function Programming() {
  const [archetypes, setArchetypes] = useState<Archetype[]>([]);
  const [computedAt, setComputedAt]   = useState<string | null>(null);
  const [days, setDays]               = useState<DaysFilter>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = days
          ? `/api/programs/catalog?slug=pb-club&days=${days}`
          : "/api/programs/catalog?slug=pb-club";
        const res = await fetch(url);
        if (!res.ok) throw new Error(`catalog fetch: ${res.status}`);
        const data: CatalogResponse = await res.json();
        if (!cancelled) {
          setArchetypes(data.archetypes);
          setComputedAt(data.computed_at);
          setExpandedIds(new Set()); // collapse all on window change
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [days]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Index rating slices by archetype id + daily_peak (season collapsed)
  const ratingIndex = new Map<string, RatingSlice>();
  for (const arch of archetypes) {
    for (const r of arch.ratings) {
      ratingIndex.set(`${arch.id}|${r.daily_peak}`, r);
    }
  }

  const hasRatings  = archetypes.some((a) => a.ratings.length > 0);
  const totalEvents = archetypes.reduce(
    (sum, a) => sum + a.ratings.reduce((s, r) => s + r.event_count, 0),
    0,
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, fontFamily: C.sans }}>
      <Sidebar />

      <main style={{ marginLeft: 240, flex: 1, padding: "36px 40px", minWidth: 0 }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>
              Programming
            </h1>
            <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textDim, letterSpacing: "0.04em" }}>
              PROGRAM CATALOG & FILL RATES
            </span>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: C.textSub, lineHeight: 1.6 }}>
            Historical utilization per archetype. Click any row to expand raw program-name variants.
            Fill rate = final signups ÷ capacity (full-population, not member-subset).
          </p>
        </div>

        {/* Time filter chips */}
        <div style={{ display: "flex", gap: 8, marginBottom: 24, alignItems: "center" }}>
          <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textDim, marginRight: 4 }}>WINDOW</span>
          {FILTER_OPTIONS.map((opt) => {
            const active = days === opt.value;
            return (
              <button
                key={String(opt.value)}
                onClick={() => setDays(opt.value)}
                style={{
                  fontFamily: C.mono, fontSize: 11,
                  fontWeight: active ? 700 : 400,
                  color: active ? C.bg : C.textSub,
                  background: active ? C.accent : "transparent",
                  border: `1px solid ${active ? C.accent : C.border}`,
                  borderRadius: 5, padding: "5px 12px",
                  cursor: "pointer", transition: "all 0.12s",
                }}
              >
                {opt.label}
              </button>
            );
          })}
          {days !== null && (
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.textDim, marginLeft: 4 }}>
              velocity &amp; new-player share hidden for windowed views
            </span>
          )}
        </div>

        {/* Summary strip */}
        {!loading && !error && (
          <div style={{ display: "flex", gap: 16, marginBottom: 28, flexWrap: "wrap" }}>
            {[
              { label: "Archetypes", value: archetypes.length },
              { label: "Historical events", value: totalEvents },
              {
                label: "Ratings computed",
                value: hasRatings && computedAt
                  ? new Date(computedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  : "—",
              },
            ].map((s) => (
              <div key={s.label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 18px", minWidth: 130 }}>
                <div style={{ fontFamily: C.mono, fontSize: 18, fontWeight: 700, color: C.text }}>{s.value}</div>
                <div style={{ fontFamily: C.mono, fontSize: 10, color: C.textDim, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {loading && <div style={{ color: C.textSub, fontFamily: C.mono, fontSize: 12 }}>Loading catalog…</div>}
        {error   && <div style={{ color: C.red, fontFamily: C.mono, fontSize: 12 }}>Error: {error}</div>}

        {!loading && !error && (
          <>
            {!hasRatings && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "20px 24px", marginBottom: 24, fontFamily: C.mono, fontSize: 12, color: C.textSub }}>
                ⚠ No computed ratings yet — ratings are computed nightly (Steps 8a/8b).
                Run <code style={{ color: C.accent }}>computeProgramRatings</code> to populate.
              </div>
            )}

            {/* Confidence legend */}
            <div style={{ display: "flex", gap: 20, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textDim }}>CONFIDENCE</span>
              {[
                { label: "high (n≥20)", color: C.green,  bg: C.greenDim  },
                { label: "low (n 5–19)", color: C.yellow, bg: C.yellowDim },
                { label: "thin (n<5)",  color: C.red,    bg: C.redDim    },
              ].map((l) => (
                <span key={l.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontFamily: C.mono, fontSize: 10, color: l.color, background: l.bg, borderRadius: 3, padding: "1px 6px" }}>
                    {l.label}
                  </span>
                </span>
              ))}
              <span style={{ marginLeft: "auto", fontFamily: C.mono, fontSize: 10, color: C.textDim }}>
                fill = final signups ÷ capacity · capped at 100%
              </span>
            </div>

            {/* Table */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: C.surface2, borderBottom: `1px solid ${C.borderDark}` }}>
                    <th style={{ padding: "11px 16px", textAlign: "left", fontFamily: C.mono, fontSize: 10, color: C.textDim, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                      Archetype
                    </th>
                    <th style={{ padding: "11px 14px", textAlign: "center", fontFamily: C.mono, fontSize: 10, color: C.textDim, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                      Events
                    </th>
                    <th style={{ padding: "11px 14px", textAlign: "right", fontFamily: C.mono, fontSize: 10, color: C.accent, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", borderLeft: `1px solid ${C.border}` }}>
                      Peak Day
                    </th>
                    <th style={{ padding: "11px 14px", textAlign: "right", fontFamily: C.mono, fontSize: 10, color: C.textSub, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", borderLeft: `1px solid ${C.border}` }}>
                      Off-Peak Day
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {archetypes.map((arch, idx) => {
                    const isClinic   = arch.canonical_type === "clinic";
                    const typeColor  = isClinic ? C.clinic   : C.openplay;
                    const typeBg     = isClinic ? C.clinicDim : C.openplayDim;
                    const totalN     = arch.ratings.reduce((s, r) => s + r.event_count, 0);
                    const isExpanded = expandedIds.has(arch.id);
                    const hasVariants = arch.variants.length > 0;
                    const isLast     = idx === archetypes.length - 1;

                    const peakRating    = ratingIndex.get(`${arch.id}|true`);
                    const offpeakRating = ratingIndex.get(`${arch.id}|false`);

                    return (
                      <Fragment key={arch.id}>
                        {/* ── Archetype row ── */}
                        <tr
                          key={arch.id}
                          onClick={() => hasVariants && toggleExpand(arch.id)}
                          style={{
                            borderBottom: (!isExpanded && !isLast) ? `1px solid ${C.border}` : "none",
                            background: isExpanded ? C.surface2 : "transparent",
                            cursor: hasVariants ? "pointer" : "default",
                          }}
                        >
                          <td style={{ padding: "12px 16px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              {/* Expand chevron */}
                              {hasVariants && (
                                <span style={{ fontFamily: C.mono, fontSize: 10, color: C.textDim, width: 12, flexShrink: 0, userSelect: "none" }}>
                                  {isExpanded ? "▼" : "▶"}
                                </span>
                              )}
                              <span style={{ fontFamily: C.mono, fontSize: 9, fontWeight: 600, color: typeColor, background: typeBg, borderRadius: 3, padding: "2px 6px", letterSpacing: "0.05em", textTransform: "uppercase", flexShrink: 0 }}>
                                {isClinic ? "Clinic" : "Open Play"}
                              </span>
                              <span style={{ fontSize: 13, fontWeight: 500, color: C.text }}>
                                {arch.canonical_name}
                              </span>
                            </div>
                            <div style={{ fontFamily: C.mono, fontSize: 10, color: C.textDim, marginTop: 3, paddingLeft: hasVariants ? 22 : 2 }}>
                              priority {arch.match_priority}
                              {hasVariants && (
                                <span style={{ marginLeft: 8, color: C.textDim }}>
                                  · {arch.variants.length} variant{arch.variants.length !== 1 ? "s" : ""}
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: "12px 14px", textAlign: "center" }}>
                            <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: totalN > 0 ? C.textSub : C.textDim }}>
                              {totalN > 0 ? totalN : "—"}
                            </span>
                          </td>
                          <SlotCell rating={peakRating} />
                          <SlotCell rating={offpeakRating} />
                        </tr>

                        {/* ── Variant sub-rows ── */}
                        {isExpanded && arch.variants.map((v, vi) => {
                          const isLastVariant = vi === arch.variants.length - 1;
                          return (
                            <tr
                              key={`${arch.id}|var|${v.raw_name}`}
                              style={{
                                background: C.surface3,
                                borderBottom: (isLastVariant && !isLast) ? `1px solid ${C.border}` : isLastVariant ? "none" : `1px solid ${C.borderDark}`,
                              }}
                            >
                              <td style={{ padding: "7px 16px 7px 44px" }}>
                                <span style={{ fontSize: 12, color: C.textSub, fontFamily: C.sans }}>
                                  {v.raw_name}
                                </span>
                              </td>
                              <td style={{ padding: "7px 14px", textAlign: "center" }}>
                                <span style={{ fontFamily: C.mono, fontSize: 12, color: C.textDim }}>
                                  {v.event_count}
                                </span>
                              </td>
                              <VarCell stats={v.peak_day} />
                              <VarCell stats={v.off_peak_day} />
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footnote */}
            <div style={{ marginTop: 16, fontFamily: C.mono, fontSize: 10, color: C.textDim, lineHeight: 1.7 }}>
              Fill rate is full-population (PodPlay signups ÷ capacity, capped at 100%). Season (peak/off-peak) is collapsed — each cell aggregates events across both seasons.
              Variant names sourced from tracked-member attendances; events with no tracked member are excluded from variant rows.
            </div>
          </>
        )}
      </main>
    </div>
  );
}
