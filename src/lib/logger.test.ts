import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loggerRedactPaths } from "./logger.js";

describe("logger redaction", () => {
  it("redacts internal and provider-sensitive request headers", () => {
    for (const path of [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-internal-secret",
      "req.headers.x-shipmastr-task-secret",
      "req.headers.x-shipmastr-courier-key",
      "req.headers.x-shipmastr-signature",
      "req.headers['x-internal-secret']",
      "req.headers['x-shipmastr-task-secret']"
    ]) {
      assert.ok(loggerRedactPaths.includes(path), `${path} should be redacted`);
    }
  });
});
