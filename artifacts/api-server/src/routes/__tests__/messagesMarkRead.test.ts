import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { supabase } from "../../lib/supabaseClient.js";
import messagesRouter from "../messages.js";

const originalFrom = (supabase as any).from;
const originalRpc = (supabase as any).rpc;
const CLUB_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_CLUB_ID = "00000000-0000-4000-8000-000000000004";

type Row = { id: string; club_id: string; direction: string; read_at: string | null };
let rows: Row[] = [];
let updateFilters: { ids: string[]; direction?: string; readAtNull?: boolean }[] = [];
let failUpdate = false;

function queryFor(table: string) {
  if (table === "clubs") {
    const clubs: any = { select: () => clubs, eq: () => clubs,
      maybeSingle: () => Promise.resolve({ data: { id: CLUB_ID }, error: null }) };
    return clubs;
  }
  assert.equal(table, "messages");
  let operation = "select";
  let values: any;
  let head = false;
  const eqs: Record<string, unknown> = {};
  const nulls = new Set<string>();
  let ids: string[] | null = null;
  let limit = Infinity;
  const matching = () => rows.filter((row) =>
    (eqs["players.club_id"] === undefined || row.club_id === eqs["players.club_id"])
    && (eqs.direction === undefined || row.direction === eqs.direction)
    && (!nulls.has("read_at") || row.read_at === null)
    && (!ids || ids.includes(row.id)));
  const resolve = () => {
    if (operation === "update") {
      updateFilters.push({ ids: ids ?? [], direction: eqs.direction as string, readAtNull: nulls.has("read_at") });
      if (failUpdate) return { data: null, error: { message: "update failed" } };
      const hit = matching();
      for (const row of hit) row.read_at = values.read_at;
      return { data: hit.map(({ id }) => ({ id })), error: null };
    }
    const hit = matching();
    if (head) return { data: null, count: hit.length, error: null };
    return { data: hit.slice(0, limit).map(({ id }) => ({ id })), error: null };
  };
  const query: any = {
    select(_cols: string, options?: { head?: boolean }) { head = !!options?.head; return query; },
    update(next: any) { operation = "update"; values = next; return query; },
    eq(column: string, value: unknown) { eqs[column] = value; return query; },
    is(column: string, value: unknown) { if (value === null) nulls.add(column); return query; },
    in(_column: string, list: string[]) { ids = list; return query; },
    limit(n: number) { limit = n; return query; },
    then(onFulfilled: any, onRejected: any) { return Promise.resolve(resolve()).then(onFulfilled, onRejected); },
  };
  return query;
}

function appFor() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use("/api", messagesRouter);
  return app;
}

async function post(path: string) {
  const server = appFor().listen(0);
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
    return { status: res.status, body: await res.json() as any };
  } finally {
    server.close();
  }
}

before(() => {
  (supabase as any).from = queryFor;
  (supabase as any).rpc = () => { throw new Error("unexpected rpc"); };
});
after(() => {
  (supabase as any).from = originalFrom;
  (supabase as any).rpc = originalRpc;
});
beforeEach(() => {
  updateFilters = [];
  failUpdate = false;
  rows = [];
});

test("mark-read marks only this club's unread inbound messages", async () => {
  rows = [
    { id: "a", club_id: CLUB_ID, direction: "inbound", read_at: null },
    { id: "b", club_id: CLUB_ID, direction: "inbound", read_at: null },
    { id: "c", club_id: CLUB_ID, direction: "outbound", read_at: null },
    { id: "d", club_id: OTHER_CLUB_ID, direction: "inbound", read_at: null },
    { id: "e", club_id: CLUB_ID, direction: "inbound", read_at: "2026-10-01T00:00:00Z" },
  ];
  const { status, body } = await post(`/api/messages/mark-read?clubId=${CLUB_ID}`);
  assert.equal(status, 200);
  assert.deepEqual(body, { marked: 2, unread: 0 });
  assert.deepEqual(updateFilters, [{ ids: ["a", "b"], direction: "inbound", readAtNull: true }]);
  assert.equal(rows.find((r) => r.id === "c")!.read_at, null);
  assert.equal(rows.find((r) => r.id === "d")!.read_at, null);
  assert.equal(rows.find((r) => r.id === "e")!.read_at, "2026-10-01T00:00:00Z");
});

test("mark-read is a no-op when nothing is unread", async () => {
  const { status, body } = await post(`/api/messages/mark-read?clubId=${CLUB_ID}`);
  assert.equal(status, 200);
  assert.deepEqual(body, { marked: 0, unread: 0 });
  assert.equal(updateFilters.length, 0);
});

test("mark-read surfaces update errors instead of reporting success", async () => {
  rows = [{ id: "a", club_id: CLUB_ID, direction: "inbound", read_at: null }];
  failUpdate = true;
  const { status, body } = await post(`/api/messages/mark-read?clubId=${CLUB_ID}`);
  assert.equal(status, 500);
  assert.equal(body.error, "update failed");
  assert.equal(body.marked, 0);
});
