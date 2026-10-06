import app from "./app";
import { logger } from "./lib/logger";
import { startScheduler } from "./lib/scheduler";
import { startQueuePoller } from "./lib/queuePoller";
import { supabase } from "./lib/supabaseClient";
import { getDefaultClubSlug, resolveClubSlug } from "./lib/clubResolver";

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

async function seedTemplatesForClub(clubId: string) {
  const { data: builtinCheck, error: builtinErr } = await supabase
    .from("message_templates")
    .select("id")
    .eq("club_id", clubId)
    .eq("is_builtin", true)
    .limit(1);

  if (builtinErr) {
    logger.warn({ err: builtinErr.message, clubId }, "Could not check built-in templates — skipping");
  } else if (!builtinCheck || builtinCheck.length === 0) {
    const { error: insertErr } = await supabase
      .from("message_templates")
      .insert(BUILTIN_TEMPLATES.map((t) => ({ ...t, club_id: clubId })));
    if (insertErr) {
      logger.error({ err: insertErr.message, clubId }, "Failed to seed built-in templates");
    } else {
      logger.info({ count: BUILTIN_TEMPLATES.length, clubId }, "Built-in templates seeded");
    }
  } else {
    logger.info({ clubId }, "Built-in templates already seeded — skipping");
  }

  const { data: fbCheck, error: fbErr } = await supabase
    .from("message_templates")
    .select("id")
    .eq("club_id", clubId)
    .contains("use_case_tags", ["session_feedback"])
    .limit(1);

  if (fbErr) {
    logger.warn({ err: fbErr.message, clubId }, "Could not check feedback template — skipping");
  } else if (!fbCheck || fbCheck.length === 0) {
    const { error: insertErr } = await supabase.from("message_templates").insert({
      club_id: clubId,
      name: "Post-Session Feedback",
      body: "Hi {{first_name}}! Quick question about today's {{level}} session 🎾\n\n1️⃣ Did you feel like YOU belonged at this level?\n2️⃣ Did the OTHER players belong at this level?\n\nReply with 2 answers — e.g. 'Y Y', 'Y N', 'N Y', or 'N N'",
      use_case_tags: ["session_feedback"],
      is_builtin: false,
    });
    if (insertErr) {
      logger.error({ err: insertErr.message, clubId }, "Failed to seed feedback template");
    } else {
      logger.info({ clubId }, "Post-Session Feedback template seeded");
    }
  } else {
    logger.info({ clubId }, "Feedback template already seeded — skipping");
  }
}

async function seedAllClubTemplates() {
  const { data: clubs, error } = await supabase.from("clubs").select("id");
  if (error) {
    logger.warn({ err: error.message }, "Could not fetch clubs for template seed — skipping");
    return;
  }
  for (const club of clubs ?? []) {
    await seedTemplatesForClub(club.id);
  }
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, sms_live: process.env.SMS_LIVE === "true", process_started_at: new Date().toISOString() }, "Server listening");

  try {
    const defaultSlug = getDefaultClubSlug();
    const defaultClubId = await resolveClubSlug(defaultSlug);
    logger.info({ club_slug: defaultSlug, club_id: defaultClubId }, "Default club resolved at startup");
  } catch (err) {
    logger.error({ err }, "Default club could not be resolved at startup");
    process.exit(1);
  }

  await seedAllClubTemplates();
  startScheduler();
  startQueuePoller();
});
