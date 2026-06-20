import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchCourierProviderCodPayoutAction,
  dispatchCourierProviderAwb,
  dispatchCourierProviderLabel,
  dispatchCourierProviderNdrContactUpdate,
  dispatchCourierProviderNdrSubmit,
  dispatchCourierProviderPickup,
  dispatchCourierProviderRate,
  dispatchCourierProviderWeightDiscrepancyAccept,
  dispatchCourierProviderWeightDiscrepancyRemark,
  dispatchCourierProviderWorkflow,
  previewCourierProviderNdrAction,
  readCourierProviderCodRemittance,
  readCourierProviderCourierImageMetadata,
  readCourierProviderWeightDiscrepancy,
  readCourierProviderWeightDiscrepancyHistory,
  reconcileCourierProviderCodRemittance
} from "../courier-provider-workflow.dispatcher.js";
import {
  serializeAdminCourierProviderWorkflowDispatch,
  serializeSellerSafeCourierProviderWorkflowDispatch
} from "../courier-provider-workflow.serializer.js";
import type {
  CourierProviderAwbRequest,
  CourierProviderCodPayoutActionRequest,
  CourierProviderCodRemittanceReadRequest,
  CourierProviderCodRemittanceReconciliationRequest,
  CourierProviderCourierImageMetadataRequest,
  CourierProviderLabelRequest,
  CourierProviderNdrContactUpdateRequest,
  CourierProviderNdrPreviewRequest,
  CourierProviderNdrRequest,
  CourierProviderRateRequest,
  CourierProviderWeightDiscrepancyAcceptRequest,
  CourierProviderWeightDiscrepancyHistoryRequest,
  CourierProviderWeightDiscrepancyReadRequest,
  CourierProviderWeightDiscrepancyRemarkRequest
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

function ndrRequest(overrides: Partial<CourierProviderNdrPreviewRequest> = {}): CourierProviderNdrPreviewRequest {
  return {
    merchantId: "merchant_1",
    laneCode: "DELHIVERY_B2C_AIR",
    requestedMode: "SANDBOX",
    awbNumber: "safe-awb-placeholder",
    action: "REATTEMPT",
    reattemptDate: "2026-06-21",
    safeRemarks: "Customer requested one more attempt.",
    ndrCaseId: "ndr_case_1",
    safeReasonCode: "CUSTOMER_UNAVAILABLE",
    phoneLast4: "1234",
    addressQualitySignal: "NEEDS_REVIEW",
    ...overrides
  } as CourierProviderNdrPreviewRequest;
}

function ndrContactUpdateRequest(
  overrides: Partial<CourierProviderNdrContactUpdateRequest> = {}
): CourierProviderNdrContactUpdateRequest {
  return {
    ...ndrRequest(),
    phoneLast4: "9876",
    addressUpdateSummary: "Address landmark added.",
    ...overrides
  } as CourierProviderNdrContactUpdateRequest;
}

function weightReadRequest(
  overrides: Partial<CourierProviderWeightDiscrepancyReadRequest> = {}
): CourierProviderWeightDiscrepancyReadRequest {
  return {
    merchantId: "merchant_1",
    laneCode: "XPRESSBEES_AIR",
    requestedMode: "SANDBOX",
    discrepancyCaseId: "weight_case_1",
    awbNumber: "safe-awb-placeholder",
    ...overrides
  } as CourierProviderWeightDiscrepancyReadRequest;
}

function weightHistoryRequest(
  overrides: Partial<CourierProviderWeightDiscrepancyHistoryRequest> = {}
): CourierProviderWeightDiscrepancyHistoryRequest {
  return {
    ...weightReadRequest(),
    safePeriodLabel: "June 2026",
    ...overrides
  } as CourierProviderWeightDiscrepancyHistoryRequest;
}

function weightRemarkRequest(
  overrides: Partial<CourierProviderWeightDiscrepancyRemarkRequest> = {}
): CourierProviderWeightDiscrepancyRemarkRequest {
  return {
    merchantId: "merchant_1",
    laneCode: "XPRESSBEES_AIR",
    requestedMode: "SANDBOX",
    awbNumber: "safe-awb-placeholder",
    chargedWeightKg: 2.4,
    expectedWeightKg: 1.2,
    safeEvidenceRefs: ["fixture-image-1"],
    safeRemark: "Seller disputes measured weight.",
    ...overrides
  } as CourierProviderWeightDiscrepancyRemarkRequest;
}

function weightAcceptRequest(
  overrides: Partial<CourierProviderWeightDiscrepancyAcceptRequest> = {}
): CourierProviderWeightDiscrepancyAcceptRequest {
  return {
    ...weightRemarkRequest(),
    acceptanceReason: "Seller accepted charge after review.",
    ...overrides
  } as CourierProviderWeightDiscrepancyAcceptRequest;
}

function courierImageMetadataRequest(
  overrides: Partial<CourierProviderCourierImageMetadataRequest> = {}
): CourierProviderCourierImageMetadataRequest {
  return {
    merchantId: "merchant_1",
    laneCode: "XPRESSBEES_AIR",
    requestedMode: "SANDBOX",
    imageRef: "fixture-image-1",
    fixtureOnly: true,
    metadata: {
      contentType: "image/jpeg",
      byteSize: 1200,
      capturedAt: checkedAt
    },
    ...overrides
  } as CourierProviderCourierImageMetadataRequest;
}

function codReadRequest(
  overrides: Partial<CourierProviderCodRemittanceReadRequest> = {}
): CourierProviderCodRemittanceReadRequest {
  return {
    merchantId: "merchant_1",
    laneCode: "SHIPROCKET",
    requestedMode: "SANDBOX",
    remittanceReference: "remit_ref_1",
    reconciliationReference: "recon_ref_1",
    amountPaise: 125000,
    safePeriodLabel: "June 2026",
    ...overrides
  } as CourierProviderCodRemittanceReadRequest;
}

function codReconciliationRequest(
  overrides: Partial<CourierProviderCodRemittanceReconciliationRequest> = {}
): CourierProviderCodRemittanceReconciliationRequest {
  return {
    ...codReadRequest(),
    providerAmountPaise: 125000,
    ledgerSourceOfTruth: "SHIPMASTR_WALLET_LEDGER",
    ...overrides
  } as CourierProviderCodRemittanceReconciliationRequest;
}

function codPayoutActionRequest(
  overrides: Partial<CourierProviderCodPayoutActionRequest> = {}
): CourierProviderCodPayoutActionRequest {
  return {
    ...codReadRequest(),
    payoutAction: "RELEASE",
    ...overrides
  } as CourierProviderCodPayoutActionRequest;
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

  it("stages NDR action previews as safe provider payload summaries", async () => {
    const result = await previewCourierProviderNdrAction(ndrRequest(), readyDependencies);

    assert.equal(result.status, "DISPATCHED");
    assert.equal(result.safe_status, "STAGED");
    assert.equal(result.adapter_result, null);
    assert.equal(result.contract_data?.contract, "NDR_ACTION_PREVIEW");
    assert.equal(result.contract_data?.provider_mutation_enabled, false);
    assert.equal((result.contract_data?.payload_summary as Record<string, unknown>).no_full_phone_or_address, true);
  });

  it("blocks NDR submit and contact update contracts by default", async () => {
    const submit = await dispatchCourierProviderNdrSubmit(ndrRequest() as CourierProviderNdrRequest, readyDependencies);
    const contactUpdate = await dispatchCourierProviderNdrContactUpdate(ndrContactUpdateRequest(), readyDependencies);

    assert.equal(submit.status, "BLOCKED");
    assert.ok(submit.blockers.includes("OFFICIAL_DOCS_REQUIRED"));
    assert.ok(submit.blockers.includes("EXTERNAL_CALL_DISABLED"));
    assert.equal(contactUpdate.status, "BLOCKED");
    assert.ok(contactUpdate.blockers.includes("PROVIDER_NDR_CONTACT_UPDATE_BLOCKED"));
    assert.equal(contactUpdate.contract_data?.provider_mutation_enabled, false);
  });

  it("guards weight discrepancy read, history, remark, accept, and image metadata contracts", async () => {
    const read = await readCourierProviderWeightDiscrepancy(weightReadRequest(), readyDependencies);
    const history = await readCourierProviderWeightDiscrepancyHistory(weightHistoryRequest(), readyDependencies);
    const remark = await dispatchCourierProviderWeightDiscrepancyRemark(weightRemarkRequest(), readyDependencies);
    const accept = await dispatchCourierProviderWeightDiscrepancyAccept(weightAcceptRequest(), readyDependencies);
    const image = await readCourierProviderCourierImageMetadata(courierImageMetadataRequest(), readyDependencies);

    assert.equal(read.status, "DISPATCHED");
    assert.equal(read.safe_status, "STAGED");
    assert.equal(history.contract_data?.contract, "WEIGHT_DISCREPANCY_HISTORY");
    assert.equal(remark.status, "BLOCKED");
    assert.ok(remark.blockers.includes("PROVIDER_WEIGHT_DISCREPANCY_MUTATION_BLOCKED"));
    assert.equal(accept.status, "BLOCKED");
    assert.equal(image.status, "DISPATCHED");
    assert.equal(image.contract_data?.image_metadata_only, true);
    assert.equal(image.contract_data?.fixture_only, true);
    assert.equal(image.contract_data?.provider_mutation_enabled, false);
  });

  it("guards COD remittance read and reconciliation without overwriting wallet ledger source of truth", async () => {
    const read = await readCourierProviderCodRemittance(codReadRequest(), readyDependencies);
    const reconciliation = await reconcileCourierProviderCodRemittance(codReconciliationRequest(), readyDependencies);

    assert.equal(read.status, "DISPATCHED");
    assert.equal(read.safe_status, "STAGED");
    assert.equal(reconciliation.status, "DISPATCHED");
    assert.equal(reconciliation.contract_data?.ledger_source_of_truth, "SHIPMASTR_WALLET_LEDGER");
    assert.equal(reconciliation.contract_data?.wallet_ledger_overwrite_enabled, false);
    assert.equal(reconciliation.contract_data?.provider_mutation_enabled, false);
  });

  it("keeps COD payout actions explicitly unsupported and blocked", async () => {
    const result = await dispatchCourierProviderCodPayoutAction(codPayoutActionRequest(), readyDependencies);

    assert.equal(result.status, "UNSUPPORTED");
    assert.equal(result.blocked, true);
    assert.ok(result.blockers.includes("COD_PAYOUT_ACTION_UNSUPPORTED"));
    assert.equal(result.contract_data?.wallet_ledger_overwrite_enabled, false);
  });

  it("keeps Phase 58 contracts behind missing credential and live guards", async () => {
    const missingCredential = await previewCourierProviderNdrAction(ndrRequest(), {
      checkedAt,
      credentialReadinessProvider: async (_merchantId: string | null, _lane: unknown, mode: CourierProviderRuntimeMode) => (
        notConfiguredReadiness(mode)
      )
    });
    const liveCodRead = await readCourierProviderCodRemittance(codReadRequest({
      requestedMode: "LIVE"
    }), readyDependencies);
    const unsupportedWeight = await readCourierProviderWeightDiscrepancy(weightReadRequest({
      laneCode: "SHADOWFAX"
    }), readyDependencies);

    assert.equal(missingCredential.status, "BLOCKED");
    assert.equal(missingCredential.contract_data, null);
    assert.ok(missingCredential.blockers.includes("SANDBOX_CREDENTIAL_REF_REQUIRED"));
    assert.equal(liveCodRead.status, "BLOCKED");
    assert.ok(liveCodRead.blockers.includes("PROVIDER_WORKFLOW_LIVE_GUARD_REQUIRED"));
    assert.equal(unsupportedWeight.status, "UNSUPPORTED");
    assert.ok(unsupportedWeight.blockers.includes("COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"));
  });

  it("keeps seller-safe serialization provider neutral", async () => {
    const result = await dispatchCourierProviderRate(rateRequest(), readyDependencies);
    const ndrPreview = await previewCourierProviderNdrAction(ndrRequest(), readyDependencies);
    const serialized = serializeSellerSafeCourierProviderWorkflowDispatch(result);
    const serializedNdr = serializeSellerSafeCourierProviderWorkflowDispatch(ndrPreview);
    const json = JSON.stringify(serialized);
    const ndrJson = JSON.stringify(serializedNdr);

    assert.equal(serialized.public_network_name, "Shipmastr Courier Network");
    assert.ok(serialized.public_outcomes.includes("Shipmastr Smart"));
    assert.doesNotMatch(json, /DELHIVERY|XPRESSBEES|SHADOWFAX|EKART|BIGSHIP|SHIPROCKET/i);
    assert.doesNotMatch(json, /lane_code|provider_code|OFFICIAL_DOCS_REQUIRED|EXTERNAL_CALL_DISABLED/i);
    assert.doesNotMatch(ndrJson, /DELHIVERY|XPRESSBEES|SHADOWFAX|EKART|BIGSHIP|SHIPROCKET/i);
    assert.doesNotMatch(ndrJson, /lane_code|provider_code|safe-awb-placeholder|1234|CUSTOMER_UNAVAILABLE/i);
  });

  it("keeps admin diagnostics useful but redacted", async () => {
    const result = await dispatchCourierProviderAwb(awbRequest(), readyDependencies);
    const ndrPreview = await previewCourierProviderNdrAction(ndrRequest(), readyDependencies);
    const serialized = serializeAdminCourierProviderWorkflowDispatch(result);
    const ndrSerialized = serializeAdminCourierProviderWorkflowDispatch(ndrPreview);
    const json = JSON.stringify(serialized);
    const ndrJson = JSON.stringify(ndrSerialized);

    assert.equal(serialized.admin_diagnostics.provider_code, "XPRESSBEES");
    assert.equal(serialized.admin_diagnostics.credential_reference_configured, true);
    assert.ok(serialized.admin_diagnostics.blockers.includes("OFFICIAL_DOCS_REQUIRED"));
    assert.doesNotMatch(json, /credential-vault:|secret|token|password|Authorization|Bearer|rawHeaders|rawResponse/i);
    assert.equal((ndrSerialized.contract_data as Record<string, unknown>).provider_mutation_enabled, false);
    assert.doesNotMatch(ndrJson, /safe-awb-placeholder|Authorization|Bearer|rawHeaders|rawResponse|password|secret|token/i);
  });

  it("does not call HTTP while dispatching blocked provider workflows", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("HTTP_SHOULD_NOT_BE_CALLED");
    }) as typeof fetch;

    try {
      const rate = await dispatchCourierProviderRate(rateRequest(), readyDependencies);
      const preview = await previewCourierProviderNdrAction(ndrRequest(), readyDependencies);
      const codRead = await readCourierProviderCodRemittance(codReadRequest(), readyDependencies);
      assert.equal(rate.status, "BLOCKED");
      assert.equal(preview.status, "DISPATCHED");
      assert.equal(codRead.status, "DISPATCHED");
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
