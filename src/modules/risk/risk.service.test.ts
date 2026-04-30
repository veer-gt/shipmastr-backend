import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateRisk } from "./risk.service.js";

describe("calculateRisk", () => {
  it("scores prepaid orders as low risk by default", () => {
    const result = calculateRisk({
      buyerPhone: "9876543210",
      addressLine1: "221 Market Street",
      addressLine2: "Block A, Floor 2",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      orderValue: 999,
      codAmount: 0,
      paymentMode: "PREPAID"
    });

    assert.equal(result.level, "LOW");
    assert.equal(result.decision, "SHIP");
  });

  it("requires verification for high-value COD risk", () => {
    const result = calculateRisk({
      buyerPhone: "9876543210",
      addressLine1: "221 Market Street",
      addressLine2: "Near central landmark",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      orderValue: 3499,
      codAmount: 3499,
      paymentMode: "COD"
    });

    assert.equal(result.level, "HIGH");
    assert.equal(result.decision, "VERIFY");
  });

  it("blocks critical COD risk with invalid contact and pincode", () => {
    const result = calculateRisk({
      buyerPhone: "1111111111",
      addressLine1: "A",
      addressLine2: null,
      city: "X",
      state: "Y",
      pincode: "123",
      orderValue: 9999,
      codAmount: 9999,
      paymentMode: "COD"
    });

    assert.equal(result.level, "CRITICAL");
    assert.equal(result.decision, "BLOCK");
  });
});
