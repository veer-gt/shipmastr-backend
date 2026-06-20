import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  checkCourierProviderCapability,
  checkCourierProviderLiveWorkflowAllowed,
  getCourierProviderLane,
  getCourierProviderLaneCredentialReadiness,
  getCourierProviderLaneReadinessDiagnostic,
  listCourierProviderLanes,
  mapCourierProviderRawStatus
} from "../courier-provider-registry.service.js";
import {
  serializeAdminCourierProviderLaneReadinessDiagnostic,
  serializeAdminCourierProviderLane,
  serializeSellerSafeProviderAvailability
} from "../courier-provider-registry.serializer.js";
import { courierProviderLaneCodes } from "../courier-provider-registry.types.js";

const checkedAt = "2026-06-20T00:00:00.000Z";

function fakeCredentialClient(record: Record<string, unknown> | null) {
  return {
    courierProviderCredential: {
      findFirst: async () => record
    }
  } as never;
}

function readyCredentialReadiness(mode: "LIVE" | "SANDBOX" = "LIVE") {
  return {
    status: "READY" as const,
    credential_ref_configured: true,
    env_ref_configured: false,
    secret_manager_ref_configured: false,
    reference: {
      configured: true,
      ref_type: "CREDENTIAL_REF" as const,
      display_label: "Credential vault reference configured",
      credential_ref_configured: true,
      env_ref_configured: false,
      secret_manager_ref_configured: false
    },
    mode,
    last_test_status: "PASS",
    checked_at: checkedAt,
    blockers: []
  };
}

