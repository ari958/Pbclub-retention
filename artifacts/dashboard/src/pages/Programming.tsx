/**
 * Programming — Program Catalog & Historical Fill Rates
 *
 * Reads from:
 *   programs      — archetypes (canonical_name, canonical_type, match_priority)
 *   program_ratings — computed fill rates per archetype × slot (daily_peak × season)
 *   event_fill    — raw event count per archetype for the header summary
 *
 * Fill rates are historical (completed past events only).
 * Attendances-based metrics (velocity, new_player_share) are labeled
 * as member-subset signals — not full-population.
 */

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";

// ── Palette ───────────────────────────────────────────────────────────────────

const C = {
  bg:          "#0d1117",
  surface:     "#161b22",
  surface2:    "#1c2128",
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
  season: "peak" | "off_peak";
  fill_rate: number | null;
  event_count: number;
  median_velocity_days: number | null;
  new_player_share: number | null;
}

interface Archetype {
  id: string;
  canonical_name: string;
  canonical_type: "clinic" | "open_play";
  match_priority: number;
  overrides_podplay_type: boolean;
  ratings: RatingSlice[];
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
  if (n >= 5) return C.yellow;
  return C.red;
}

function confidenceLabel(n: number): string {
  if (n >= 20) return "high";
  if (n >= 5) return "low";
  return "thin";
}

function fillColor(rate: number | null): string {
  if (rate === null) return C.textDim;
  if (rate >= 0.8) return C.green;
  if (rate >= 0.5) return C.yellow;
  return C.red;
}

// ── Slot cell ─────────────────────────────────────────────────────────────────

