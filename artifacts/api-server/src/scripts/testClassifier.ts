/**
 * Classifier unit test — run with:
 *   npx tsx src/scripts/testClassifier.ts
 *
 * Every IN fixture must resolve to exactly one named archetype.
 * Every OUT fixture must return isExcluded = true.
 * Any name matching zero or ≥2 archetypes is a STOP condition (exit 1).
 */

import { classifyEvent, type Archetype, type EventInput } from "../lib/classifyEvent";

// ── Fixture archetypes (mirrors SQL seed; no DB needed for unit tests) ────────

const ARCHETYPES: Archetype[] = [
  // Priority 5 — 60&60 overrides type
  {
    id: "a01",
    canonical_name: "60&60 Drill & Play",
    canonical_type: "clinic",
    match_priority: 5,
    overrides_podplay_type: true,
    match_rules: { keywords: ["60 & 60", "60&60", "drill session + guided", "drill session + open"], require_podplay_types: [] },
  },
  // Priority 10 — highly specific
  {
    id: "a02",
    canonical_name: "DUPR Assessment",
    canonical_type: "clinic",
    match_priority: 10,
    overrides_podplay_type: false,
    match_rules: { keywords: ["dupr assessment", "need a dupr"], require_podplay_types: ["Clinics"] },
  },
  {
    id: "a03",
    canonical_name: "Play With the Pro",
    canonical_type: "clinic",
    match_priority: 10,
    overrides_podplay_type: false,
    match_rules: { keywords: ["play with the pro", "play with pro:"], require_podplay_types: ["Clinics"] },
  },
  {
    id: "a04",
    canonical_name: "Queer Pickleball",
    canonical_type: "open_play",
    match_priority: 10,
    overrides_podplay_type: false,
    match_rules: { keywords: ["queer"], require_podplay_types: ["Open Play"] },
  },
  {
    id: "a05",
    canonical_name: "Ladies Open Play",
    canonical_type: "open_play",
    match_priority: 10,
    overrides_podplay_type: false,
    match_rules: { keywords: ["ladies", "galentine"], require_podplay_types: ["Open Play"] },
  },
  {
    id: "a06",
    canonical_name: "DUPR-Tracked Open Play",
    canonical_type: "open_play",
    match_priority: 10,
    overrides_podplay_type: false,
    match_rules: { keywords: ["dupr tracked", "dupr track"], require_podplay_types: ["Open Play"] },
  },
  // Priority 15 — Challenge Court before Coach-Guided
  {
    id: "a07",
    canonical_name: "Challenge Court Open Play",
    canonical_type: "open_play",
    match_priority: 15,
    overrides_podplay_type: false,
    match_rules: {
      keywords: ["challenge court", "king of the court", "queen of the court", "ladder play", "ladder week", "with prizes", "winners stay"],
      require_podplay_types: ["Open Play"],
    },
  },
  // Priority 20 — specific formats
  {
    id: "a08",
    canonical_name: "Coach-Guided Open Play",
    canonical_type: "open_play",
    match_priority: 20,
    overrides_podplay_type: false,
    match_rules: { keywords: ["instructional", "coach guided", "coach-guided", "play with coach"], require_podplay_types: ["Open Play"] },
  },
  {
    id: "a09",
    canonical_name: "Drill & Stay",
    canonical_type: "open_play",
    match_priority: 20,
    overrides_podplay_type: false,
    match_rules: { keywords: ["drill and stay", "drilling / open play"], require_podplay_types: ["Open Play"] },
  },
  {
    id: "a10",
    canonical_name: "Skills & Drills",
    canonical_type: "open_play",
    match_priority: 20,
    overrides_podplay_type: false,
    match_rules: { keywords: ["skills and drills", "skills & drills", "lunch time drilling", "advanced drilling"], require_podplay_types: ["Open Play", "Clinics"] },
  },
  {
    id: "a11",
    canonical_name: "Learn to Play",
    canonical_type: "clinic",
    match_priority: 20,
    overrides_podplay_type: false,
    match_rules: { keywords: ["learn to play", "path to advanced beginner"], require_podplay_types: ["Clinics"] },
  },
  {
    id: "a12",
    canonical_name: "30&30 Drill & Play",
    canonical_type: "clinic",
    match_priority: 20,
    overrides_podplay_type: false,
    match_rules: { keywords: ["30 & 30", "30&30"], require_podplay_types: ["Clinics"] },
  },
  {
    id: "a13",
    canonical_name: "Path to Intermediate",
    canonical_type: "clinic",
    match_priority: 20,
    overrides_podplay_type: false,
    match_rules: { keywords: ["path to intermediate", "path to 4.0"], require_podplay_types: ["Clinics"] },
  },
  {
    id: "a14",
    canonical_name: "Workshop",
    canonical_type: "clinic",
    match_priority: 20,
    overrides_podplay_type: false,
    match_rules: { keywords: ["workshop", "pickleball iq", "serving clinic", "reset clinic", "fitness hiit", "fitness"], require_podplay_types: ["Clinics"] },
  },
  // Priority 100 — catch-all
  {
    id: "a15",
    canonical_name: "Social Open Play",
    canonical_type: "open_play",
    match_priority: 100,
    overrides_podplay_type: false,
    match_rules: { keywords: [], require_podplay_types: ["Open Play"] },
  },
];

