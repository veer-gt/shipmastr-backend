import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShiprocketReadinessRequest } from "./shiprocket-readiness.client.js";
import { mapShiprocketReadinessSummary } from "./shiprocket-readiness.mapper.js";

describe("Shiprocket readiness foundation", () => {
  it("builds only non-destructive readiness requests", () => {
    const request = buildShiprocketReadinessRequest("PICKUP_ADDRESS_LIST");
    assert.equal(request.destructive, false);
    assert.equal(request.params.pickup_pincode, "110001");
    assert.equal(request.params.delivery_pincode, "400001");
    assert.equal(request.auth_model.token_ephemeral, true);
    assert.equal(request.auth_model.token_persisted_to_db, false);
    assert.equal(request.auth_model.token_stored_in_vault, false);
    assert.equal(request.auth_model.token_serialized, false);
    assert.equal(request.auth_model.reauthenticate_on_expiry, true);
    assert.equal(request.uses_merchant_address, false);
    assert.equal(request.uses_buyer_address, false);
    assert.doesNotMatch(JSON.stringify(request), /assign.*awb|generate.*label|create.*order|manifest|cancel|tracking sync|webhook/i);
    assert.doesNotMatch(JSON.stringify(request), /jwt|bearer|token-value|password-value/i);
  });

  it("maps safe summaries without raw payloads", () => {
    const summary = mapShiprocketReadinessSummary({ passed: true, probeType: "PINCODE_SERVICEABILITY" });
    assert.doesNotMatch(JSON.stringify(summary), /rawPayload|rawHeaders|secret|token|password/i);
  });
});
