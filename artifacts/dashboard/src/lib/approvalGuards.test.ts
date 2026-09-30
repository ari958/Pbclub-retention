import test from "node:test";
import assert from "node:assert/strict";
import { canApprove, snapshotBulk } from "./approvalGuards.ts";

const mk = (id: string, body: string, status = "drafted", key = "p") =>
  ({ id, playbook_key: key, status, message: { body } }) as never;

test("approve refused while editing", () => {
  assert.equal(canApprove(mk("a", "x"), new Set(["a"])), false);
  assert.equal(canApprove(mk("a", "x"), new Set()), true);
});
test("bulk snapshot excludes editing and keeps raw bodies", () => {
  const list = [mk("a", " raw \n"), mk("b", "two"), mk("c", "three", "approved")];
  const s = snapshotBulk(list, new Set(["a", "b", "c"]), "p", new Set(["b"]));
  assert.deepEqual(s.ids, ["a"]);
  assert.deepEqual(s.bodies, { a: " raw \n" });
  assert.deepEqual(s.excludedEditing, ["b"]);
});
test("snapshot is not affected by later polled changes", () => {
  const list = [mk("a", "old")];
  const s = snapshotBulk(list, new Set(["a"]), "p", new Set());
  (list[0] as any).message.body = "new";
  assert.equal(s.bodies.a, "old");
});