function SlotCell({ rating }: { rating: Rating | undefined }) {
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
    <td style={{ padding: "10px 14px", textAlign: "right" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end" }}>
        <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: fillColor(fill) }}>
          {pct(fill)}
        </span>
        <span
          style={{
            fontFamily: C.mono,
            fontSize: 10,
            color: confidenceColor(n),
            background: n >= 20 ? C.greenDim : n >= 5 ? C.yellowDim : C.redDim,
            borderRadius: 3,
            padding: "1px 5px",
          }}
        >
          n={n} · {confidenceLabel(n)}
        </span>
      </div>
    </td>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Programming() {
  const [archetypes, setArchetypes] = useState<Archetype[]>([]);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/programs/catalog?slug=pb-club");
        if (!res.ok) throw new Error(`catalog fetch: ${res.status}`);
        const data: CatalogResponse = await res.json();
        setArchetypes(data.archetypes);
        setComputedAt(data.computed_at);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Index rating slices by archetype id + slot key
  const ratingIndex = new Map<string, RatingSlice>();
  for (const arch of archetypes) {
    for (const r of arch.ratings) {
      ratingIndex.set(`${arch.id}|${r.daily_peak}|${r.season}`, r);
    }
  }

  const hasRatings = archetypes.some((a) => a.ratings.length > 0);
  const totalEvents = archetypes.reduce(
    (sum, a) => sum + a.ratings.reduce((s, r) => s + r.event_count, 0),
    0,
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, fontFamily: C.sans }}>
      <Sidebar />

      <main style={{ marginLeft: 240, flex: 1, padding: "36px 40px", minWidth: 0 }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>
              Programming
            </h1>
            <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textDim, letterSpacing: "0.04em" }}>
              PROGRAM CATALOG & FILL RATES
            </span>
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: C.textSub, lineHeight: 1.6 }}>
            Historical utilization per archetype, sourced from completed past events.
            Fill rate = final signups ÷ capacity (full-population, not member-subset).
          </p>
        </div>

        {/* Summary strip */}
        {!loading && !error && (
          <div
            style={{
              display: "flex",
              gap: 16,
              marginBottom: 28,
              flexWrap: "wrap",
            }}
          >
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
              <div
                key={s.label}
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: "12px 18px",
                  minWidth: 130,
                }}
              >
                <div style={{ fontFamily: C.mono, fontSize: 18, fontWeight: 700, color: C.text }}>
                  {s.value}
                </div>
                <div style={{ fontFamily: C.mono, fontSize: 10, color: C.textDim, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div style={{ color: C.textSub, fontFamily: C.mono, fontSize: 12 }}>Loading catalog…</div>
        )}

        {error && (
          <div style={{ color: C.red, fontFamily: C.mono, fontSize: 12 }}>Error: {error}</div>
        )}

        {!loading && !error && (
          <>
            {!hasRatings && (
              <div
                style={{
                  background: C.surface,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: "20px 24px",
                  marginBottom: 24,
                  fontFamily: C.mono,
                  fontSize: 12,
                  color: C.textSub,
                }}
              >
                ⚠ No computed ratings yet — ratings are computed nightly (Steps 8a/8b).
                Historical fill data is in event_fill ({totalEvents} events).
                Run <code style={{ color: C.accent }}>computeProgramRatings</code> to populate.
              </div>
            )}

            {/* Legend */}
            <div style={{ display: "flex", gap: 20, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: C.mono, fontSize: 11, color: C.textDim }}>CONFIDENCE</span>
              {[
                { label: "high (n≥20)", color: C.green, bg: C.greenDim },
                { label: "low (n 5–19)", color: C.yellow, bg: C.yellowDim },
                { label: "thin (n<5)", color: C.red, bg: C.redDim },
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
            <div
              style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
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
                      Peak day · Peak season
                    </th>
                    <th style={{ padding: "11px 14px", textAlign: "right", fontFamily: C.mono, fontSize: 10, color: C.textSub, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", borderLeft: `1px solid ${C.border}` }}>
                      Peak day · Off-peak
                    </th>
                    <th style={{ padding: "11px 14px", textAlign: "right", fontFamily: C.mono, fontSize: 10, color: C.textSub, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", borderLeft: `1px solid ${C.border}` }}>
                      Off-peak day · Peak
                    </th>
                    <th style={{ padding: "11px 14px", textAlign: "right", fontFamily: C.mono, fontSize: 10, color: C.textSub, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", borderLeft: `1px solid ${C.border}` }}>
                      Off-peak day · Off-peak
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {archetypes.map((arch, idx) => {
                    const isClinic = arch.canonical_type === "clinic";
                    const typeColor = isClinic ? C.clinic : C.openplay;
                    const typeBg = isClinic ? C.clinicDim : C.openplayDim;
                    const totalN = arch.ratings.reduce((s, r) => s + r.event_count, 0);

                    const r = (dp: boolean, s: "peak" | "off_peak") =>
                      ratingIndex.get(`${arch.id}|${dp}|${s}`);

                    return (
                      <tr
                        key={arch.id}
                        style={{
                          borderBottom: idx < archetypes.length - 1 ? `1px solid ${C.border}` : "none",
                          background: "transparent",
                        }}
                      >
                        <td style={{ padding: "12px 16px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span
                              style={{
                                fontFamily: C.mono,
                                fontSize: 9,
                                fontWeight: 600,
                                color: typeColor,
                                background: typeBg,
                                borderRadius: 3,
                                padding: "2px 6px",
                                letterSpacing: "0.05em",
                                textTransform: "uppercase",
                                flexShrink: 0,
                              }}
                            >
                              {isClinic ? "Clinic" : "Open Play"}
                            </span>
                            <span style={{ fontSize: 13, fontWeight: 500, color: C.text }}>
                              {arch.canonical_name}
                            </span>
                          </div>
                          <div style={{ fontFamily: C.mono, fontSize: 10, color: C.textDim, marginTop: 3, paddingLeft: 2 }}>
                            priority {arch.match_priority}
                          </div>
                        </td>
                        <td style={{ padding: "12px 14px", textAlign: "center" }}>
                          <span
                            style={{
                              fontFamily: C.mono,
                              fontSize: 13,
                              fontWeight: 600,
                              color: totalN > 0 ? C.textSub : C.textDim,
                            }}
                          >
                            {totalN > 0 ? totalN : "—"}
                          </span>
                        </td>
                        <SlotCell rating={r(true, "peak")} />
                        <SlotCell rating={r(true, "off_peak")} />
                        <SlotCell rating={r(false, "peak")} />
                        <SlotCell rating={r(false, "off_peak")} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Member-subset footnote */}
            <div style={{ marginTop: 16, fontFamily: C.mono, fontSize: 10, color: C.textDim, lineHeight: 1.7 }}>
              * Fill rate is full-population (PodPlay signups ÷ capacity). Velocity and new-player share (when shown) are member-subset signals only — tracked members are typically 2–6× fewer than true session attendance.
            </div>
          </>
        )}
      </main>
    </div>
  );
}
