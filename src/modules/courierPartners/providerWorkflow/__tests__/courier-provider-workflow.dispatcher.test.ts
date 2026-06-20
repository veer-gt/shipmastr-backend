import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchCourierProviderAwb,
  dispatchCourierProviderLabel,
  dispatchCourierProviderPickup,
  dispatchCourierProviderRate,
  dispatchCourierProviderWorkflow
} from "../courier-provider-workflow.dispatcher.js";
import {
  serializeAdminCourierProviderWorkflowDispatch,
  serializeSellerSafeCourierProviderWorkflowDispatch
} from "../courier-provider-workflow.serializer.js";
import type {
  CourierProviderAwbRequest,
  CourierProviderLabelRequest,
  CourierProviderRateRequest
} from "../../providerRegistry/courier-provider-workflow.contracts.js";
import type {
  CourierProviderLaneCredentialReadiness,
  CourierProviderRuntimeMode
} from "../../providerRegistry/courier-provider-registry.types.js";

const checkedAt = "2026-06-20T00:00:00.000Z";

function credentialReadiness(
  mode: CourierProviderRuntimeMode = "SANDBOX",
  overrides: Partial<CourierProviderLaneCredentialReadiness> = {}
): CourierProviderLaneCredentialReadiness {
  return {
    status: mode === "LIVE" ? "READY" : "REFERENCE_CONFIGURED",
    credential_ref_configured: true,
    env_ref_configured: false,
    secret_manager_ref_configured: false,
    reference: {
      configured: true,
      ref_type: "CREDENTIAL_REF",
      display_label: "Credential vault reference configured",
      credential_ref_configured: true,
      env_ref_configured: false,
      secret_manager_ref_configured: false
    },
    mode,
    last_test_status: mode === "LIVE" ? "PASS" : null,
    checked_at: checkedAt,
    blockers: [],
    ...overrides
  };
}

function notConfiguredReadiness(mode: CourierProviderRuntimeMode = "SANDBOX") {
  return credentialReadiness(mode, {
    status: "NOT_CONFIGURED",
    credential_ref_configured: false,
    reference: {
      configured: false,
      ref_type: "NONE",
      display_label: "Not configured",
      credential_ref_configured: false,
      env_ref_configured: false,
      secret_manager_ref_configured: false
    },
    last_test_status: null,
    blockers: ["COURIER_PROVIDER_CREDENTIALS_NOT_CONFIGURED", "COURIER_PROVIDER_CREDENTIAL_REFS_MISSING"]
  });
}

const readyDependencies = {
  checkedAt,
  credentialReadinessProvider: async (_merchantId: string | null, _lane: unknown, mode: CourierProviderRuntimeMode) => (
    credentialReadiness(mode)
  )
};

function rateRequest(overrides: Partial<CourierProviderRateRequest> = {}): CourierProviderRateRequest {
  return {
    merchantId: "merchant_1",
    laneCode: "DELHIVERY_B2C_AIR",
    requestedMode: "SANDBOX" as const,
    pickupPincode: "560001",
    deliveryPincode: "110001",
    paymentMode: "PREPAID" as const,
    package: { deadWeightKg: 1, lengthCm: 10, breadthCm: 10, heightCm: 10 },
    ...overrides
  } as CourierProviderRateRequest;
}

function awbRequest(overrides: Partial<CourierProviderAwbRequest> = {}): CourierProviderAwbRequest {
  return {
    merchantId: "merchant_1",
    laneCode: "XPRESSBEES_AIR",
    requestedMode: "SANDBOX" as const,
    pickup: {
      name: "Warehouse",
      addressLine1: "Safe pickup line",
      city: "Bengaluru",
      state: "Karnataka",
      country: "IN",
      pincode: "560001"
    },
    delivery: {
      name: "Buyer",
      addressLine1: "Safe delivery line",
      city: "Delhi",
      state: "Delhi",
      country: "IN",
      pincode: "110001"
    },
    paymentMode: "PREPAID" as const,
    package: { deadWeightKg: 1 },
    ...overrides
  } as CourierProviderAwbRequest;
}

function labelRequest(overrides: Partial<CourierProviderLabelRequest> = {}): CourierProviderLabelRequest {
  return {
    merchantId: "merchant_1",
    laneCode: "SHADOWFAX",
    requestedMode: "SANDBOX" as const,
    providerShipmentRef: "internal-ref-only",
    ...overrides
  } as CourierProviderLabelRequest;
}

