import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { supabase } from "../supabaseClient";
import { resolveClubId, ClubResolutionError } from "../clubResolver";

test("club resolution defaults by slug without choosing the first club", async (t) => {
  const prior = process.env.DEFAULT_CLUB_SLUG;
  process.env.DEFAULT_CLUB_SLUG = "pb-club";
  const rows = [
    { id: "22222222-2222-4222-8222-222222222222", slug: "test-club" },
    { id: "11111111-1111-4111-8111-111111111111", slug: "pb-club" },
  ];
  const queries: { column: string; value: string }[] = [];
  const from = t.mock.method(supabase, "from", () => ({
    select: () => ({
      eq: (column: string, value: string) => {
        queries.push({ column, value });
        return { maybeSingle: async () => ({
          data: rows.find((row) => row[column as "id" | "slug"] === value) ?? null,
          error: null,
        }) };
      },
    }),
  }));
  const request = (query: Record<string, string> = {}) => ({ query, params: {} }) as Request;
  try {
    assert.equal(await resolveClubId(request()), rows[1].id);
    assert.deepEqual(queries[0], { column: "slug", value: "pb-club" });
    assert.equal(await resolveClubId(request({ slug: "test-club" })), rows[0].id);
    assert.equal(await resolveClubId(request({ clubId: rows[0].id })), rows[0].id);
    await assert.rejects(resolveClubId(request({ slug: "does-not-exist" })),
      (error: unknown) => error instanceof ClubResolutionError && error.status === 404);
    await assert.rejects(resolveClubId(request({ slug: "../invalid" })),
      (error: unknown) => error instanceof ClubResolutionError && error.status === 400);
    process.env.DEFAULT_CLUB_SLUG = "test-club";
    assert.equal(await resolveClubId(request()), rows[0].id);
  } finally {
    from.mock.restore();
    if (prior === undefined) delete process.env.DEFAULT_CLUB_SLUG;
    else process.env.DEFAULT_CLUB_SLUG = prior;
  }
});