import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBigshipReadinessProbe } from "./bigship-readiness.service.js";

describe("Bigship readiness request builder", () => {
  it("builds non-destructive readiness probes only", () => {
    const probe = buildBigshipReadinessProbe("RATE_SERVICEABILITY");
    assert.equal(probe.destructive, false);
    assert.doesNotMatch(JSON.stringify(probe), /createLabel|getLabel|manifestOrder|tracking sync|webhook registration/i);
  });
});

