import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBigshipReadinessProbe } from "./bigship-readiness.service.js";

describe("Bigship readiness request builder", () => {
  it("builds non-destructive readiness probes only", () => {
    const probe = buildBigshipReadinessProbe("RATE_SERVICEABILITY");
    assert.equal(probe.destructive, false);
    assert.equal(probe.params.pickup_pincode, "110001");
    assert.equal(probe.params.delivery_pincode, "400001");
    assert.equal(probe.uses_merchant_address, false);
    assert.equal(probe.uses_buyer_address, false);
    assert.doesNotMatch(JSON.stringify(probe), /createLabel|getLabel|manifestOrder|tracking sync|webhook registration/i);
  });
});
