import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { serializeCourierAwbCertificationAdmin, serializeCourierAwbCertificationSellerSafe } from "../courier-awb-certification.serializer.js";
import { runCourierAwbCertificationDryRun } from "../courier-awb-certification.service.js";

const now = new Date("2026-06-13T10:00:00.000Z");

function liveReadiness(overrides: Record<string, unknown> = {}) {
  return {
    status: "BLOCKED",
    ready: false,
    runtime: { enabled: true, mode: "LIVE", pilotOnly: true },
    pilot: {
      merchantId: "merchant_1",
      allowlisted: true,
      liveRatesCapabilityEnabled: true,
      awbLabelCapabilityEnabled: true
    },
    providerReadiness: {
      hasActiveProvider: true,
      activeProviderCount: 1
    },
    shiprocket: {
      oneShotEnabled: true,
      oneShotApprovalPresent: false,
      allowedMerchantMatched: true,
      allowedShipmentMatched: true,
      credentialId: "credential_1",
      credentialRefConfigured: true,
      credentialResolved: true
    },
    blockers: ["LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED"],
    warnings: [],
    message: "safe",
    ...overrides
  } as any;
}

function certification(overrides: Record<string, unknown> = {}) {
  return {
    provider_key: "SHIPROCKET",
    provider_label_internal: "Shiprocket",
    public_network_name: "Shipmastr Courier Network",
    status: "READY_FOR_PILOT",
    live_ready: false,
    can_use_for_rates: true,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [
      { key: "CREDENTIALS", status: "PASS", blockers: [], warnings: [], safe_summary: {} },
      { key: "PUBLIC_SAFETY", status: "PASS", blockers: [], warnings: [], safe_summary: {} },
      { key: "AWB", status: "WARN", blockers: ["PROVIDER_AWB_NOT_CERTIFIED"], warnings: [], safe_summary: { sandbox_status: "AVAILABLE" } }
    ],
    blockers: ["PROVIDER_AWB_NOT_CERTIFIED"],
    warnings: [],
    next_actions: [],
    checked_at: now.toISOString(),
    ...overrides
  } as any;
}

function pickupServiceability(overrides: Record<string, unknown> = {}) {
  return {
    provider_key: "SHIPROCKET",
    public_network_name: "Shipmastr Courier Network",
    shipment_id: "shipment_1",
    pickup_location_id: "pickup_1",
    status: "PICKUP_AVAILABLE",
    latest_rate_context: {
      live_mode: true,
      live_ready: true,
      candidate_count: 1,
      eligible_count: 1,
      pickup_available_count: 1,
      delivery_available_count: 1,
      numeric_courier_id_count: 1
    },
    blockers: [],
    warnings: [],
    next_actions: [],
    seller_safe_message: "safe",
    recommended_action: "KEEP_SELECTED",
    ...overrides
  } as any;
}

function fakeClient(input: {
  shipment?: Record<string, unknown>;
  pickup?: Record<string, unknown> | null;
  rate?: Record<string, unknown> | null;
} = {}) {
  const state = {
    shipment: {
      id: "shipment_1",
      sellerId: "merchant_1",
      pickupLocationId: "pickup_1",
      fromPincode: "201301",
      toPincode: "400001",
      awbNumber: null,
      deadWeightKg: 1,
      lengthCm: 10,
      breadthCm: 10,
      heightCm: 10,
      declaredValuePaise: 10000,
      metadata: { invoice: { invoice_amount: 100 } },
      status: "draft",
      createdAt: now,
      updatedAt: now,
      ...input.shipment
    },
    pickup: input.pickup === null ? null : {
      id: "pickup_1",
      sellerId: "merchant_1",
      status: "active",
      pincode: "201301",
      createdAt: now,
      ...input.pickup
    },
    rate: input.rate === null ? null : {
      id: "rate_1",
      sellerId: "merchant_1",
      shipmentId: "shipment_1",
      publicServiceCode: "shipmastr_smart",
      publicServiceName: "Shipmastr Smart",
      amountPaise: 10000,
      rateBreakup: {
        phase6: {
          livePilotRatesMode: "LIVE",
          livePilotRatesReady: true,
          pickupAvailable: true,
          providerCourierId: "123456"
        }
      },
      createdAt: now,
      ...input.rate
    }
  };
  const calls = {
    shipmentUpdate: 0,
    providerRefCreate: 0,
    providerRefUpdate: 0
  };
  const client = {
    shipment: {
      findFirst: async ({ where }: any) => where.id === state.shipment.id && where.sellerId === state.shipment.sellerId ? state.shipment : null,
      update: async () => {
        calls.shipmentUpdate += 1;
        throw new Error("MUTATION_NOT_ALLOWED");
      }
    },
    pickupLocation: {
      findFirst: async ({ where }: any) => state.pickup && where.id === state.pickup.id && where.sellerId === state.pickup.sellerId ? state.pickup : null
    },
    shipmentRate: {
      findMany: async () => state.rate ? [state.rate] : []
    },
    shipmentProviderRef: {
      create: async () => {
        calls.providerRefCreate += 1;
        throw new Error("MUTATION_NOT_ALLOWED");
      },
      update: async () => {
        calls.providerRefUpdate += 1;
        throw new Error("MUTATION_NOT_ALLOWED");
      }
    }
  } as any;
  return { state, calls, client };
}

