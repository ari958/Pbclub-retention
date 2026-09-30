import { assertReviewedBodyUnchanged, isStaleReviewedBodyError } from "../retentionApproval.js";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const reviewedBody = "Sam, the clinic has room Friday.";
assertReviewedBodyUnchanged(reviewedBody, reviewedBody);

let staleError: any;
try {
  // Models the RPC's comparison under lock after a concurrent edit.
  assertReviewedBodyUnchanged(reviewedBody, "Sam, the clinic has room Saturday.");
} catch (error) {
  staleError = error;
}
assert(staleError?.status === 409, "body mutation after review produces a 409 conflict");
assert(isStaleReviewedBodyError(staleError.message), "stale RPC message is recognized as an approval conflict");

console.log("Retention approval snapshot tests passed");