import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShiprocketReadinessRequest } from "./shiprocket-readiness.client.js";
import { mapShiprocketReadinessSummary } from "./shiprocket-readiness.mapper.js";

describe("Shiprocket readiness foundation", () => {
  it("builds only non-destructive readiness requests", () => {
    const request = buildShiprocketReadinessRequest("PICKUP_ADDRESS_LIST");
    assert.equal(request.destructive, false);
    assert.doesNotMatch(JSON.stringify(request), /assign.*awb|generate.*label|create.*order|manifest|cancel|tracking sync|webhook/i);
  });

  it("maps safe summaries without raw payloads", () => {
    const summary = mapShiprocketReadinessSummary({ passed: true, probeType: "PINCODE_SERVICEABILITY" });
    assert.doesNotMatch(JSON.stringify(summary), /rawPayload|rawHeaders|secret|token|password/i);
  });
});
