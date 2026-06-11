import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShipmozoReadinessRequest } from "./shipmozo-readiness.client.js";
import { mapShipmozoReadinessSummary } from "./shipmozo-readiness.mapper.js";

describe("Shipmozo readiness foundation", () => {
  it("builds only non-destructive readiness requests", () => {
    const request = buildShipmozoReadinessRequest("PINCODE_SERVICEABILITY");
    assert.equal(request.destructive, false);
    assert.doesNotMatch(JSON.stringify(request), /create.*shipment|create.*awb|label|manifest|cancel|tracking sync|webhook/i);
  });

  it("maps safe summaries without raw payloads", () => {
    const summary = mapShipmozoReadinessSummary({ passed: true, probeType: "RATE_SERVICEABILITY" });
    assert.doesNotMatch(JSON.stringify(summary), /rawPayload|rawHeaders|secret|token|password/i);
  });
});

