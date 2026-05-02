// Canonical skill-level tags — order matters (most specific first).
// Keep in sync with syncEventAttendance.js SKILL_LEVEL_TAGS array.
const SKILL_LEVEL_TAGS = [
  "Beginner",
  "Advanced Beginner",
  "Low Intermediate",
  "Intermediate",
  "Advanced Intermediate",
  "All Levels",
  "All Level",
] as const;

// Levels that carry no specific skill to validate — skip feedback texts for these.
const SKIP_FEEDBACK_LEVELS = new Set<string>(["All Levels", "All Level"]);

/**
 * Return the first skill-level tag found in an event's tags array, or null.
 * Identical logic to syncEventAttendance.js extractSkillLevel.
 */
export function extractSkillLevel(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  for (const level of SKILL_LEVEL_TAGS) {
    if (tags.includes(level)) return level;
  }
  return null;
}

/**
 * Returns true iff the level is a real, specific skill level that warrants
 * a post-session feedback text (non-null, non-"All Levels").
 */
export function isFeedbackLevel(level: string | null | undefined): level is string {
  if (!level) return false;
  if (SKIP_FEEDBACK_LEVELS.has(level)) return false;
  return true;
}
