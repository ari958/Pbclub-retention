import { createClient } from "@supabase/supabase-js";
// @ts-ignore
import { syncSinglePlayer } from "./syncPlayerAttendance.js";

// Use service role key to bypass RLS for inserts/updates.
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = serviceRoleKey || anonKey;

// ── Startup diagnostics ────────────────────────────────────────────────────
console.log("[import:diag] SUPABASE_URL          :", supabaseUrl);
console.log("[import:diag] SERVICE_ROLE_KEY set?  :", !!serviceRoleKey);
console.log("[import:diag] SERVICE_ROLE_KEY prefix:", serviceRoleKey ? serviceRoleKey.slice(0, 20) + "…" : "(not set)");
console.log("[import:diag] ANON_KEY prefix         :", anonKey ? anonKey.slice(0, 20) + "…" : "(not set)");
console.log("[import:diag] Key being used prefix   :", supabaseKey ? supabaseKey.slice(0, 20) + "…" : "(none!)");
console.log("[import:diag] Keys match? (bad=same)  :", serviceRoleKey === anonKey);

const clientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
};
console.log("[import:diag] Client auth options     :", JSON.stringify(clientOptions.auth));

// Decode the JWT payload (not encrypted — base64 only) to verify role claim
try {
  const parts = supabaseKey?.split(".") ?? [];
  if (parts.length === 3) {
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    console.log("[import:diag] JWT role claim          :", payload.role ?? "(no role field)");
    console.log("[import:diag] JWT iss                 :", payload.iss ?? "(no iss)");
  } else {
    console.log("[import:diag] Key is NOT a JWT (no 3 parts) — format:", supabaseKey?.slice(0, 15));
  }
} catch (e) {
  console.log("[import:diag] Could not decode JWT payload:", e.message);
}

const supabase = createClient(supabaseUrl, supabaseKey, clientOptions);

const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";
const CLUB_ID = "c8976e15-e002-4619-bb4b-b1a70f5cd7ab";
const IPP = 100;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

function mapMembership(membershipType) {
  if (membershipType === "GLOBAL_MEMBER") return "member";
  if (membershipType === "NONE") return "non-member";
  return membershipType?.toLowerCase() ?? "non-member";
}

class CancelledError extends Error {
  constructor() {
    super("Import cancelled by operator");
    this.name = "CancelledError";
  }
}

// ─── PodPlay fetch: all users ─────────────────────────────────────────────────

