---
name: Test-player safeguards
description: Test-account exclusion and live opt-out reporting boundaries.
---

Test designation is independent of SMS consent. Designated test accounts must not enter regular retention outreach, including the upcoming new-signup flow, even after inbound START clears opt-out flags.

**Why:** The user requires live opt-out testing without enrolling the dummy account in current or future playbooks.

**How to apply:** Preserve designation across imports and START/STOP, enforce exclusion at both eligibility and retention-write boundaries, and retain inbound audit records. Show test opt-outs in the panel as “Test,” but exclude them from scorecards, baselines, and the club-wide total. Do not treat prepared migration/code as installed live protection; verify manual Supabase installation and publishing before a live test.
