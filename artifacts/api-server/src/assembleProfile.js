import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Assembles a player profile with attendance history from Supabase.
 * @param {string} player_id - The ID of the player to look up.
 * @returns {Promise<{profile: object, attendance: object[]}>}
 */
export async function assembleProfile(player_id) {
  const [profileResult, attendanceResult] = await Promise.all([
    supabase
      .from("players")
      .select("club_id, name, skill_level, membership_status, progression_status, notes, coach_assigned_level, sms_opt_in")
      .eq("id", player_id)
      .single(),

    supabase
      .from("attendances")
      .select("attended_at, program_name")
      .eq("player_id", player_id)
      .order("attended_at", { ascending: false }),
  ]);

  if (profileResult.error) {
    const err = new Error(`Failed to fetch player profile: ${profileResult.error.message}`);
    err.supabaseError = profileResult.error;
    throw err;
  }

  if (attendanceResult.error) {
    const err = new Error(`Failed to fetch attendance history: ${attendanceResult.error.message}`);
    err.supabaseError = attendanceResult.error;
    throw err;
  }

  return {
    profile: profileResult.data,
    attendance: attendanceResult.data,
  };
}
