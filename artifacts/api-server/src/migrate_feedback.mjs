import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── 1. session_feedback: add self_fit + others_fit, drop old fit_rating ─────

// Add the two new columns (IF NOT EXISTS is safe to re-run)
const { error: e1 } = await supabase.rpc("exec_sql", {
  sql: "ALTER TABLE session_feedback ADD COLUMN IF NOT EXISTS self_fit integer;",
});
if (e1) console.warn("self_fit column (may already exist):", e1.message);

const { error: e2 } = await supabase.rpc("exec_sql", {
  sql: "ALTER TABLE session_feedback ADD COLUMN IF NOT EXISTS others_fit integer;",
});
if (e2) console.warn("others_fit column (may already exist):", e2.message);

// Add CHECK constraints
const { error: e3 } = await supabase.rpc("exec_sql", {
  sql: `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'session_feedback_self_fit_check'
    ) THEN
      ALTER TABLE session_feedback ADD CONSTRAINT session_feedback_self_fit_check CHECK (self_fit IN (0, 1));
    END IF;
  END $$;`,
});
if (e3) console.warn("self_fit CHECK:", e3.message);

const { error: e4 } = await supabase.rpc("exec_sql", {
  sql: `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'session_feedback_others_fit_check'
    ) THEN
      ALTER TABLE session_feedback ADD CONSTRAINT session_feedback_others_fit_check CHECK (others_fit IN (0, 1));
    END IF;
  END $$;`,
});
if (e4) console.warn("others_fit CHECK:", e4.message);

// Drop the old fit_rating column
const { error: e5 } = await supabase.rpc("exec_sql", {
  sql: "ALTER TABLE session_feedback DROP COLUMN IF EXISTS fit_rating;",
});
if (e5) console.warn("drop fit_rating:", e5.message);

// Add UNIQUE constraint (player_id, event_id)
const { error: e6 } = await supabase.rpc("exec_sql", {
  sql: `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'session_feedback_player_id_event_id_key'
    ) THEN
      ALTER TABLE session_feedback ADD CONSTRAINT session_feedback_player_id_event_id_key UNIQUE (player_id, event_id);
    END IF;
  END $$;`,
});
if (e6) console.warn("UNIQUE(player_id,event_id):", e6.message);

// Grants
const { error: e7 } = await supabase.rpc("exec_sql", {
  sql: "GRANT SELECT, INSERT, UPDATE ON session_feedback TO service_role; GRANT SELECT ON session_feedback TO anon;",
});
if (e7) console.warn("session_feedback grants:", e7.message);

console.log("✓ session_feedback migration done");

// ─── 2. pending_sends: create if not exists ───────────────────────────────────

const { error: e8 } = await supabase.rpc("exec_sql", {
  sql: `CREATE TABLE IF NOT EXISTS pending_sends (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id uuid REFERENCES players(id) ON DELETE CASCADE,
    type text NOT NULL,
    metadata JSONB,
    conversation_id uuid,
    sent_at timestamptz DEFAULT now(),
    created_at timestamptz DEFAULT now()
  );`,
});
if (e8) console.warn("CREATE pending_sends:", e8.message);

const { error: e9 } = await supabase.rpc("exec_sql", {
  sql: "ALTER TABLE pending_sends ENABLE ROW LEVEL SECURITY;",
});
if (e9) console.warn("pending_sends RLS:", e9.message);

const { error: e10 } = await supabase.rpc("exec_sql", {
  sql: "GRANT SELECT, INSERT, UPDATE ON pending_sends TO service_role; GRANT SELECT ON pending_sends TO anon;",
});
if (e10) console.warn("pending_sends grants:", e10.message);

console.log("✓ pending_sends migration done");

// ─── Verify ────────────────────────────────────────────────────────────────────

const { data: sfCols } = await supabase
  .from("session_feedback")
  .select("id, player_id, event_id, level, self_fit, others_fit, responded_at")
  .limit(0);
console.log("session_feedback columns accessible:", sfCols !== undefined ? "YES" : "check above errors");

const { data: psCols, error: psErr } = await supabase
  .from("pending_sends")
  .select("id, player_id, type, metadata, conversation_id, sent_at")
  .limit(0);
if (psErr) {
  console.error("pending_sends NOT accessible:", psErr.message);
} else {
  console.log("pending_sends columns accessible: YES");
}
