import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerateRetentionDraftsResponse, ListRetentionApprovalsResponse } from "@workspace/api-zod";
import type { LtpSequenceStatus } from "../retentionTypes";

test("generated approval and draft validators accept the terminal test status", () => {
  const status: LtpSequenceStatus = "exited_test";
  assert.equal(ListRetentionApprovalsResponse.shape.candidates.element.shape.sequence_status.parse(status), status);
  assert.equal(GenerateRetentionDraftsResponse.shape.drafts.element.shape.sequence_status.parse(status), status);
});
