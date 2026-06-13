import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const gateScript = require("../../../../../scripts/pilot-run-6h-one-shot-readiness-gate.cjs");

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    certifiedRouting: {
      decision: "AWB_READY",
      readiness: {
        rates_ready: true,
        pickup_available: true
      },
      blockers: []
    },
    readinessAutopilot: {
      capabilities: {
        rates: "READY"
      },
      blockers: []
    },
    pickupServiceability: {
      status: "READY",
      blockers: []
    },
    awbDryRun: {
      dry_run_ready: true,
      live_one_shot_ready: true,
      blockers: []
    },
    labelDryRun: {
      dry_run_ready: true,
      blockers: []
    },
    trackingDryRun: {
      dry_run_ready: true,
      blockers: []
    },
    providerCertification: {
      blockers: []
    },
    ...overrides
  };
}

describe("Pilot Run 6H one-shot readiness gate script", () => {
  it("fails closed without a token and defaults to the local Pilot Run 6H context", () => {
    assert.equal(gateScript.DEFAULT_API_BASE_URL, "http://localhost:8080/api/shipping");
    assert.equal(gateScript.DEFAULT_PROVIDER_KEY, "SHIPROCKET");
    assert.equal(gateScript.DEFAULT_SHIPMENT_ID, "cmqamlku6000am1qh7amfz3m5");
    assert.throws(() => gateScript.runtimeFromEnv({}), /SHIPMASTR_TOKEN is required/);

    const runtime = gateScript.runtimeFromEnv({ SHIPMASTR_TOKEN: "test-token" });
    assert.equal(runtime.apiBase, "http://localhost:8080/api/shipping");
    assert.equal(runtime.providerKey, "SHIPROCKET");
    assert.equal(runtime.shipmentId, "cmqamlku6000am1qh7amfz3m5");
  });

  it("uses only safe dry-run/readiness endpoints in its request plan", () => {
    const runtime = {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2"
    };
    const plan = gateScript.readinessRequestPlan(runtime);
    const endpoints = Object.values(plan).join("\n");
    const source = readFileSync("scripts/pilot-run-6h-one-shot-readiness-gate.cjs", "utf8");

    assert.match(endpoints, /courier-certification\/summary/);
    assert.match(endpoints, /provider-readiness-autopilot/);
    assert.match(endpoints, /certified-provider-routing/);
    assert.match(endpoints, /courier-pickup-serviceability/);
    assert.match(endpoints, /awb-certification\/providers\/SHIPROCKET\/shipments\/shipment_1\/dry-run/);
    assert.match(endpoints, /label-certification\/providers\/SHIPROCKET\/shipments\/shipment_1\/dry-run/);
    assert.match(endpoints, /tracking-certification\/providers\/SHIPROCKET\/shipments\/shipment_1\/dry-run/);
    assert.doesNotMatch(endpoints, /live-one-shot|ship-now|label-one-shot|live-read-one-shot/i);
    assert.doesNotMatch(source, /request\(runtime,\s*[^)]*live-one-shot/is);
    assert.doesNotMatch(source, /request\(runtime,\s*[^)]*ship-now/is);
  });

  it("blocks when pickup is unavailable", () => {
    const gate = gateScript.computeGate(baseInput({
      pickupServiceability: {
        status: "PICKUP_UNAVAILABLE",
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"]
      },
      certifiedRouting: {
        decision: "RUN_PICKUP_TRIAL",
        readiness: { rates_ready: false, pickup_available: false },
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"]
      }
    }));

    assert.equal(gate.ready, false);
    assert.ok(gate.blockers.includes("ONE_SHOT_GATE_PICKUP_UNAVAILABLE"));
    assert.ok(gate.blockers.includes("ONE_SHOT_GATE_CERTIFIED_ROUTING_NOT_READY"));
  });

  it("blocks when rates, AWB dry-run, or one-shot approval are not ready", () => {
    const gate = gateScript.computeGate(baseInput({
      certifiedRouting: {
        decision: "RATES_ONLY",
        readiness: { rates_ready: false, pickup_available: true },
        blockers: ["PROVIDER_RATES_NOT_LIVE"]
      },
      readinessAutopilot: {
        capabilities: { rates: "BLOCKED" },
        blockers: ["PROVIDER_RATES_NOT_LIVE"]
      },
      awbDryRun: {
        dry_run_ready: false,
        live_one_shot_ready: false,
        blockers: ["AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"]
      }
    }));

    assert.equal(gate.ready, false);
    assert.ok(gate.blockers.includes("ONE_SHOT_GATE_RATES_NOT_READY"));
    assert.ok(gate.blockers.includes("ONE_SHOT_GATE_AWB_DRY_RUN_NOT_READY"));
    assert.ok(gate.blockers.includes("ONE_SHOT_GATE_AWB_ONE_SHOT_NOT_READY"));
  });

  it("is ready only when all gates pass", () => {
    const gate = gateScript.computeGate(baseInput());
    assert.equal(gate.ready, true);
    assert.equal(gate.ratesReady, true);
    assert.equal(gate.pickupAvailable, true);
    assert.equal(gate.awbDryRunReady, true);
    assert.equal(gate.awbLiveOneShotReady, true);
    assert.equal(gate.labelDryRunReady, true);
    assert.equal(gate.trackingDryRunReady, true);
  });

  it("does not print a live command when blocked and uses placeholders when ready", () => {
    const runtime = {
      apiBase: "http://localhost:8080/api/shipping",
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2"
    };
    const blocked = gateScript.renderReport(runtime, gateScript.computeGate(baseInput({
      awbDryRun: {
        dry_run_ready: true,
        live_one_shot_ready: false,
        blockers: ["AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"]
      }
    })));
    const ready = gateScript.renderReport(runtime, gateScript.computeGate(baseInput()));

    assert.match(blocked, /READY_FOR_AWB_ONE_SHOT: no/);
    assert.match(blocked, /command template: not printed/);
    assert.doesNotMatch(blocked, /\/live-one-shot/);
    assert.match(ready, /READY_FOR_AWB_ONE_SHOT: yes/);
    assert.match(ready, /<SHIPMASTR_ADMIN_TOKEN>/);
    assert.match(ready, /<ONE_SHOT_TOKEN>/);
    assert.match(ready, /\/live-one-shot/);
    assert.doesNotMatch(ready, /test-token|Authorization: Bearer test-token|secret|password|credential|rawPayload|rawHeaders|rawResponse|Bigship|Shipmozo/i);
  });
});
