/*
 * SUPABASE PERMISSION RULE
 * ────────────────────────────────────────────────────────────────────────────
 * Every new table created in Supabase requires explicit grants, otherwise
 * the service_role key will get "permission denied" and the anon key will
 * silently return 0 rows (RLS blocks everything by default).
 *
 * After creating any new table, run in the Supabase SQL editor:
 *
 *   GRANT SELECT ON TABLE <name> TO anon;
 *   GRANT ALL ON TABLE <name> TO service_role;
 *
 * Or run the blanket grant after any migration to cover all tables at once:
 *
 *   GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
 *   GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
 *
 * This was the root cause of the "permission denied for table attendances"
 * bug — the service_role key had no INSERT/UPDATE grant on that table.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
