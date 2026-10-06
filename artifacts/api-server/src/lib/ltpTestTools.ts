import { supabase } from "./supabaseClient";

export function requireLtpTestOverride(): void {
  if (!process.env.SMS_TEST_OVERRIDE_TO?.trim()) {
    throw Object.assign(new Error("SMS_TEST_OVERRIDE_TO is required for LTP test tooling"), { status: 403 });
  }
}

export async function ltpTestRpc(operation: string, clubId: string, payload: Record<string, unknown>) {
  requireLtpTestOverride();
  const { data, error } = await supabase.rpc("retention_ltp_test_rpc", {
    p_club_id: clubId, p_operation: operation, p_payload: payload, p_override_enabled: true,
  });
  if (error) {
    const missing = /schema cache|could not find the function|does not exist/i.test(error.message);
    throw Object.assign(new Error(missing
      ? "Apply migration 015_ltp_test_tools.sql in the existing Supabase SQL Editor first"
      : error.message), { status: missing ? 503 : error.code === "42501" ? 403 : 409 });
  }
  return data;
}

export interface LtpTestControl {
  original_sent_at: string;
  effective_sent_at: string;
  simulated_booking: boolean;
}

/** Test controls are invisible when the override is absent, not real eligibility. */
export async function readLtpTestControl(clubId: string, sequenceId: string): Promise<LtpTestControl | null> {
  if (!process.env.SMS_TEST_OVERRIDE_TO?.trim()) return null;
  const { data, error } = await supabase.from("retention_ltp_test_controls")
    .select("original_sent_at,effective_sent_at,simulated_booking")
    .eq("club_id", clubId).eq("sequence_id", sequenceId).maybeSingle();
  if (error) {
    // Old deployments remain operational before this additive migration.
    if (error.code === "PGRST205" || error.code === "42P01") return null;
    throw new Error(`Could not verify LTP test control: ${error.message}`);
  }
  return data;
}