async function fetchAllPodPlayUsers(isCancelled) {
  const allUsers = [];
  let page = 1;

  while (true) {
    if (isCancelled()) throw new CancelledError();

    const url = `${PODPLAY_BASE}/users?page=${page}&ipp=${IPP}`;
    const res = await fetch(url, {
      headers: { "x-api-key": process.env.PODPLAY_API_KEY },
    });

    if (!res.ok) {
      throw new Error(`PodPlay GET /users page=${page} returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const items = data.items ?? [];
    const pagination = data._pagination ?? {};

    allUsers.push(...items);

    const total = pagination.total ?? null;
    if (items.length < IPP || (total !== null && allUsers.length >= total)) break;
    page++;
  }

  return allUsers;
}

// ─── Main import ──────────────────────────────────────────────────────────────

/**
 * @param {(msg: string) => void} log
 * @param {() => boolean} isCancelled - returns true if the job should stop
 */
export async function importAllPlayers(log = console.log, isCancelled = () => false) {
  const stats = {
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    attendanceSynced: 0,
    attendanceErrors: 0,
  };

  // 1. Read club schedule context for logging
  const { data: clubRow } = await supabase
    .from("clubs")
    .select("id, name, scheduled_sync_time, timezone")
    .eq("id", CLUB_ID)
    .maybeSingle();

  if (clubRow?.scheduled_sync_time) {
    log(`[import] Club: ${clubRow.name} | Scheduled sync: ${clubRow.scheduled_sync_time} ${clubRow.timezone ?? "UTC"}`);
  }

  // 2. Fetch all PodPlay users
  log(`[import] Fetching PodPlay users…`);
  let podplayUsers;
  try {
    podplayUsers = await fetchAllPodPlayUsers(isCancelled);
  } catch (err) {
    if (err.name === "CancelledError") throw err;
    log(`[import] FATAL: Failed to fetch PodPlay users: ${err.message}`);
    throw err;
  }

  log(`[import] Fetched ${podplayUsers.length} PodPlay users. Processing…`);

  // 3. Process each PodPlay user
  let firstInsertDiagDone = false;
  for (const user of podplayUsers) {
    if (isCancelled()) throw new CancelledError();

    stats.processed++;
    const externalId = String(user.id);
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown";
    const phone = formatPhone(user.phoneNumber);
    const email = user.email ?? null;
    const membership = mapMembership(user.membershipType);

    try {
      // Check for existing player by external_id first (already imported → skip)
      const { data: byExtId } = await supabase
        .from("players")
        .select("id, external_id")
        .eq("external_id", externalId)
        .maybeSingle();

      if (byExtId) {
        log(`[import] [${stats.processed}/${podplayUsers.length}] SKIP: ${name} (external_id already set)`);
        stats.skipped++;
        continue;
      }

      // Match by phone, then email
      let existingPlayer = null;
      if (phone) {
        const { data } = await supabase
          .from("players")
          .select("id, external_id")
          .eq("phone", phone)
          .maybeSingle();
        existingPlayer = data;
      }
      if (!existingPlayer && email) {
        const { data } = await supabase
          .from("players")
          .select("id, external_id")
          .eq("email", email)
          .maybeSingle();
        existingPlayer = data;
      }

      if (existingPlayer) {
        const updatePayload = { external_id: externalId, membership_status: membership };
        if (email) updatePayload.email = email;

        const { error } = await supabase
          .from("players")
          .update(updatePayload)
          .eq("id", existingPlayer.id);

        if (error) {
          log(`[import] [${stats.processed}/${podplayUsers.length}] ERROR updating ${name}: ${error.message}`);
          stats.errors++;
        } else {
          log(`[import] [${stats.processed}/${podplayUsers.length}] UPDATE: ${name} → external_id=${externalId}`);
          stats.updated++;
        }
      } else {
        const insertPayload = {
          club_id: CLUB_ID,
          name,
          phone,
          external_id: externalId,
          membership_status: membership,
        };
        if (email) insertPayload.email = email;

        // One-time diagnostic: try raw fetch first to isolate whether the
        // issue is the JS client or the key itself.
        if (!firstInsertDiagDone) {
          firstInsertDiagDone = true;
          log(`[import:diag] FIRST INSERT — testing raw fetch bypass of JS client…`);
          try {
            const rawRes = await fetch(`${supabaseUrl}/rest/v1/players`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`,
                "Prefer": "return=minimal",
              },
              body: JSON.stringify(insertPayload),
            });
            const rawText = await rawRes.text();
            log(`[import:diag] RAW FETCH status: ${rawRes.status}`);
            log(`[import:diag] RAW FETCH body: ${rawText.slice(0, 300)}`);
          } catch (fetchErr) {
            log(`[import:diag] RAW FETCH exception: ${fetchErr.message}`);
          }
        }

        const { error, status: insertStatus } = await supabase
          .from("players")
          .insert(insertPayload);

        if (error) {
          // Log full error object on first failure to expose code/details/hint
          if (stats.errors === 0) {
            log(`[import:diag] FULL ERROR: ${JSON.stringify({ code: error.code, message: error.message, details: error.details, hint: error.hint, status: insertStatus })}`);
          }
          log(`[import] [${stats.processed}/${podplayUsers.length}] ERROR creating ${name}: ${error.message}`);
          stats.errors++;
        } else {
          log(`[import] [${stats.processed}/${podplayUsers.length}] CREATE: ${name} (external_id=${externalId})`);
          stats.created++;
        }
      }
    } catch (err) {
      if (err.name === "CancelledError") throw err;
      log(`[import] [${stats.processed}/${podplayUsers.length}] EXCEPTION for ${name}: ${err.message}`);
      stats.errors++;
    }
  }

  log(`[import] ── Player import complete ──`);
  log(`[import] Processed: ${stats.processed} | Created: ${stats.created} | Updated: ${stats.updated} | Skipped: ${stats.skipped} | Errors: ${stats.errors}`);

  // 4. Sync attendance for all linked players
  if (isCancelled()) throw new CancelledError();

  log(`[import] Starting attendance sync…`);

  const { data: linkedPlayers, error: fetchErr } = await supabase
    .from("players")
    .select("id, external_id")
    .not("external_id", "is", null);

  if (fetchErr) {
    log(`[import] ERROR fetching linked players: ${fetchErr.message}`);
  } else {
    log(`[import] Syncing attendance for ${linkedPlayers.length} players…`);

    for (let i = 0; i < linkedPlayers.length; i++) {
      if (isCancelled()) throw new CancelledError();

      const p = linkedPlayers[i];
      try {
        const result = await syncSinglePlayer(p.id, p.external_id);
        await supabase
          .from("players")
          .update({ last_synced_at: new Date().toISOString() })
          .eq("id", p.id);
        stats.attendanceSynced++;
        log(`[import] Attendance [${i + 1}/${linkedPlayers.length}] ${p.id}: inserted=${result.inserted}, lastVisit=${result.lastVisitDate ?? "—"}`);
      } catch (err) {
        if (err.name === "CancelledError") throw err;
        stats.attendanceErrors++;
        log(`[import] Attendance ERROR [${i + 1}/${linkedPlayers.length}] ${p.id}: ${err.message}`);
      }
    }
  }

  log(`[import] ── All done ──`);
  log(`[import] Attendance synced: ${stats.attendanceSynced} | Attendance errors: ${stats.attendanceErrors}`);

  return stats;
}
