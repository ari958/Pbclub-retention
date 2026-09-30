import { validateRetentionTextBody } from "../retentionText.js";
import type { RetentionContext, RetentionPlaybook } from "../retentionTypes.js";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function rejects(fn: () => unknown, message: string) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  assert(rejected, message);
}

const playbook: RetentionPlaybook = {
  key: "ltp_followup", name: "Learn to Play follow-up", enabled: true,
  promo_code: "LTPNEXT25", offer_text: "25% off your next program",
  next_program_names: [], message_guidance: null, holdout_pct: 0,
};
const context: RetentionContext = {
  trigger: { event_id: "evt-1", name: "Learn to Play Clinic", date: "2026-09-28" },
  player_first_name: "Sam",
  next_program: {
    event_id: "evt-2", name: "Beginner Clinic", start_time: "2026-10-02T16:00:00Z",
    date: "2026-10-02", time: "12:00 PM",
    signup_url: "https://pb.podplay.app/community/events/evt-2", spots_remaining: 3,
  },
  classmates_signed_up: 2, already_booked: false, booked_event: null,
  promo: null, coupon_warning: "Coupon LTPNEXT25 was not found", evaluated_at: "2026-09-29T10:00:00Z",
};

assert(validateRetentionTextBody("Sam, Beginner Clinic has room Friday.", context, playbook) === "Sam, Beginner Clinic has room Friday.", "accepts a factual non-promotional draft");
rejects(() => validateRetentionTextBody("Sam, get 25% off with LTPNEXT25.", context, playbook), "rejects promotion text when no promo is valid");
rejects(() => validateRetentionTextBody("Sign up at https://evil.example/now", context, playbook), "rejects a link not present in context");
assert(validateRetentionTextBody("Sam, register here https://pb.podplay.app/community/events/evt-2", context, playbook).includes("evt-2"), "allows the context's exact signup link");

console.log("Retention text validation tests passed");