// Sorted by priority (mirrors what loadArchetypes returns)
const ARCHETYPES_SORTED = [...ARCHETYPES].sort((a, b) => a.match_priority - b.match_priority);

// ── Fixture ───────────────────────────────────────────────────────────────────

interface Case {
  name: string;
  type: string;
  expected: string | null;  // null = excluded
  tags?: string[];
}

const FIXTURE: Case[] = [
  // ── 60&60 — overrides podplay type ────────────────────────────────────────
  { name: "Advanced Intermediate Coach Led 60 & 60 - Drill Session + Guided Play", type: "Open Play", expected: "60&60 Drill & Play" },
  { name: "Advanced Intermediate Coach Led 60 & 60 - Drill Session + Guided Play", type: "Clinics",   expected: "60&60 Drill & Play" },
  { name: "Intermediate Coach Led 60 & 60 - Drill Session + Guided Play",          type: "Open Play", expected: "60&60 Drill & Play" },
  { name: "Beginner Coach Led 60 & 60 - Drill Session + Guided Play",              type: "Open Play", expected: "60&60 Drill & Play" },
  { name: "Intermediate 60&60 Clinic",                                             type: "Clinics",   expected: "60&60 Drill & Play" },
  { name: "Advanced Intermediate 60&60 Clinic",                                    type: "Clinics",   expected: "60&60 Drill & Play" },
  { name: "Coach Led 60 & 60 - Drill Session + Open Play",                         type: "Open Play", expected: "60&60 Drill & Play" },
  { name: "60 & 60 - Drill Session + Open Play",                                   type: "Open Play", expected: "60&60 Drill & Play" },
  { name: "Beginner 60&60: Coach Led Drilling and Guided Play",                    type: "Clinics",   expected: "60&60 Drill & Play" },
  { name: "Rob Approved - Low Intermediate Coach Led 60 & 60",                     type: "Clinics",   expected: "60&60 Drill & Play" },
  { name: "Intermediate+ 60 & 60 - Drill Session + Open Play",                    type: "Open Play", expected: "60&60 Drill & Play" },
  { name: "Low Intermediate Coach Led 60 & 60 - Drill Session + Guided Play",      type: "Open Play", expected: "60&60 Drill & Play" },

  // ── DUPR Assessment (priority 10, wins over Workshop) ─────────────────────
  { name: "DUPR Assessment Workshop",     type: "Clinics", expected: "DUPR Assessment" },
  { name: "Need a DUPR? Book Here",       type: "Clinics", expected: "DUPR Assessment" },

  // ── Play With the Pro ─────────────────────────────────────────────────────
  { name: "Play With the Pro: Brandon Hunter",          type: "Clinics", expected: "Play With the Pro" },
  { name: "Play With the Pro: Joe Zee",                 type: "Clinics", expected: "Play With the Pro" },
  { name: "Intermediate Play With the Pro: Rob Gruber", type: "Clinics", expected: "Play With the Pro" },
  { name: "Play with Pro: Rob Gruber",                  type: "Clinics", expected: "Play With the Pro" },

  // ── Queer Pickleball ──────────────────────────────────────────────────────
  { name: "Queer Pickleball Open Play", type: "Open Play", expected: "Queer Pickleball" },
  { name: "Queer Pickleball Night",     type: "Open Play", expected: "Queer Pickleball" },

  // ── Ladies Open Play (wins over Challenge Court even if both match) ────────
  { name: "Ladies Open Play",                                          type: "Open Play", expected: "Ladies Open Play" },
  { name: "Rob Guided Ladies Night with Challenge Court",               type: "Open Play", expected: "Ladies Open Play" },
  { name: "Coach Guided Ladies Night w/ Challenge & Beginner Courts",   type: "Open Play", expected: "Ladies Open Play" },
  { name: "Ladies Galentine's Day Open Play",                           type: "Open Play", expected: "Ladies Open Play" },

  // ── DUPR-Tracked Open Play ────────────────────────────────────────────────
  { name: "DUPR Tracked 3.25-3.75 Advanced Intermediate Open Play", type: "Open Play", expected: "DUPR-Tracked Open Play" },
  { name: "DUPR Tracked 2.75-3.25 Intermediate Open Play",          type: "Open Play", expected: "DUPR-Tracked Open Play" },
  { name: "DUPR TRACKED 3.0-3.5 Open Play",                         type: "Open Play", expected: "DUPR-Tracked Open Play" },
  { name: "DUPR Tracked 3.5-3.99 Open Play",                        type: "Open Play", expected: "DUPR-Tracked Open Play" },

  // ── Challenge Court Open Play ─────────────────────────────────────────────
  { name: "Challenge Court Social Open Play",                                          type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "All You Can Play - All Levels with Challenge Court",                         type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "Rob Approved Advanced Intermediate Open Play (King of the Court)",           type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "Rob Approved Coach Led Advanced Intermediate Open Play (King of the Court)", type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "Queen of the Court",                                                        type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "Coach Led All You Can Play - All Levels with Challenge Court",               type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "4.0+ Advanced Ladder Play - Week 3",                                        type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "Intermediate 3.0 - 3.5 Open Play with Prizes Week 2",                       type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "Challenge Court Style Open Play - Winners Stay",                             type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "4 Hour Open Play w/ Challenge Court",                                        type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "Saturday Night Challenge Court Social Open Play",                            type: "Open Play", expected: "Challenge Court Open Play" },
  { name: "Intermediate 3.0 - 3.5 Ladder Week 4",                                      type: "Open Play", expected: "Challenge Court Open Play" },

  // ── Coach-Guided Open Play ────────────────────────────────────────────────
  { name: "Coach Guided Intermediate Open Play",              type: "Open Play", expected: "Coach-Guided Open Play" },
  { name: "Instructional Advanced Beginner Open Play",         type: "Open Play", expected: "Coach-Guided Open Play" },
  { name: "Coach Guided Beg - ADV Beginner+ Open Play",       type: "Open Play", expected: "Coach-Guided Open Play" },
  { name: "Instructional Advanced Beginner+ Open Play",        type: "Open Play", expected: "Coach-Guided Open Play" },
  { name: "Play with Coach Rob - Half Price Early Open Play",  type: "Open Play", expected: "Coach-Guided Open Play" },

  // ── Drill & Stay ──────────────────────────────────────────────────────────
  { name: "Sunrise Drill and Stay",                           type: "Open Play", expected: "Drill & Stay" },
  { name: "Late Morning Drill and Stay",                      type: "Open Play", expected: "Drill & Stay" },
  { name: "Late Night Drill and Stay",                        type: "Open Play", expected: "Drill & Stay" },
  { name: "Morning Drill and Stay",                           type: "Open Play", expected: "Drill & Stay" },
  { name: "Late Night Drill and Stay - Partner required",     type: "Open Play", expected: "Drill & Stay" },
  { name: "Advanced Beginner Drilling / Open Play (2.75-3.00)", type: "Open Play", expected: "Drill & Stay" },

  // ── Skills & Drills ───────────────────────────────────────────────────────
  { name: "Skills and Drills",           type: "Open Play", expected: "Skills & Drills" },
  { name: "Coach Led Skills and Drills", type: "Open Play", expected: "Skills & Drills" },
  { name: "Coach Led Skills and Drills", type: "Clinics",   expected: "Skills & Drills" },
  { name: "Intermediate Skills and Drills", type: "Open Play", expected: "Skills & Drills" },
  { name: "Lunch Time Drilling",         type: "Open Play", expected: "Skills & Drills" },
  { name: "Advanced Drilling - 3 and Rob", type: "Clinics", expected: "Skills & Drills" },

  // ── Learn to Play ─────────────────────────────────────────────────────────
  { name: "Learn to Play Clinic",        type: "Clinics", expected: "Learn to Play" },
  { name: "Path to Advanced Beginner",   type: "Clinics", expected: "Learn to Play" },

  // ── 30&30 Drill & Play ────────────────────────────────────────────────────
  { name: "30 & 30 Beginner Drills & Guided Play",     type: "Clinics", expected: "30&30 Drill & Play" },
  { name: "30&30 Advanced Beginner Drills & Play",     type: "Clinics", expected: "30&30 Drill & Play" },

  // ── Path to Intermediate ──────────────────────────────────────────────────
  { name: "Path to Intermediate Level 1",     type: "Clinics", expected: "Path to Intermediate" },
  { name: "Path to Intermediate Level 2",     type: "Clinics", expected: "Path to Intermediate" },
  { name: "Path to Intermediate",             type: "Clinics", expected: "Path to Intermediate" },
  { name: "Clinic Series - Path to Intermediate Level 1", type: "Clinics", expected: "Path to Intermediate" },
  { name: "Path to Intermediate LEVEL 2",    type: "Clinics", expected: "Path to Intermediate" },
  { name: "Path to 4.0",                      type: "Clinics", expected: "Path to Intermediate" },
  { name: "Path to 4.0 Level 1",              type: "Clinics", expected: "Path to Intermediate" },

  // ── Workshop ──────────────────────────────────────────────────────────────
  { name: "Pickleball Fitness HIIT",                         type: "Clinics", expected: "Workshop" },
  { name: "Fast Hands and Counters Workshop",                type: "Clinics", expected: "Workshop" },
  { name: "Dinking Dominance Workshop",                      type: "Clinics", expected: "Workshop" },
  { name: "Dinking Dominance Workshop - Intermediate",       type: "Clinics", expected: "Workshop" },
  { name: "The Serving Clinic",                              type: "Clinics", expected: "Workshop" },
  { name: "The Reset Clinic",                                type: "Clinics", expected: "Workshop" },
  { name: "Intermediate+ Pickleball IQ - Intermediate",      type: "Clinics", expected: "Workshop" },
  { name: "Fast Hands and Counters Workshop - Intermediate", type: "Clinics", expected: "Workshop" },
  { name: "Intermediate+ Fast Hands and Counters Workshop",  type: "Clinics", expected: "Workshop" },

  // ── Social Open Play (catch-all) ──────────────────────────────────────────
  { name: "Thursday Night Social Open Play",                  type: "Open Play", expected: "Social Open Play" },
  { name: "Half Price Afternoon Open Play",                   type: "Open Play", expected: "Social Open Play" },
  { name: "Half Price Morning Open Play",                     type: "Open Play", expected: "Social Open Play" },
  { name: "Advanced Open Play (4.0-4.49)",                    type: "Open Play", expected: "Social Open Play" },
  { name: "4.0+ Advanced Open Play",                          type: "Open Play", expected: "Social Open Play" },
  { name: "Intermediate Open Play (3.0-3.49)",                type: "Open Play", expected: "Social Open Play" },
  { name: "Afternoon 3 Hour Social Open Play",                type: "Open Play", expected: "Social Open Play" },
  { name: "Half Price Christmas Open Play",                   type: "Open Play", expected: "Social Open Play" },
  { name: "Marathon Social Open Play",                        type: "Open Play", expected: "Social Open Play" },
  { name: "Rob Approved Low Intermediate Open Play",          type: "Open Play", expected: "Social Open Play" },
  { name: "$20 Morning Open Play and Stay",                   type: "Open Play", expected: "Social Open Play" },
  { name: "Senior Midday Open Play",                          type: "Open Play", expected: "Social Open Play" },
  { name: "President's Day Social Open Play",                 type: "Open Play", expected: "Social Open Play" },
  { name: "Pizza and Pickleball Social Open Play",            type: "Open Play", expected: "Social Open Play" },

  // ── OUT: Private Event ────────────────────────────────────────────────────
  { name: "AJ's Wild Wednesday",               type: "Private Event", expected: null },
  { name: "Rachel's Surprise 31st",            type: "Private Event", expected: null },
  { name: "San's Private Monday Game",         type: "Private Event", expected: null },
  { name: "Private Event",                     type: "Private Event", expected: null },
  { name: "Founding Members Private Event",    type: "Private Event", expected: null },
  { name: "Court Contract - San",              type: "Private Event", expected: null },
  { name: "Vinny Pickleball's PB Club Takeover", type: "Private Event", expected: null },

  // ── OUT: other excluded types ─────────────────────────────────────────────
  { name: "Kids Pickleball Mini Camp: 7-13 years old", type: "Kids Class",  expected: null },
  { name: "Free Co-Working Space",                     type: "Co-Working",  expected: null },
  { name: "Co-Working Space",                          type: "Co-Working",  expected: null },
  { name: "Moneyball Tournament",                      type: "Tournaments", expected: null },
  { name: "Intermediate Ladder League - 6 Week",       type: "Leagues",     expected: null },

  // ── OUT: one-time specials (typed Open Play but excluded by name) ─────────
  { name: "Grand Opening Open Play/Open House",  type: "Open Play", expected: null },
  { name: "New Years Eve Party Event",           type: "Open Play", expected: null },
  { name: "Mystery Partner Scramble",            type: "Party",     expected: null },
  { name: "Test Session",                        type: "",          expected: null },
  { name: "DUPR open play test",                 type: "Open Play", expected: null },
];

// ── Runner ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const c of FIXTURE) {
  const ev: EventInput = { name: c.name, podplayType: c.type, tags: c.tags ?? [] };
  const result = classifyEvent(ev, ARCHETYPES_SORTED);

  const got = result.isExcluded ? null : result.archetypeName;
  const ok = got === c.expected;

  if (ok) {
    passed++;
    // Verbose pass
    const tag = c.expected === null ? "OUT" : `→ ${c.expected}`;
    process.stdout.write(`  ✓ [${tag}] "${c.name}" [${c.type}]\n`);
  } else {
    failed++;
    const msg = `  ✗ "${c.name}" [${c.type}]\n    expected: ${c.expected ?? "null"}\n    got:      ${got ?? "null"}  (${result.reason})\n`;
    failures.push(msg);
    process.stdout.write(msg);
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log(`Total: ${FIXTURE.length}  Passed: ${passed}  Failed: ${failed}`);

if (failed > 0) {
  console.error(`\n⛔  STOP — ${failed} classifier test(s) failed. Fix mapping before wiring nightly.`);
  process.exit(1);
} else {
  console.log(`\n✅  All ${passed} classifier tests passed.`);
}
