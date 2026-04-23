import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
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
      .select("*")
      .eq("id", player_id)
      .single(),

    supabase
      .from("attendances")
      .select("*")
      .eq("player_id", player_id)
      .order("attended_at", { ascending: true }),
  ]);

  if (profileResult.error) {
    throw new Error(`Failed to fetch player profile: ${profileResult.error.message}`);
  }

  if (attendanceResult.error) {
    throw new Error(`Failed to fetch attendance history: ${attendanceResult.error.message}`);
  }

  return {
    profile: profileResult.data,
    attendance: attendanceResult.data,
  };
}