describe("courier provider workflow dispatcher", () => {
  it("blocks unknown provider lanes before adapter resolution", async () => {
    const result = await dispatchCourierProviderRate(rateRequest({
      laneCode: "UNKNOWN_LANE" as never
    }), readyDependencies);

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.adapter_result, null);
    assert.ok(result.blockers.includes("COURIER_PROVIDER_LANE_NOT_FOUND"));
  });

  it("returns guarded unsupported capability results", async () => {
    const result = await dispatchCourierProviderWorkflow({
      operation: "WEIGHT_DISPUTE",
      request: {
        merchantId: "merchant_1",
        laneCode: "SHADOWFAX",
        requestedMode: "SANDBOX",
        awbNumber: "safe-awb-placeholder",
        chargedWeightKg: 2,
        expectedWeightKg: 1
      }
    }, readyDependencies);

    assert.equal(result.status, "UNSUPPORTED");
    assert.equal(result.adapter_result, null);
    assert.ok(result.blockers.includes("COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"));
  });

  it("blocks suspended lanes before adapter calls", async () => {
    const result = await dispatchCourierProviderRate(rateRequest({
      laneCode: "EKART"
    }), readyDependencies);

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.adapter_result, null);
    assert.ok(result.blockers.includes("COURIER_PROVIDER_LANE_SUSPENDED"));
  });

  it("blocks missing credential references for sandbox workflows", async () => {
    const result = await dispatchCourierProviderRate(rateRequest(), {
      checkedAt,
      credentialReadinessProvider: async (_merchantId: string | null, _lane: unknown, mode: CourierProviderRuntimeMode) => (
        notConfiguredReadiness(mode)
      )
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.adapter_result, null);
    assert.ok(result.blockers.includes("SANDBOX_CREDENTIAL_REF_REQUIRED"));
    assert.ok(result.blockers.includes("COURIER_PROVIDER_CREDENTIAL_REFS_MISSING"));
  });

  it("blocks live mode unless explicit one-shot guard approval is supplied", async () => {
    const result = await dispatchCourierProviderRate(rateRequest({
      laneCode: "SHIPROCKET",
      requestedMode: "LIVE"
    }), readyDependencies);

    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.includes("PROVIDER_WORKFLOW_LIVE_GUARD_REQUIRED"));
    assert.equal(result.admin_diagnostics.adapter_wired, false);
  });

  it("routes Delhivery rate workflows to a blocked sandbox shell", async () => {
    const result = await dispatchCourierProviderRate(rateRequest(), readyDependencies);

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.adapter_result?.safe_status, "BLOCKED");
    assert.equal(result.admin_diagnostics.adapter_wired, true);
    assert.ok(result.blockers.includes("OFFICIAL_DOCS_REQUIRED"));
    assert.ok(result.blockers.includes("EXTERNAL_CALL_DISABLED"));
  });

  it("routes Xpressbees AWB workflows to a blocked sandbox shell", async () => {
    const result = await dispatchCourierProviderAwb(awbRequest(), readyDependencies);

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.adapter_result?.capability, "AWB");
    assert.ok(result.blockers.includes("OFFICIAL_DOCS_REQUIRED"));
    assert.ok(result.blockers.includes("EXTERNAL_CALL_DISABLED"));
  });

  it("routes Shadowfax label workflows to a blocked sandbox shell", async () => {
    const result = await dispatchCourierProviderLabel(labelRequest(), readyDependencies);

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.adapter_result?.capability, "LABEL");
    assert.ok(result.blockers.includes("OFFICIAL_DOCS_REQUIRED"));
    assert.ok(result.blockers.includes("EXTERNAL_CALL_DISABLED"));
  });

  it("routes pickup workflows through the same gated shell path", async () => {
    const result = await dispatchCourierProviderPickup({
      merchantId: "merchant_1",
      laneCode: "DELHIVERY_B2C_SURFACE",
      requestedMode: "SANDBOX",
      pickupLocationId: "pickup_location_1",
      expectedPackageCount: 1
    }, readyDependencies);

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.adapter_result?.capability, "PICKUP");
    assert.ok(result.blockers.includes("OFFICIAL_DOCS_REQUIRED"));
    assert.ok(result.blockers.includes("EXTERNAL_CALL_DISABLED"));
  });

  it("keeps seller-safe serialization provider neutral", async () => {
    const result = await dispatchCourierProviderRate(rateRequest(), readyDependencies);
    const serialized = serializeSellerSafeCourierProviderWorkflowDispatch(result);
    const json = JSON.stringify(serialized);

    assert.equal(serialized.public_network_name, "Shipmastr Courier Network");
    assert.ok(serialized.public_outcomes.includes("Shipmastr Smart"));
    assert.doesNotMatch(json, /DELHIVERY|XPRESSBEES|SHADOWFAX|EKART|BIGSHIP|SHIPROCKET/i);
    assert.doesNotMatch(json, /lane_code|provider_code|OFFICIAL_DOCS_REQUIRED|EXTERNAL_CALL_DISABLED/i);
  });

  it("keeps admin diagnostics useful but redacted", async () => {
    const result = await dispatchCourierProviderAwb(awbRequest(), readyDependencies);
    const serialized = serializeAdminCourierProviderWorkflowDispatch(result);
    const json = JSON.stringify(serialized);

    assert.equal(serialized.admin_diagnostics.provider_code, "XPRESSBEES");
    assert.equal(serialized.admin_diagnostics.credential_reference_configured, true);
    assert.ok(serialized.admin_diagnostics.blockers.includes("OFFICIAL_DOCS_REQUIRED"));
    assert.doesNotMatch(json, /credential-vault:|secret|token|password|Authorization|Bearer|rawHeaders|rawResponse/i);
  });

  it("does not call HTTP while dispatching blocked provider workflows", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("HTTP_SHOULD_NOT_BE_CALLED");
    }) as typeof fetch;

    try {
      const result = await dispatchCourierProviderRate(rateRequest(), readyDependencies);
      assert.equal(result.status, "BLOCKED");
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
