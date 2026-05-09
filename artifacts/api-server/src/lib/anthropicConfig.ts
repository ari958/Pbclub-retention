/**
 * Single source of truth for the Anthropic model used by the agent route.
 *
 * Override at boot via ANTHROPIC_AGENT_MODEL env var.
 * Defaults to Sonnet 4.6 — the right pick for short structured outreach SMS
 * where deterministic work (warm score, engagement state, link strategy) is
 * already done outside the LLM.
 *
 * Valid values today (per Anthropic docs, May 2026):
 *   "claude-sonnet-4-6"          — default
 *   "claude-opus-4-7"            — ~2.3x effective cost
 *   "claude-haiku-4-5-20251001"  — cheapest; quality risk on tone constraints
 */
export const AGENT_MODEL: string =
  process.env.ANTHROPIC_AGENT_MODEL ?? "claude-sonnet-4-6";