describe("courier provider registry foundation", () => {
  it("models the required provider lanes internally", () => {
    const { lanes } = listCourierProviderLanes();
    const codes = lanes.map((lane) => lane.code).sort();

    assert.deepEqual(codes, [...courierProviderLaneCodes].sort());
    assert.equal(getCourierProviderLane("DELHIVERY_B2C_AIR").lane.providerCode, "DELHIVERY");
    assert.equal(getCourierProviderLane("XPRESSBEES_SURFACE").lane.transportMode, "SURFACE");
    assert.equal(getCourierProviderLane("BIGSHIP").lane.laneType, "AGGREGATOR");
    assert.equal(getCourierProviderLane("SHIPROCKET").lane.laneType, "AGGREGATOR");
  });

  it("keeps provider lane details admin/internal and still lists public Shipmastr outcomes", () => {
    const serialized = serializeAdminCourierProviderLane(getCourierProviderLane("DELHIVERY_B2C_AIR").lane);

    assert.equal(serialized.provider_code, "DELHIVERY");
    assert.equal(serialized.base_url_ref, "COURIER_BASE_URL_DELHIVERY");
    assert.ok(serialized.public_outcomes.includes("Shipmastr Smart"));
    assert.ok(serialized.public_outcomes.includes("Shipmastr Autopilot"));
    assert.equal(serialized.public_network_name, "Shipmastr Courier Network");
  });

  it("returns guarded unsupported capability results", () => {
    const result = checkCourierProviderCapability("SHADOWFAX", "WEIGHT_DISPUTE");

    assert.equal(result.supported, false);
    assert.deepEqual(result.blockers, ["COURIER_PROVIDER_CAPABILITY_UNSUPPORTED"]);
    assert.equal(result.public_network_name, "Shipmastr Courier Network");
  });

  it("blocks live workflow when credential readiness is false", async () => {
    const result = await checkCourierProviderLiveWorkflowAllowed({
      merchantId: "merchant_1",
      laneCode: "DELHIVERY_B2C_AIR",
      capability: "RATE",
      mode: "LIVE"
    }, {
      checkedAt,
      credentialReadinessProvider: async () => ({
        status: "NOT_CONFIGURED",
        credential_ref_configured: false,
        env_ref_configured: false,
        secret_manager_ref_configured: false,
        reference: {
          configured: false,
          ref_type: "NONE",
          display_label: "Not configured",
          credential_ref_configured: false,
          env_ref_configured: false,
          secret_manager_ref_configured: false
        },
        mode: "LIVE",
        last_test_status: null,
        checked_at: checkedAt,
        blockers: ["COURIER_PROVIDER_CREDENTIALS_NOT_CONFIGURED"]
      })
    });

    assert.equal(result.allowed, false);
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.includes("COURIER_PROVIDER_CREDENTIALS_NOT_READY"));
    assert.ok(result.blockers.includes("COURIER_PROVIDER_CREDENTIALS_NOT_CONFIGURED"));
  });

  it("allows live workflow guard only when status, capability, and credential readiness pass", async () => {
    const result = await checkCourierProviderLiveWorkflowAllowed({
      merchantId: "merchant_1",
      laneCode: "SHIPROCKET",
      capability: "RATE",
      mode: "LIVE"
    }, {
      checkedAt,
      credentialReadinessProvider: async () => readyCredentialReadiness("LIVE")
    });

    assert.equal(result.allowed, true);
    assert.equal(result.status, "ALLOWED");
    assert.deepEqual(result.blockers, []);
    assert.equal(result.public_network_name, "Shipmastr Courier Network");
  });

  it("keeps testing lanes blocked for live mode even when credentials are ready", async () => {
    const result = await checkCourierProviderLiveWorkflowAllowed({
      merchantId: "merchant_1",
      laneCode: "DELHIVERY_B2C_SURFACE",
      capability: "RATE",
      mode: "LIVE"
    }, {
      checkedAt,
      credentialReadinessProvider: async () => readyCredentialReadiness("LIVE")
    });

    assert.equal(result.allowed, false);
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.includes("COURIER_PROVIDER_LANE_TESTING_ONLY"));
  });

  it("blocks suspended lanes even when credential readiness is ready", async () => {
    const result = await checkCourierProviderLiveWorkflowAllowed({
      merchantId: "merchant_1",
      laneCode: "EKART",
      capability: "RATE",
      mode: "LIVE"
    }, {
      checkedAt,
      credentialReadinessProvider: async () => readyCredentialReadiness("LIVE")
    });

    assert.equal(result.allowed, false);
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.includes("COURIER_PROVIDER_LANE_SUSPENDED"));
  });

  it("does not make real provider calls during guard checks", async () => {
    let credentialChecks = 0;
    const result = await checkCourierProviderLiveWorkflowAllowed({
      merchantId: "merchant_1",
      laneCode: "BIGSHIP",
      capability: "AWB",
      mode: "LIVE"
    }, {
      checkedAt,
      credentialReadinessProvider: async () => {
        credentialChecks += 1;
        return readyCredentialReadiness("LIVE");
      }
    });

    assert.equal(credentialChecks, 1);
    assert.equal(result.allowed, true);
    assert.match(result.warnings.join(" "), /does not perform real courier\/provider calls/i);
  });

  it("reports missing credential references as safe blockers", async () => {
    const lane = getCourierProviderLane("DELHIVERY_B2C_AIR").lane;
    const readiness = await getCourierProviderLaneCredentialReadiness(
      "merchant_1",
      lane,
      fakeCredentialClient(null),
      { checkedAt },
      "LIVE"
    );

    assert.equal(readiness.status, "NOT_CONFIGURED");
    assert.equal(readiness.reference.configured, false);
    assert.equal(readiness.reference.ref_type, "NONE");
    assert.ok(readiness.blockers.includes("COURIER_PROVIDER_CREDENTIAL_REFS_MISSING"));
  });

  it("classifies environment references without exposing the ref value", async () => {
    const lane = getCourierProviderLane("XPRESSBEES_AIR").lane;
    const readiness = await getCourierProviderLaneCredentialReadiness(
      "merchant_1",
      lane,
      fakeCredentialClient({
        credentialRef: "env:XPRESSBEES_PRIVATE_VALUE",
        status: "DRAFT",
        mode: "SANDBOX",
        lastTestStatus: null,
        lastTestedAt: null,
        updatedAt: new Date(checkedAt)
      }),
      { checkedAt },
      "SANDBOX"
    );
    const json = JSON.stringify(readiness);

    assert.equal(readiness.status, "REFERENCE_CONFIGURED");
    assert.equal(readiness.reference.ref_type, "ENV_REF");
    assert.equal(readiness.env_ref_configured, true);
    assert.deepEqual(readiness.blockers, []);
    assert.doesNotMatch(json, /XPRESSBEES_PRIVATE_VALUE|env:/i);
  });

  it("blocks live readiness until secret-manager refs pass checks", async () => {
    const lane = getCourierProviderLane("SHIPROCKET").lane;
    const readiness = await getCourierProviderLaneCredentialReadiness(
      "merchant_1",
      lane,
      fakeCredentialClient({
        credentialRef: "secret-manager:projects/shipmastr/secrets/shiprocket-token",
        status: "ACTIVE",
        mode: "LIVE",
        lastTestStatus: "PENDING",
        lastTestedAt: null,
        updatedAt: new Date(checkedAt)
      }),
      { checkedAt },
      "LIVE"
    );
    const json = JSON.stringify(readiness);

    assert.equal(readiness.status, "REFERENCE_CONFIGURED");
    assert.equal(readiness.reference.ref_type, "SECRET_MANAGER_REF");
    assert.equal(readiness.secret_manager_ref_configured, true);
    assert.ok(readiness.blockers.includes("COURIER_PROVIDER_CREDENTIALS_NOT_READY"));
    assert.doesNotMatch(json, /projects\/shipmastr|shiprocket-token|secret-manager:/i);
  });

  it("returns safe admin readiness diagnostics with a capability matrix", async () => {
    const diagnostic = await getCourierProviderLaneReadinessDiagnostic({
      merchantId: "merchant_1",
      laneCode: "BIGSHIP",
      capability: "AWB",
      mode: "LIVE"
    }, { checkedAt }, fakeCredentialClient({
      credentialRef: "credential-vault:provider/bigship/live",
      status: "ACTIVE",
      mode: "LIVE",
      lastTestStatus: "PASS",
      lastTestedAt: new Date(checkedAt),
      updatedAt: new Date(checkedAt)
    }));
    const serialized = serializeAdminCourierProviderLaneReadinessDiagnostic(diagnostic);
    const json = JSON.stringify(serialized);

    assert.equal(serialized.status, "READY");
    assert.equal(serialized.credential_readiness.reference.configured, true);
    assert.equal(serialized.capability_matrix.length, 1);
    const [capability] = serialized.capability_matrix;
    assert.ok(capability);
    assert.equal(capability.capability, "AWB");
    assert.equal(capability.status, "READY");
    assert.doesNotMatch(json, /credential-vault:provider|token|password|authorization|Bearer/i);
  });

  it("normalizes raw provider statuses into Shipmastr-safe statuses", () => {
    assert.equal(mapCourierProviderRawStatus("shipment delivered"), "DELIVERED");
    assert.equal(mapCourierProviderRawStatus("Out For Delivery"), "OUT_FOR_DELIVERY");
    assert.equal(mapCourierProviderRawStatus("NDR raised - consignee unavailable"), "NDR_ACTION_REQUIRED");
    assert.equal(mapCourierProviderRawStatus("RTO Initiated"), "RTO_INITIATED");
    assert.equal(mapCourierProviderRawStatus("damaged in transit"), "LOST_OR_DAMAGED");
    assert.equal(mapCourierProviderRawStatus("unexpected status from provider"), "EXCEPTION");
  });

  it("keeps seller-safe serialization provider-neutral and free of credential values", () => {
    const sellerSafe = serializeSellerSafeProviderAvailability({
      credentialReadiness: "NOT_CONFIGURED",
      blocked: true
    });
    const json = JSON.stringify(sellerSafe);

    assert.equal(sellerSafe.public_network_name, "Shipmastr Courier Network");
    assert.match(json, /Shipmastr Smart/);
    assert.doesNotMatch(json, /Delhivery|Xpressbees|Shadowfax|Ekart|Bigship|Shiprocket/i);
    assert.doesNotMatch(json, /secret|token|password|credential|api[_-]?key|Bearer/i);
  });

  it("mounts provider lanes only under admin middleware", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");

    assert.match(routes, /adminCourierProviderRegistryRouter/);
    assert.match(routes, /apiRouter\.use\("\/admin\/courier-provider-lanes", requireAdminJwt, adminCourierProviderRegistryRouter\);/);
    assert.doesNotMatch(routes, /apiRouter\.use\("\/courier-provider-lanes"/);
    assert.doesNotMatch(routes, /apiRouter\.use\("\/shipping\/courier-provider-lanes"/);
  });
});
