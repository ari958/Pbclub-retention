import app from "./app";
import { logger } from "./lib/logger";
import { createClient } from "@supabase/supabase-js";
import { startScheduler } from "./lib/scheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const BUILTIN_TEMPLATES = [
  {
    name: "Win-back offer",
    body: "Hey {{first_name}}! We miss you at {{club_name}}. Come back this week — your first drop-in is on us. Book here: {{booking_link}}",
    use_case_tags: ["never-visited", "dormant"],
    is_builtin: true,
  },
  {
    name: "Tournament invite",
    body: "Hey {{first_name}}! We're hosting a {{skill_level}} doubles tournament on {{event_date}} at {{club_name}}. Sign up here: {{event_link}}",
    use_case_tags: ["active", "lapsing"],
    is_builtin: true,
  },
  {
    name: "Clinic promotion",
    body: "Hi {{first_name}}, you're ready for the next level! We're running a clinic on {{event_date}} — only a few spots left. Reserve yours: {{booking_link}}",
    use_case_tags: ["ready-to-advance"],
    is_builtin: true,
  },
];

async function seedBuiltinTemplates() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    logger.warn("Supabase credentials not set — skipping template seed");
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
    .from("message_templates")
    .select("id")
    .eq("is_builtin", true)
    .limit(1);

  if (error) {
    logger.warn({ err: error.message }, "Could not check message_templates — skipping seed");
    return;
  }

  if (data && data.length > 0) {
    logger.info("Built-in templates already seeded — skipping");
    return;
  }

  const { error: insertErr } = await supabase
    .from("message_templates")
    .insert(BUILTIN_TEMPLATES);

  if (insertErr) {
    logger.error({ err: insertErr.message }, "Failed to seed built-in templates");
  } else {
    logger.info({ count: BUILTIN_TEMPLATES.length }, "Built-in templates seeded");
  }
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  await seedBuiltinTemplates();
  startScheduler();
});
