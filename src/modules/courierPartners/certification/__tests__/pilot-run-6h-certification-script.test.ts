import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("Pilot Run 6H certification check script", () => {
  it("calls local readiness endpoints only and does not invoke Ship Now or providers", () => {
    const script = readFileSync("scripts/pilot-run-6h-certification-check.cjs", "utf8");
    assert.match(script, /SHIPMASTR_TOKEN/);
    assert.match(script, /courier-certification\/summary/);
    assert.match(script, /courier-certification\/providers\/SHIPROCKET/);
    assert.match(script, /courier-live-readiness\/providers\/SHIPROCKET\/pickups/);
    assert.match(script, /live-ship-readiness/);
    assert.doesNotMatch(script, /ship-now|manifestOrder|createLabel|getLabel|createDraftOrder|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
    assert.doesNotMatch(script, /console\.log\([^)]*token/i);
  });
});
