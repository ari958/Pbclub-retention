const PODPLAY_BASE = "https://pbclub.podplay.app/apis/v2";

/**
 * Format a raw PodPlay event into the available_programs shape the agent expects.
 * @param {object} event
 * @returns {object}
 */
function formatProgram(event) {
  const rate = event.admissionRate;
  const price =
    rate && typeof rate === "object"
      ? (rate.regular ?? rate.member ?? null)
      : null;

  // spots_remaining: guests.max (capacity) minus current signups, if max is defined
  const capacity = event.guests?.max ?? null;
  const currentSignups = event.signups?._total ?? 0;
  const spots_remaining =
    capacity != null && capacity > 0 ? Math.max(0, capacity - currentSignups) : null;

  return {
    name: event.name,
    description: event.description?.trim() || null,
    program_type: event.customType ?? event.type ?? null,
    price,
    spots_remaining,
  };
}

/**
 * Fetch upcoming events from PodPlay and return them formatted
 * as the available_programs array the agent expects.
 *
 * Filters to events that:
 * - Start in the future (startTime > now)
 * - Are not cancelled
 * - Have a PUBLISHED status
 *
 * @returns {Promise<Array<{name: string, description: string|null, program_type: string|null, price: number|null, spots_remaining: number|null}>>}
 */
export async function fetchAvailablePrograms() {
  const res = await fetch(`${PODPLAY_BASE}/events`, {
    headers: { "x-api-key": process.env.PODPLAY_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`PodPlay /events returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const events = data.items ?? [];

  const now = new Date();

  const upcoming = events.filter(
    (e) =>
      !e.isCanceled &&
      e.status === "PUBLISHED" &&
      new Date(e.startTime) > now
  );

  return upcoming.map(formatProgram);
}
