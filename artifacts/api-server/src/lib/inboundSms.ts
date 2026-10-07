import { supabase } from "./supabaseClient";
import { getDefaultClubSlug } from "./clubResolver";

export async function captureInboundSms(body: Record<string, unknown>, clubSlug = getDefaultClubSlug()) {
  const { From, To, MessageSid, Body } = body;
  if (typeof From !== "string" || !/^\+[1-9]\d{7,14}$/.test(From)
    || typeof To !== "string" || !/^\+[1-9]\d{7,14}$/.test(To)
    || typeof MessageSid !== "string" || !/^SM[0-9a-f]{32}$/i.test(MessageSid)
    || typeof Body !== "string") throw new Error("Invalid inbound SMS payload");
  const { data, error } = await supabase.rpc("capture_sms_inbound", {
    p_club_slug: clubSlug, p_from: From, p_to: To, p_sid: MessageSid, p_body: Body,
  });
  if (error || !data?.id || !data?.club_id || !["matched","unknown","ambiguous"].includes(data.match_reason)) {
    throw new Error("Inbound persistence unavailable; install migration 021");
  }
  return data as {
    id: string; club_id: string; player_id: string | null; message_id: string | null;
    match_reason: string; kind: "reply" | "stop" | "start"; processed_at: string | null;
    processing_error: string | null;
    duplicate: boolean;
  };
}
