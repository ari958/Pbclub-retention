import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const sql = `
  CREATE TABLE IF NOT EXISTS message_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    body text NOT NULL,
    use_case_tags text[] NOT NULL DEFAULT '{}',
    is_builtin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO message_templates (name, body, use_case_tags, is_builtin)
  VALUES
    (
      'Win-back offer',
      'Hey {{first_name}}! We miss you at {{club_name}}. It''s been a while since your last visit. Come back and enjoy a free session on us — reply YES to claim.',
      ARRAY['dormant','never-visited'],
      true
    ),
    (
      'Tournament invite',
      'Hi {{first_name}}, you''re invited to our upcoming tournament on {{event_date}}! Based on your {{skill_level}} rating, this is a perfect match. Register here: {{booking_link}}',
      ARRAY['active','lapsing'],
      true
    ),
    (
      'Clinic promotion',
      'Hey {{first_name}}! We''re running a skills clinic designed for {{skill_level}} players on {{event_date}}. Only a few spots left — grab yours: {{booking_link}}',
      ARRAY['ready-to-advance','active'],
      true
    )
  ON CONFLICT DO NOTHING;
`;

const { error } = await supabase.rpc("exec_sql", { sql });

if (error) {
  // Try via pg directly — rpc might not exist
  console.error("rpc exec_sql failed:", error.message);
  console.log("Trying individual inserts...");

  // Check if table exists by trying a select
  const { error: selectErr } = await supabase
    .from("message_templates")
    .select("id")
    .limit(1);

  if (selectErr) {
    console.error("Table does not exist or not accessible:", selectErr.message);
    console.log("Please run the following SQL in your Supabase SQL editor:");
    console.log(`
CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  body text NOT NULL,
  use_case_tags text[] NOT NULL DEFAULT '{}',
  is_builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO message_templates (name, body, use_case_tags, is_builtin)
VALUES
  ('Win-back offer', 'Hey {{first_name}}! We miss you at {{club_name}}. It''s been a while since your last visit. Come back and enjoy a free session on us — reply YES to claim.', ARRAY['dormant','never-visited'], true),
  ('Tournament invite', 'Hi {{first_name}}, you''re invited to our upcoming tournament on {{event_date}}! Based on your {{skill_level}} rating, this is a perfect match. Register here: {{booking_link}}', ARRAY['active','lapsing'], true),
  ('Clinic promotion', 'Hey {{first_name}}! We''re running a skills clinic designed for {{skill_level}} players on {{event_date}}. Only a few spots left — grab yours: {{booking_link}}', ARRAY['ready-to-advance','active'], true)
ON CONFLICT DO NOTHING;
    `);
  } else {
    // Table exists, seed it
    const { data: existing } = await supabase
      .from("message_templates")
      .select("id")
      .eq("is_builtin", true);

    if (!existing || existing.length === 0) {
      const { error: insertErr } = await supabase
        .from("message_templates")
        .insert([
          {
            name: "Win-back offer",
            body: "Hey {{first_name}}! We miss you at {{club_name}}. It's been a while since your last visit. Come back and enjoy a free session on us — reply YES to claim.",
            use_case_tags: ["dormant", "never-visited"],
            is_builtin: true,
          },
          {
            name: "Tournament invite",
            body: "Hi {{first_name}}, you're invited to our upcoming tournament on {{event_date}}! Based on your {{skill_level}} rating, this is a perfect match. Register here: {{booking_link}}",
            use_case_tags: ["active", "lapsing"],
            is_builtin: true,
          },
          {
            name: "Clinic promotion",
            body: "Hey {{first_name}}! We're running a skills clinic designed for {{skill_level}} players on {{event_date}}. Only a few spots left — grab yours: {{booking_link}}",
            use_case_tags: ["ready-to-advance", "active"],
            is_builtin: true,
          },
        ]);
      if (insertErr) console.error("Insert failed:", insertErr.message);
      else console.log("✓ Templates seeded successfully");
    } else {
      console.log(`✓ ${existing.length} built-in templates already exist`);
    }
  }
} else {
  console.log("✓ Migration complete");
}
