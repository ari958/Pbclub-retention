import test from "node:test";
import assert from "node:assert/strict";
import { approvalListPath, requestApprovalList, type ApprovalListStatus } from "./approvalListRequest.ts";

test("all approval filters are linked to their selected list request", async () => {
  for (const status of ["all", "drafted", "approved", "skipped", "sent", "needs_context", "manual_edit"] as const) {
    let requested: { slug: string; status: ApprovalListStatus } | undefined;
    const result = await requestApprovalList("pb-club", status, async (slug, selectedStatus) => {
      requested = { slug, status: selectedStatus };
      return { candidates: [] };
    });

    assert.deepEqual(requested, { slug: "pb-club", status });
    assert.deepEqual(result, { candidates: [] });
    assert.equal(approvalListPath(status), `/api/retention/approvals?status=${status}`);
  }
});