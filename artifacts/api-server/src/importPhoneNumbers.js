import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DELAY_MS = 200;
const BATCH_SIZE = 500;

class CancelledError extends Error {
  constructor() {
    super("Phone import cancelled by operator");
    this.name = "CancelledError";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 7) return raw.startsWith("+") ? raw : `+${digits}`;
  return null;
}

/**
 * Fetches phone number from PodPlay for a single user.
 */
async function fetchPhoneNumber(podplayBase, apiKey, externalId) {
  const url = `${podplayBase}/apis/v2/users/${externalId}/phone-number`;
  const headers = { "x-api-key": apiKey };

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
 * @param {string} clubId
 * @param {(msg: string) => void} log
 * @param {() => boolean} isCancelled
 */
export async function importPhoneNumbers(clubId, log = console.log, isCancelled = () => false) {
  if (!clubId) throw new Error("importPhoneNumbers requires clubId");

  const stats = {
    total: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  // Fetch club details
  const { data: club } = await supabase
    .from("clubs")
    .select("platform_api_key, platform_subdomain")
    .eq("id", clubId)
    .maybeSingle();

  if (!club?.platform_subdomain) {
    throw new Error(`Club ${clubId} has no platform_subdomain`);
  }

  const podplayBase = `https://${club.platform_subdomain}.podplay.app`;
  const apiKey = club.platform_api_key ?? process.env.PODPLAY_API_KEY;

  // Load all eligible players in pages
  log("[phone-import] Querying players without phone numbers…");

  const players = [];
  let from = 0;
  const pageSize = BATCH_SIZE;

  while (true) {
    const { data, error } = await supabase
      .from("players")
      .select("id, name, external_id")
      .eq("club_id", clubId)
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

  for (let i = 0; i < players.length; i++) {
    if (await isCancelled()) throw new CancelledError();

    const player = players[i];
    const progress = `[${i + 1}/${players.length}]`;

    await sleep(DELAY_MS);

    let apiData;
    try {
      apiData = await fetchPhoneNumber(podplayBase, apiKey, player.external_id);
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
