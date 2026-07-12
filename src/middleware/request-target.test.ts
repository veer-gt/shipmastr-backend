import assert from "node:assert/strict";
import test from "node:test";
import { validateRequestTarget } from "./request-target.js";

function run(url: string) {
  let nextCalled = false;
  try {
    validateRequestTarget({ originalUrl: url, url } as any, {} as any, () => { nextCalled = true; });
    return { nextCalled, error: "" };
  } catch (error) {
    return { nextCalled, error: (error as Error).message };
  }
}

test("request target guard accepts bounded route and query values", () => {
  assert.deepEqual(run("/v1/orders/order_123?page=2&status=ready"), { nextCalled: true, error: "" });
});

test("request target guard rejects traversal, malformed encoding, and oversized query values", () => {
  assert.equal(run("/v1/orders/../admin").error, "ROUTE_PARAMETER_INVALID");
  assert.equal(run("/v1/orders/%E0%A4%A").error, "ROUTE_PARAMETER_ENCODING_INVALID");
  assert.equal(run(`/v1/orders?id=${"x".repeat(1_025)}`).error, "QUERY_PARAMETER_INVALID");
});
