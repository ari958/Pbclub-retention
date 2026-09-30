/** Mirror of the atomic RPC compare performed under its message-row lock. */
export function assertReviewedBodyUnchanged(expectedBody: string, currentBody: string): void {
  if (expectedBody !== currentBody) {
    throw Object.assign(new Error("Message body changed after review; refresh the draft before approving"), { status: 409 });
  }
}

export function isStaleReviewedBodyError(message: string): boolean {
  return /(?:body.*(?:changed|match|different|mismatch|stale)|(?:changed|does not match|mismatch|stale).*body|stale.*review|review.*(?:stale|changed))/i.test(message);
}