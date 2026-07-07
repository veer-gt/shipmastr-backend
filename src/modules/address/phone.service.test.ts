import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HttpError } from "../../lib/httpError.js";
import { getPhoneLast2, hashAddressPhone, normalizeIndianPhone } from "./phone.service.js";

describe("Address A2 phone normalization and hashing", () => {
  it("normalizes valid Indian mobile variants to the same E.164 value", () => {
    const expected = "+919876543243";

    assert.equal(normalizeIndianPhone("9876543243"), expected);
    assert.equal(normalizeIndianPhone("+91 98765-43243"), expected);
    assert.equal(normalizeIndianPhone("91 98765 43243"), expected);
    assert.equal(normalizeIndianPhone("(98765) 43243"), expected);
  });

  it("rejects invalid or non-mobile-ish phone inputs", () => {
    for (const value of ["12345", "+911234567890", "519876543243", "987654324", "987654324312", "abcdefghij"]) {
      assert.throws(
        () => normalizeIndianPhone(value),
        (error) => error instanceof HttpError && error.status === 400 && error.message === "ADDRESS_PHONE_INVALID"
      );
    }
  });

  it("hashes stably for the same pepper and changes when pepper changes", () => {
    const e164 = normalizeIndianPhone("9876543243");
    const first = hashAddressPhone(e164, "pepper_one");
    const second = hashAddressPhone(e164, "pepper_one");
    const different = hashAddressPhone(e164, "pepper_two");

    assert.equal(first, second);
    assert.notEqual(first, different);
    assert.match(first, /^[a-f0-9]{64}$/);
  });

  it("derives last two phone digits from normalized E.164", () => {
    assert.equal(getPhoneLast2(normalizeIndianPhone("+91 98765-43243")), "43");
  });
});
