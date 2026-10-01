import test from "node:test";
import assert from "node:assert/strict";
import { approvalVariantPresentation } from "./approvalVariant.ts";

test("approval cards label each explicitly assigned variant", () => {
  assert.deepEqual(approvalVariantPresentation("with_program"), {
    kind: "with_program",
    label: "with_program / Program suggestion",
  });
  assert.deepEqual(approvalVariantPresentation("no_program"), {
    kind: "no_program",
    label: "no_program / No program suggestion",
  });
});

test("legacy or unknown variants remain pending instead of being inferred", () => {
  assert.deepEqual(approvalVariantPresentation(undefined), {
    kind: "pending",
    label: "Pending variant",
  });
  assert.equal(approvalVariantPresentation(null).kind, "pending");
});