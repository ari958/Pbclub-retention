import assert from "node:assert/strict";
import { test } from "node:test";
import { parkInRetentionOnlyMode } from "../retentionPolicy.js";

const originalRetentionMode = process.env.RETENTION_ONLY_MODE;

test("retention-only parking middleware returns 423 without continuing", () => {
  process.env.RETENTION_ONLY_MODE = "true";
  let statusCode = 0;
  let responseBody: unknown;
  let continued = false;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  };

  parkInRetentionOnlyMode("parked")({} as any, response as any, () => { continued = true; });

  assert.equal(statusCode, 423);
  assert.deepEqual(responseBody, { error: "parked" });
  assert.equal(continued, false);
});

test("legacy creation parking is disabled only when retention mode is explicitly false", () => {
  process.env.RETENTION_ONLY_MODE = "false";
  let continued = false;

  parkInRetentionOnlyMode("parked")({} as any, {} as any, () => { continued = true; });

  assert.equal(continued, true);
});

test("retention-mode test environment is restored", () => {
  if (originalRetentionMode === undefined) delete process.env.RETENTION_ONLY_MODE;
  else process.env.RETENTION_ONLY_MODE = originalRetentionMode;
});