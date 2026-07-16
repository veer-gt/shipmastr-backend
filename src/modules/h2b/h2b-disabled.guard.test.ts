import assert from "node:assert/strict";
import test from "node:test";
import { h2bDisabledPrefixGuard } from "./h2b-disabled.guard.js";

test("disabled H2B prefix returns 404 without consuming the body", () => {
  let statusCode = 0;
  let ended = false;
  let bodyRead = false;
  const response = {
    status(code: number) {
      statusCode = code;
      return { end() { ended = true; } };
    }
  };
  h2bDisabledPrefixGuard({ on() { bodyRead = true; } } as never, response as never);
  assert.equal(statusCode, 404);
  assert.equal(ended, true);
  assert.equal(bodyRead, false);
});