async function dryRun(input: {
  client?: any;
  live?: any;
  cert?: any;
  pickup?: any;
} = {}) {
  const fake = input.client ? { client: input.client, state: null, calls: null } : fakeClient();
  const result = await runCourierAwbCertificationDryRun("merchant_1", "SHIPROCKET", {
    shipmentId: "shipment_1",
    requestedTier: "smart"
  }, {
    client: fake.client,
    liveReadinessProvider: async () => input.live ?? liveReadiness(),
    certificationProvider: async () => input.cert ?? certification(),
    pickupServiceabilityProvider: async () => input.pickup ?? pickupServiceability()
  });
  return { result, fake };
}

describe("courier AWB certification sandbox", () => {
  it("blocks AWB when pickup is unavailable and does not report courier id missing when a numeric id exists", async () => {
    const { result } = await dryRun({
      pickup: pickupServiceability({
        status: "PICKUP_UNAVAILABLE",
        latest_rate_context: {
          live_mode: true,
          live_ready: true,
          candidate_count: 1,
          eligible_count: 0,
          pickup_available_count: 0,
          delivery_available_count: 1,
          numeric_courier_id_count: 1
        },
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"]
      })
    });
    assert.equal(result.dry_run_ready, false);
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_PICKUP_UNAVAILABLE"));
    assert.equal(result.blockers.includes("AWB_CERTIFICATION_COURIER_ID_MISSING"), false);
  });

  it("blocks with courier id missing when selected rate lacks numeric provider courier mapping", async () => {
    const fake = fakeClient({
      rate: {
        rateBreakup: {
          phase6: {
            livePilotRatesMode: "LIVE",
            livePilotRatesReady: true,
            pickupAvailable: true
          }
        }
      }
    });
    const { result } = await dryRun({ client: fake.client });
    assert.equal(result.dry_run_ready, false);
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_COURIER_ID_MISSING"));
  });

  it("blocks existing AWB and never writes AWB, label, or provider refs", async () => {
    const fake = fakeClient({ shipment: { awbNumber: "SM123" } });
    const { result } = await dryRun({ client: fake.client });
    assert.equal(result.status, "ALREADY_HAS_AWB");
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_EXISTING_AWB"));
    assert.equal(fake.state.shipment.awbNumber, "SM123");
    assert.deepEqual(fake.calls, { shipmentUpdate: 0, providerRefCreate: 0, providerRefUpdate: 0 });
  });

  it("returns dry-run ready when payload is ready but one-shot approval is missing", async () => {
    const { result } = await dryRun();
    assert.equal(result.dry_run_ready, true);
    assert.equal(result.live_one_shot_ready, false);
    assert.equal(result.status, "DRY_RUN_ONLY");
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"));
  });

  it("returns one-shot ready when all existing gates are satisfied but still does not create AWB", async () => {
    const fake = fakeClient();
    const { result } = await dryRun({
      client: fake.client,
      live: liveReadiness({
        status: "READY",
        ready: true,
        shiprocket: {
          oneShotEnabled: true,
          oneShotApprovalPresent: true,
          allowedMerchantMatched: true,
          allowedShipmentMatched: true,
          credentialId: "credential_1",
          credentialRefConfigured: true,
          credentialResolved: true
        },
        blockers: []
      })
    });
    assert.equal(result.dry_run_ready, true);
    assert.equal(result.live_one_shot_ready, true);
    assert.equal(result.status, "READY_FOR_ONE_SHOT");
    assert.equal(fake.state.shipment.awbNumber, null);
    assert.deepEqual(fake.calls, { shipmentUpdate: 0, providerRefCreate: 0, providerRefUpdate: 0 });
  });

  it("seller-safe output hides provider names, ids, secrets, and raw fields", async () => {
    const { result } = await dryRun({
      pickup: pickupServiceability({
        status: "PICKUP_UNAVAILABLE",
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"],
        warnings: ["Shiprocket rawPayload Authorization Bearer secret"]
      })
    });
    const sellerSafe = serializeCourierAwbCertificationSellerSafe(result);
    const adminSafe = serializeCourierAwbCertificationAdmin(result);
    assert.doesNotMatch(JSON.stringify(sellerSafe), /Shiprocket|SHIPROCKET|Bigship|BIGSHIP|Shipmozo|SHIPMOZO|123456|providerCourierId|providerPickupId|rawPayload|rawHeaders|Authorization|Bearer|token|secret/i);
    assert.match(JSON.stringify(adminSafe), /SHIPROCKET|AWB_CERTIFICATION_PICKUP_UNAVAILABLE/);
  });

  it("route and service remain dry-run only without Ship Now, label, or provider mutation paths", () => {
    const routes = readFileSync("src/modules/courierPartners/awbCertification/courier-awb-certification.routes.ts", "utf8");
    const service = readFileSync("src/modules/courierPartners/awbCertification/courier-awb-certification.service.ts", "utf8");
    assert.match(routes, /post\("\/awb-certification\/providers\/:providerKey\/shipments\/:shipmentId\/dry-run"/);
    assert.doesNotMatch(`${routes}\n${service}`, /shipNowShipment|manifestShipment|createLabel|getLabel|assignAwb|createDraftOrder|ShipmentProviderRef\.create|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
