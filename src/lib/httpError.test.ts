import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HttpError,
  PublicHttpError,
  isPublicErrorDetails
} from "./httpError.js";

describe("PublicHttpError", () => {
  it("accepts a flat record of JSON primitives and primitive arrays", () => {
    const details = { field: "email", retryable: false, attempts: 2, empty: null, reasons: ["taken", 409, false, null] };
    assert.equal(isPublicErrorDetails(details), true);
    assert.deepEqual(new PublicHttpError(409, "EMAIL_TAKEN", details).publicDetails, details);
  });

  it("fails closed for nested or non-JSON detail values", () => {
    for (const details of [{ nested: { token: "secret" } }, { nested: [["secret"]] }, { count: 1n }, new Date()]) {
      const error = new PublicHttpError(400, "INVALID_PUBLIC_DETAILS", details as never);
      assert.equal(error.publicDetails, undefined);
      assert.equal(error.details, details);
    }
  });

  it("keeps ordinary HttpError details available only on the internal error object", () => {
    const details = { providerResponse: "internal" };
    assert.equal(new HttpError(502, "PROVIDER_FAILED", details).details, details);
  });
});
