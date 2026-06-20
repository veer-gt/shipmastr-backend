import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CourierProviderRegistryDependencies } from "../../providerRegistry/courier-provider-registry.types.js";
import {
  createDelhiverySandboxAdapter,
  getDelhiverySandboxReadiness
} from "./delhivery-sandbox.adapter.js";
import { delhiverySandboxLaneCodes } from "./delhivery-sandbox.types.js";

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
    laneCode: "DELHIVERY_B2C_AIR" as const,
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

describe("Delhivery official sandbox adapter foundation", () => {
  it("supports the two internal Delhivery B2C lanes", () => {
    assert.deepEqual([...delhiverySandboxLaneCodes].sort(), [
      "DELHIVERY_B2C_AIR",
      "DELHIVERY_B2C_SURFACE"
    ].sort());

    assert.equal(createDelhiverySandboxAdapter("DELHIVERY_B2C_AIR").laneCode, "DELHIVERY_B2C_AIR");
    assert.equal(createDelhiverySandboxAdapter("DELHIVERY_B2C_SURFACE").laneCode, "DELHIVERY_B2C_SURFACE");
  });

  it("blocks readiness when official docs are unavailable", async () => {
    const readiness = await getDelhiverySandboxReadiness({
      merchantId: "merchant_1",
      laneCode: "DELHIVERY_B2C_AIR",
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
    const readiness = await getDelhiverySandboxReadiness({
      merchantId: "merchant_1",
      laneCode: "DELHIVERY_B2C_SURFACE",
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
    const readiness = await getDelhiverySandboxReadiness({
      merchantId: "merchant_1",
      laneCode: "DELHIVERY_B2C_AIR",
      mode: "LIVE"
    }, {
      ...dependencies(true),
      officialDocsAvailable: true
    });

    assert.equal(readiness.status, "BLOCKED");
    assert.ok(readiness.blockers.includes("DELHIVERY_SANDBOX_MODE_REQUIRED"));
  });

  it("does not make external calls and returns guarded blocked workflow results", async () => {
    const adapter = createDelhiverySandboxAdapter("DELHIVERY_B2C_AIR", {
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
      "Delhivery adapter is a blocked sandbox shell.",
      "No external courier/provider call was made."
    ]);
  });

  it("returns guarded unsupported capability for COD remittance", async () => {
    const adapter = createDelhiverySandboxAdapter("DELHIVERY_B2C_SURFACE", {
      ...dependencies(true),
      officialDocsAvailable: true
    });

    const result = await adapter.reconcileCodRemittance({
      merchantId: "merchant_1",
      laneCode: "DELHIVERY_B2C_SURFACE",
      requestedMode: "SANDBOX",
      amountPaise: 10000
    });

    assert.equal(result.safe_status, "BLOCKED");
    assert.ok((result.safe_data.blockers as string[]).includes("COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"));
  });

  it("normalizes generic status mapping safely", () => {
    const adapter = createDelhiverySandboxAdapter("DELHIVERY_B2C_AIR");

    assert.equal(adapter.mapRawStatus({
      laneCode: "DELHIVERY_B2C_AIR",
      rawStatus: "shipment delivered"
    }), "DELIVERED");
    assert.equal(adapter.mapRawStatus({
      laneCode: "DELHIVERY_B2C_AIR",
      rawStatus: "out for delivery"
    }), "OUT_FOR_DELIVERY");
    assert.equal(adapter.mapRawStatus({
      laneCode: "DELHIVERY_B2C_AIR",
      rawStatus: "unexpected partner string"
    }), "EXCEPTION");
  });

  it("does not serialize secret-like values", async () => {
    const adapter = createDelhiverySandboxAdapter("DELHIVERY_B2C_AIR", {
      ...dependencies(true),
      officialDocsAvailable: false
    });
    const result = await adapter.fetchLabel({
      merchantId: "merchant_1",
      laneCode: "DELHIVERY_B2C_AIR",
      requestedMode: "SANDBOX",
      awbNumber: "sample-awb-from-test"
    });
    const json = JSON.stringify(result);

    assert.doesNotMatch(json, /sample-awb-from-test|token|password|api[_-]?key|secret|cookie|authorization/i);
  });
});
