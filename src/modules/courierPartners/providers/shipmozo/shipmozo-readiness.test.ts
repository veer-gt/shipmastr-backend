import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShipmozoReadinessRequest } from "./shipmozo-readiness.client.js";
import { mapShipmozoReadinessSummary } from "./shipmozo-readiness.mapper.js";

describe("Shipmozo readiness foundation", () => {
  it("builds only non-destructive readiness requests", () => {
    const request = buildShipmozoReadinessRequest("PINCODE_SERVICEABILITY");
    assert.equal(request.destructive, false);
    assert.equal(request.params.pickup_pincode, "110001");
    assert.equal(request.params.delivery_pincode, "400001");
    assert.equal(request.credential_fields_provisional, true);
    assert.match(request.credential_fields_note, /TODO: Confirm Shipmozo API credential field names/);
    assert.equal(request.uses_merchant_address, false);
    assert.equal(request.uses_buyer_address, false);
    assert.doesNotMatch(JSON.stringify(request), /create.*shipment|create.*awb|label|manifest|cancel|tracking sync|webhook/i);
  });

  it("maps safe summaries without raw payloads", () => {
    const summary = mapShipmozoReadinessSummary({ passed: true, probeType: "RATE_SERVICEABILITY" });
    assert.doesNotMatch(JSON.stringify(summary), /rawPayload|rawHeaders|secret|token|password/i);
  });
});
