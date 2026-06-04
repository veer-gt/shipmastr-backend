import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { corsAllowedHeaders } from "./cors.js";

describe("CORS configuration", () => {
  it("allows browser idempotency headers while preserving existing internal headers", () => {
    const expectedHeaders: readonly string[] = [
      "Content-Type",
      "Authorization",
      "X-Auth-Token",
      "X-Journal-Secret",
      "X-Shipmastr-Courier-Key",
      "X-Shipmastr-Signature",
      "X-Shipmastr-Timestamp",
      "Idempotency-Key"
    ];

    const allowedHeaders: readonly string[] = corsAllowedHeaders;

    for (const header of expectedHeaders) {
      assert.ok(allowedHeaders.includes(header), `${header} should be allowed`);
    }
  });
});
