/**
 * signupStatus — canonical signup status constants for fill-rate counting.
 *
 * PodPlay signup lifecycle
 * ────────────────────────
 *   Single-session events (Open Play, Learn to Play, Workshop, Drill & Play):
 *     PENDING (before event) → CONFIRMED (after event settles)
 *
 *   Series-pass clinics (Path to Intermediate multi-session packages):
 *     PENDING (before event) → INVALID (after event settles)
 *
 *   Withdrawn bookings: → CANCELED (at any point)
 *   Incomplete / unpublished entries: DRAFT
 *
 * Why INVALID is treated as active
 * ─────────────────────────────────
 *   Series-pass clinic enrollments land in INVALID status on PodPlay after the
 *   session runs, instead of CONFIRMED. Excluding INVALID zeroed out every
 *   Path-to-Intermediate event (all 22 sampled events had 1–3 local attendance
 *   rows but a filter-computed active count of 0). The decisive test is in
 *   Phase 2.2: local attendance rows confirm real participation.
 *
 *   ⚠  DO NOT add INVALID back to INACTIVE_SIGNUP_STATUSES.
 *      Doing so restores the Phase 2.1 error and drops all series clinics.
 *
 * This constant is the single source of truth for fill-rate counting.
 * Import it into every call site; do not repeat the set literal.
 *
 * Note: syncEventAttendance.js uses a separate VALID_SIGNUP_STATUSES
 * set {CONFIRMED, CHECKED_IN} for the attendance-sync pipeline (deciding
 * which signups to write as attendance rows). That set should also include
 * INVALID so series clinic participants are captured in local attendance,
 * but that change is out of scope for Phase 2.3 (separate fix needed).
 */

export const INACTIVE_SIGNUP_STATUSES = new Set(["CANCELED", "DRAFT"]);

/** Returns true if a signup status represents a real, countable participant. */
export const isActiveSignup = (status: string): boolean =>
  !INACTIVE_SIGNUP_STATUSES.has(status);

/**
 * Statuses that produce an attendance row in the local `attendances` table.
 *
 * Note on INVALID: PodPlay settles series-pass clinic enrollments (e.g. Path
 * to Intermediate) as INVALID after the session runs, not CONFIRMED.  These
 * are real participants — see signupStatus.ts Phase 2.2 rationale.
 *
 * ⚠  This set is deliberately different from INACTIVE_SIGNUP_STATUSES:
 *     INACTIVE_SIGNUP_STATUSES = statuses to *exclude* from fill counting
 *     ATTENDANCE_SIGNUP_STATUSES = statuses to *include* when creating
 *       attendance rows in the local database
 *
 * If you need to add or remove a status, update both sets with full
 * reasoning — they are not complements of each other.
 */
export const ATTENDANCE_SIGNUP_STATUSES = new Set([
  "CONFIRMED",   // standard single-session post-event status
  "CHECKED_IN",  // member scanned in at door
  "INVALID",     // series-pass clinic enrollment (Path to Intermediate, etc.)
]);
