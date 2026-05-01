import { createClient } from "@supabase/supabase-js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function daysSince(isoString: string | null): number {
  if (!isoString) return 9999;
  return (Date.now() - new Date(isoString).getTime()) / MS_PER_DAY;
}

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  );
}

export async function computeLevelConfidence(playerId: string): Promise<void> {
  const supabase = getSupabase();

  const [playerRes, attRes] = await Promise.all([
    supabase
      .from("players")
      .select("coach_assigned_level, coach_level_set_at, dupr_rating, dupr_updated_at")
      .eq("id", playerId)
      .single(),
    supabase
      .from("attendances")
      .select("program_name, attended_at")
      .eq("player_id", playerId)
      .not("program_name", "is", null),
  ]);

  if (playerRes.error || !playerRes.data) {
    console.error(`[levelConfidence] player fetch failed for ${playerId}:`, playerRes.error?.message);
    return;
  }
  if (attRes.error) {
    console.error(`[levelConfidence] attendance fetch failed for ${playerId}:`, attRes.error.message);
    return;
  }

  const player = playerRes.data;
  const attendances: { program_name: string; attended_at: string }[] = attRes.data ?? [];
  if (attendances.length === 0) return;

  // Group attendances by program_name → treat program_name as "level"
  const byLevel = new Map<string, { sessions: number; lastAt: string }>();
  for (const att of attendances) {
    const level = att.program_name;
    const cur = byLevel.get(level);
    if (!cur) {
      byLevel.set(level, { sessions: 1, lastAt: att.attended_at });
    } else {
      cur.sessions++;
      if (att.attended_at > cur.lastAt) cur.lastAt = att.attended_at;
    }
  }

  const [taxRes, fbRes] = await Promise.all([
    supabase.from("level_taxonomy").select("level, rank"),
    supabase.from("session_feedback").select("level, fit_rating").eq("player_id", playerId),
  ]);

  const taxMap = new Map<string, number>(
    (taxRes.data ?? []).map((t: any) => [t.level as string, t.rank as number])
  );

  const fbMap = new Map<string, { positive: number; total: number }>();
  for (const fb of fbRes.data ?? []) {
    const cur = fbMap.get(fb.level) ?? { positive: 0, total: 0 };
    cur.total++;
    if (fb.fit_rating === 1) cur.positive++;
    fbMap.set(fb.level, cur);
  }

  const coachLevel = player.coach_assigned_level ?? null;
  const coachSetAt = player.coach_level_set_at ?? null;
  const duprRating: number | null = player.dupr_rating ?? null;
  const duprUpdatedAt: string | null = player.dupr_updated_at ?? null;
  const coachRank = coachLevel ? (taxMap.get(coachLevel) ?? null) : null;

  const upserts: Record<string, unknown>[] = [];

  for (const [level, { sessions, lastAt }] of byLevel) {
    const daysSinceLast = daysSince(lastAt);

    // C1 — Session exposure (max 25)
    const C1_raw = 25 * Math.log(sessions + 1) / Math.log(11);
    const recencyDecay = Math.exp(-0.5 * daysSinceLast / 180);
    const C1 = C1_raw * recencyDecay;

    // C2 — Peer fit (max 25)
    const fb = fbMap.get(level) ?? { positive: 0, total: 0 };
    const C2 = fb.total >= 3 ? 25 * (fb.positive / fb.total) : 12.5;

    // C3 — Coach assignment (max 35)
    let C3 = 0;
    if (coachLevel !== null && coachRank !== null) {
      const bookingRank = taxMap.get(level) ?? null;
      if (bookingRank !== null) {
        const distance = Math.abs(coachRank - bookingRank);
        const base = 35 * Math.max(0, 1 - 0.4 * distance);
        const daysAssessment = daysSince(coachSetAt);
        const decay = Math.exp(-0.693 * daysAssessment / 90);
        C3 = base * decay;
      }
    }

    // C4 — DUPR alignment (max 15)
    let C4 = 0;
    if (duprRating !== null) {
      const bookingRank = taxMap.get(level) ?? null;
      if (bookingRank !== null) {
        const duprImpliedRank = Math.round(duprRating);
        const alignment = Math.max(0, 1 - Math.abs(duprImpliedRank - bookingRank));
        const base = 15 * alignment;
        const daysDupr = daysSince(duprUpdatedAt);
        const decay = Math.exp(-0.693 * daysDupr / 60);
        C4 = base * decay;
      }
    }

    const score = Math.min(100, C1 + C2 + C3 + C4);

    // Certainty
    const c1_cert = Math.min(1.0, sessions / 10);
    const c2_cert = Math.min(1.0, fb.total / 5);
    const c3_cert = coachLevel !== null ? 1.0 : 0;
    const c4_cert = duprRating !== null ? 0.5 : 0;
    const certainty = (c1_cert * 0.25) + (c2_cert * 0.30) + (c3_cert * 0.35) + (c4_cert * 0.10);

    upserts.push({
      player_id: playerId,
      level,
      sessions,
      days_since_last: Math.round(daysSinceLast),
      peer_positive: fb.positive,
      peer_total: fb.total,
      score: Math.round(score * 100) / 100,
      certainty: Math.round(certainty * 1000) / 1000,
      last_computed: new Date().toISOString(),
    });
  }

  if (upserts.length === 0) return;

  const { error } = await supabase
    .from("level_confidence")
    .upsert(upserts, { onConflict: "player_id,level" });

  if (error) {
    console.error(`[levelConfidence] upsert failed for ${playerId}:`, error.message);
  }
}
