import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourierProviderRegistryDependencies } from "../../providerRegistry/courier-provider-registry.types.js";
import {
  createShadowfaxSandboxAdapter,
  getShadowfaxSandboxReadiness
} from "./shadowfax-sandbox.adapter.js";
import { shadowfaxSandboxLaneCodes } from "./shadowfax-sandbox.types.js";

const checkedAt = "2026-06-20T00:00:00.000Z";

function dependencies(configured: boolean): CourierProviderRegistryDependencies {
  return {
    checkedAt,
    credentialReadinessProvider: async (_merchantId, _lane, mode) => ({
      status: configured ? "REFERENCE_CONFIGURED" : "NOT_CONFIGURED",
      credential_ref_configured: configured,
      env_ref_configured: false,
      secret_manager_ref_configured: false,
      reference: {
        configured,
        ref_type: configured ? "CREDENTIAL_REF" : "NONE",
        display_label: configured ? "Credential vault reference configured" : "Not configured",
        credential_ref_configured: configured,
        env_ref_configured: false,
        secret_manager_ref_configured: false
      },
      mode,
      last_test_status: null,
      checked_at: checkedAt,
      blockers: configured ? [] : ["COURIER_PROVIDER_CREDENTIAL_REFS_MISSING"]
    })
  };
}

function rateRequest(mode: "SANDBOX" | "LIVE" = "SANDBOX") {
  return {
    merchantId: "merchant_1",
    laneCode: "SHADOWFAX" as const,
    requestedMode: mode,
    pickupPincode: "560001",
    deliveryPincode: "400001",
    paymentMode: "PREPAID" as const,
    package: {
      deadWeightKg: 0.5,
      lengthCm: 10,
      breadthCm: 10,
      heightCm: 10
    }
  };
}

describe("Shadowfax official sandbox adapter foundation", () => {
  it("supports the internal Shadowfax lane", () => {
    assert.deepEqual([...shadowfaxSandboxLaneCodes], ["SHADOWFAX"]);
    assert.equal(createShadowfaxSandboxAdapter("SHADOWFAX").laneCode, "SHADOWFAX");
  });

  it("blocks readiness when official docs are unavailable", async () => {
    const readiness = await getShadowfaxSandboxReadiness({
      merchantId: "merchant_1",
      laneCode: "SHADOWFAX",
      mode: "SANDBOX"
    }, {
      ...dependencies(true),
      officialDocsAvailable: false
    });

    assert.equal(readiness.status, "BLOCKED");
    assert.ok(readiness.blockers.includes("OFFICIAL_DOCS_REQUIRED"));
    assert.equal(readiness.external_call_enabled, false);
  });

  it("blocks readiness when sandbox credential refs are missing", async () => {
    const readiness = await getShadowfaxSandboxReadiness({
      merchantId: "merchant_1",
      laneCode: "SHADOWFAX",
      mode: "SANDBOX"
    }, {
      ...dependencies(false),
      officialDocsAvailable: true
    });

    assert.equal(readiness.status, "BLOCKED");
    assert.ok(readiness.blockers.includes("SANDBOX_CREDENTIAL_REF_REQUIRED"));
    assert.equal(readiness.sandbox_credential_ref_configured, false);
  });

  it("blocks live mode even when docs and credential refs are present", async () => {
    const readiness = await getShadowfaxSandboxReadiness({
      merchantId: "merchant_1",
      laneCode: "SHADOWFAX",
      mode: "LIVE"
    }, {
      ...dependencies(true),
      officialDocsAvailable: true
    });

    assert.equal(readiness.status, "BLOCKED");
    assert.ok(readiness.blockers.includes("SHADOWFAX_SANDBOX_MODE_REQUIRED"));
  });

  it("does not make external calls and returns guarded blocked workflow results", async () => {
    const adapter = createShadowfaxSandboxAdapter("SHADOWFAX", {
      ...dependencies(true),
      officialDocsAvailable: false
    });

    const result = await adapter.calculateRates(rateRequest());

    assert.equal(result.safe_status, "BLOCKED");
    assert.equal(result.provider_raw_response_stored, false);
    assert.equal(result.provider_headers_stored, false);
    assert.equal(result.credential_values_exposed, false);
    assert.equal(result.safe_data.external_call_enabled, false);
    assert.deepEqual(result.warnings, [
      "Shadowfax adapter is a blocked sandbox shell.",
      "No external courier/provider call was made."
    ]);
  });

  it("returns guarded unsupported capability for weight disputes", async () => {
    const adapter = createShadowfaxSandboxAdapter("SHADOWFAX", {
      ...dependencies(true),
      officialDocsAvailable: true
    });

    const result = await adapter.submitWeightDispute({
      merchantId: "merchant_1",
      laneCode: "SHADOWFAX",
      requestedMode: "SANDBOX",
      chargedWeightKg: 1.4,
      expectedWeightKg: 0.8
    });

    assert.equal(result.safe_status, "BLOCKED");
    assert.ok((result.safe_data.blockers as string[]).includes("COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"));
  });

  it("normalizes generic status mapping safely", () => {
    const adapter = createShadowfaxSandboxAdapter("SHADOWFAX");

    assert.equal(adapter.mapRawStatus({
      laneCode: "SHADOWFAX",
      rawStatus: "shipment delivered"
    }), "DELIVERED");
    assert.equal(adapter.mapRawStatus({
      laneCode: "SHADOWFAX",
      rawStatus: "out for delivery"
    }), "OUT_FOR_DELIVERY");
    assert.equal(adapter.mapRawStatus({
      laneCode: "SHADOWFAX",
      rawStatus: "unexpected partner string"
    }), "EXCEPTION");
  });

  it("does not serialize secret-like values", async () => {
    const adapter = createShadowfaxSandboxAdapter("SHADOWFAX", {
      ...dependencies(true),
      officialDocsAvailable: false
    });
    const result = await adapter.fetchLabel({
      merchantId: "merchant_1",
      laneCode: "SHADOWFAX",
      requestedMode: "SANDBOX",
      awbNumber: "sample-awb-from-test"
    });
    const json = JSON.stringify(result);

    assert.doesNotMatch(json, /sample-awb-from-test|token|password|api[_-]?key|secret|cookie|authorization/i);
  });
});
