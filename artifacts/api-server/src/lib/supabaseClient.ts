/*
 * SUPABASE PERMISSION RULE
 * ────────────────────────────────────────────────────────────────────────────
 * Every new table created in Supabase requires explicit grants, otherwise
 * the service_role key will get "permission denied" and the anon key will
 * silently return 0 rows (RLS blocks everything by default).
 *
 * For browser-readable tables only, run in the Supabase SQL editor:
 *
 *   GRANT SELECT ON TABLE <name> TO anon;
 *   GRANT ALL ON TABLE <name> TO service_role;
 *
 * Private inbox and operator tables must NOT be granted to anon. Use the
 * table-specific grants and RLS in their migrations, not blanket anon grants.
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
