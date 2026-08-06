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

  it("stores a frozen primitive-only snapshot instead of caller-owned details", () => {
    const reasons: Array<string | number | boolean | null> = ["taken", 409, false, null];
    const details = { field: "email", reasons };
    const error = new PublicHttpError(409, "EMAIL_TAKEN", details);

    details.field = "mutated-after-construction";
    reasons[0] = "sk-mutated-array-sentinel";
    reasons.push("sk-appended-array-sentinel");

    assert.deepEqual(error.publicDetails, {
      field: "email",
      reasons: ["taken", 409, false, null]
    });
    assert.notEqual(error.publicDetails, details);
    assert.notEqual(error.publicDetails?.reasons, reasons);
    assert.equal(Object.isFrozen(error.publicDetails), true);
    assert.equal(Object.isFrozen(error.publicDetails?.reasons), true);
    assert.equal(error.details, details);
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, "publicDetails"), {
      value: error.publicDetails,
      writable: false,
      enumerable: true,
      configurable: false
    });
  });

  it("rejects overridden and proxied arrays without invoking their hostile behavior", () => {
    const sentinel = "sk-hostile-public-array-sentinel";
    const overridden = ["safe"];
    Object.defineProperties(overridden, {
      every: {
        configurable: true,
        enumerable: false,
        value: () => true
      },
      toJSON: {
        configurable: true,
        enumerable: false,
        value: () => [{ token: sentinel }]
      }
    });

    let proxyReads = 0;
    const proxied = new Proxy(["safe"], {
      get(target, property, receiver) {
        proxyReads += 1;
        if (property === "every") return () => true;
        if (property === "toJSON") return () => [{ token: sentinel }];
        return Reflect.get(target, property, receiver);
      }
    });

    for (const details of [{ reasons: overridden }, { reasons: proxied }]) {
      const error = new PublicHttpError(400, "INVALID_PUBLIC_DETAILS", details as never);
      assert.equal(error.publicDetails, undefined);
      assert.equal(error.details, details);
    }
    assert.equal(proxyReads, 0);
  });

  it("rejects a non-enumerable toJSON hook that could emit nested secrets", () => {
    const sentinel = "sk-hidden-to-json-sentinel";
    const details = { field: "email" };
    Object.defineProperty(details, "toJSON", {
      configurable: true,
      enumerable: false,
      value: () => ({ field: "email", nested: { token: sentinel } })
    });

    const error = new PublicHttpError(400, "INVALID_PUBLIC_DETAILS", details);

    assert.equal(isPublicErrorDetails(details), false);
    assert.equal(error.publicDetails, undefined);
    assert.equal(error.details, details);
  });

  it("rejects accessors without invoking their getters", () => {
    const sentinel = "sk-public-details-getter-sentinel";
    let getterReads = 0;
    const details: Record<string, unknown> = {};
    Object.defineProperty(details, "field", {
      configurable: true,
      enumerable: true,
      get() {
        getterReads += 1;
        return sentinel;
      }
    });

    const error = new PublicHttpError(400, "INVALID_PUBLIC_DETAILS", details as never);

    assert.equal(getterReads, 0);
    assert.equal(error.publicDetails, undefined);
    assert.equal(error.details, details);
  });

  it("rejects hidden keys, non-plain records, sparse or non-standard arrays, and non-finite values", () => {
    const symbolDetails = { field: "email", [Symbol("hidden")]: "sk-symbol-sentinel" };
    const nonPlainDetails = Object.assign(Object.create(null) as Record<string, unknown>, { field: "email" });
    const sparse = new Array<string>(1);
    const extraProperty = ["email"] as string[] & { hidden?: string };
    extraProperty.hidden = "sk-extra-array-property";
    const nonStandardPrototype = ["email"];
    Object.setPrototypeOf(nonStandardPrototype, Object.create(Array.prototype));

    const cases: unknown[] = [
      symbolDetails,
      nonPlainDetails,
      { fields: sparse },
      { fields: extraProperty },
      { fields: nonStandardPrototype },
      { attempts: Number.POSITIVE_INFINITY },
      { attempts: Number.NaN }
    ];

    for (const details of cases) {
      const error = new PublicHttpError(400, "INVALID_PUBLIC_DETAILS", details as never);
      assert.equal(isPublicErrorDetails(details), false);
      assert.equal(error.publicDetails, undefined);
      assert.equal(error.details, details);
    }
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
