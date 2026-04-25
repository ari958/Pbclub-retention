import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";
const DELAY_MS = 200;
const BATCH_SIZE = 500; // fetch players in pages to avoid huge payloads

class CancelledError extends Error {
  constructor() {
    super("Phone import cancelled by operator");
    this.name = "CancelledError";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalise a raw phone string from PodPlay to E.164 +1XXXXXXXXXX.
 * PodPlay already returns E.164 for US numbers; this is a safety net.
 */
function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Non-US or unexpected — store as-is but only if it looks phone-like
  if (digits.length >= 7) return raw.startsWith("+") ? raw : `+${digits}`;
  return null;
}

/**
 * Fetches phone number from PodPlay for a single user.
 * Returns { phoneNumber, smsOptIn } or null on 404.
 * Retries once on 429 after a 3 second back-off.
 */
async function fetchPhoneNumber(externalId) {
  const url = `${PODPLAY_BASE}/users/${externalId}/phone-number`;
  const headers = { "x-api-key": process.env.PODPLAY_API_KEY };

  let res = await fetch(url, { headers });

  if (res.status === 429) {
    await sleep(3000);
    res = await fetch(url, { headers });
  }

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`PodPlay /users/${externalId}/phone-number → ${res.status}: ${await res.text()}`);

  return res.json();
}

/**
 * Import phone numbers for all players that have an external_id but no phone.
 *
 * @param {(msg: string) => void} log
 * @param {() => boolean} isCancelled
 */
export async function importPhoneNumbers(log = console.log, isCancelled = () => false) {
  const stats = {
    total: 0,
    updated: 0,
    skipped: 0,   // phoneNumber was null in PodPlay response
    errors: 0,
  };

  // ── Load all eligible players in pages ────────────────────────────────────
  log("[phone-import] Querying players without phone numbers…");

  const players = [];
  let from = 0;
  const pageSize = BATCH_SIZE;

  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, name, external_id")
      .not("external_id", "is", null)
      .is("phone", null)
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Failed to query players: ${error.message}`);
    if (!data || data.length === 0) break;

    players.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  stats.total = players.length;
  log(`[phone-import] ${players.length} players need phone numbers`);

  if (players.length === 0) {
    log("[phone-import] Nothing to do — all linked players already have a phone.");
    return stats;
  }

  // ── Process each player ───────────────────────────────────────────────────
  for (let i = 0; i < players.length; i++) {
    if (isCancelled()) throw new CancelledError();

    const player = players[i];
    const progress = `[${i + 1}/${players.length}]`;

    await sleep(DELAY_MS);

    let apiData;
    try {
      apiData = await fetchPhoneNumber(player.external_id);
    } catch (err) {
      log(`[phone-import] ${progress} ERROR for "${player.name}": ${err.message}`);
      stats.errors++;
      continue;
    }

    const phone = formatPhone(apiData?.phoneNumber ?? null);

    if (!phone) {
      log(`[phone-import] ${progress} "${player.name}" — no phone in PodPlay, skipping`);
      stats.skipped++;
      continue;
    }

    // sms_opt_in = true when PodPlay has a phone number on record
    const sms_opt_in = true;
    const last4 = phone.slice(-4);

    const { error: updateErr } = await supabase
      .from("players")
      .update({ phone, sms_opt_in })
      .eq("id", player.id);

    if (updateErr) {
      log(`[phone-import] ${progress} DB ERROR for "${player.name}": ${updateErr.message}`);
      stats.errors++;
    } else {
      log(`[phone-import] ${progress} "${player.name}" → ***${last4} | sms_opt_in: ${sms_opt_in}`);
      stats.updated++;
    }
  }

  log(
    `[phone-import] ── Complete ──\n` +
    `  Total eligible: ${stats.total} | Updated: ${stats.updated} | ` +
    `No phone: ${stats.skipped} | Errors: ${stats.errors}`
  );

  return stats;
}
