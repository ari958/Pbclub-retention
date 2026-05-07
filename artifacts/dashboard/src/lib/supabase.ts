import { createClient } from "@supabase/supabase-js";

// IMPORTANT: this client is for SELECT only. Never use it for INSERT,
// UPDATE, or DELETE. All writes must go through the API server at /api/*.
// RLS policies will silently reject writes via this client (HTTP 200, 0 rows affected).

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables"
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
