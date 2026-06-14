import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  serializeCourierAwbCertificationAdmin,
  serializeCourierAwbCertificationLiveOneShot,
  serializeCourierAwbCertificationSellerSafe
} from "../courier-awb-certification.serializer.js";
import {
  runCourierAwbCertificationDryRun,
  runCourierAwbCertificationLiveOneShot
} from "../courier-awb-certification.service.js";

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

function liveReady(overrides: Record<string, unknown> = {}) {
  return liveReadiness({
    status: "READY",
    ready: true,
    shiprocket: {
      oneShotEnabled: true,
      oneShotApprovalPresent: true,
      allowedMerchantMatched: true,
      allowedShipmentMatched: true,
      credentialId: "credential_1",
      credentialRef: "vault://credential_1",
      credentialRefConfigured: true,
      credentialResolved: true
    },
    blockers: [],
    warnings: [],
    ...overrides
  });
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
  providerRef?: Record<string, unknown> | null;
  allowMutations?: boolean;
} = {}) {
  const state = {
    shipment: {
      id: "shipment_1",
      sellerId: "merchant_1",
      pickupLocationId: "pickup_1",
      externalOrderId: "order_1",
      fromPincode: "201301",
      toPincode: "400001",
      awbNumber: null,
      trackingUrl: null,
      serviceLevel: null,
      segment: "domestic_b2c",
      paymentMode: "prepaid",
      deadWeightKg: 1,
      lengthCm: 10,
      breadthCm: 10,
      heightCm: 10,
      declaredValuePaise: 10000,
      metadata: {
        invoice: { invoice_amount: 100, collectable_amount: null, invoice_number: "INV-1" },
        buyer: {
          name: "Buyer",
          phone: "9999999999",
          email: "buyer@example.test",
          address: {
            line1: "Line 1",
            city: "Mumbai",
            state: "Maharashtra",
            country: "IN",
            pincode: "400001"
          }
        },
        boxes: [{
          products: [{ name: "Product", sku: "SKU-1", quantity: 1, unit_price: 100 }]
        }]
      },
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
      courierPartnerId: "courier_partner_1",
      sellerCourierPartnerId: "seller_courier_partner_1",
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
    },
    providerRef: input.providerRef === null ? null : input.providerRef ? {
      id: "provider_ref_1",
      shipmentId: "shipment_1",
      courierPartnerId: "courier_partner_1",
      createdAt: now,
      updatedAt: now,
      metadata: {},
      ...input.providerRef
    } : null,
    pickupMapping: {
      id: "pickup_mapping_1",
      pickupLocationId: "pickup_1",
      courierPartnerId: "courier_partner_1",
      providerPickupId: "pickup_provider_1",
      createdAt: now,
      updatedAt: now
    }
  } as any;
  const calls = {
    shipmentUpdate: 0,
    providerRefCreate: 0,
    providerRefUpdate: 0
  };
  const client = {
    shipment: {
      findFirst: async ({ where }: any) => where.id === state.shipment.id && where.sellerId === state.shipment.sellerId ? state.shipment : null,
      update: async ({ where, data }: any) => {
        calls.shipmentUpdate += 1;
        if (!input.allowMutations) throw new Error("MUTATION_NOT_ALLOWED");
        assert.equal(where.id, state.shipment.id);
        Object.assign(state.shipment, data, { updatedAt: now });
        return state.shipment;
      }
    },
    pickupLocation: {
      findFirst: async ({ where }: any) => state.pickup && where.id === state.pickup.id && where.sellerId === state.pickup.sellerId ? state.pickup : null
    },
    shipmentRate: {
      findMany: async () => state.rate ? [state.rate] : []
    },
    pickupLocationProviderMapping: {
      findUnique: async ({ where }: any) => {
        const unique = where.pickupLocationId_courierPartnerId;
        return unique.pickupLocationId === state.pickupMapping.pickupLocationId
          && unique.courierPartnerId === state.pickupMapping.courierPartnerId
          ? state.pickupMapping
          : null;
      }
    },
    shipmentProviderRef: {
      findFirst: async ({ where }: any) => state.providerRef
        && state.providerRef.shipmentId === where.shipmentId
        && (where.courierPartnerId === undefined || state.providerRef.courierPartnerId === where.courierPartnerId)
        ? state.providerRef
        : null,
      create: async ({ data }: any) => {
        calls.providerRefCreate += 1;
        if (!input.allowMutations) throw new Error("MUTATION_NOT_ALLOWED");
        state.providerRef = {
          id: "provider_ref_created",
          shipmentId: state.shipment.id,
          courierPartnerId: state.rate?.courierPartnerId ?? null,
          createdAt: now,
          updatedAt: now,
          metadata: {}
        } as any;
        Object.assign(state.providerRef, data);
        return state.providerRef;
      },
      update: async ({ where, data }: any) => {
        calls.providerRefUpdate += 1;
        if (!input.allowMutations) throw new Error("MUTATION_NOT_ALLOWED");
        assert.ok(state.providerRef);
        assert.equal(where.id, state.providerRef.id);
        Object.assign(state.providerRef, data, { updatedAt: now });
        return state.providerRef;
      }
    }
  } as any;
  return { state, calls, client };
}

function fakeAdapter(input: { manifestFails?: boolean; invalidAwb?: boolean } = {}) {
  const calls = {
    createDraftOrder: 0,
    manifestOrder: 0,
    getLabel: 0,
    trackOrder: 0
  };
  return {
    calls,
    adapter: {
      code: "shiprocket",
      login: async () => ({ token: "test", expiresAt: now }),
      ensureToken: async () => ({ token: "test", expiresAt: now }),
      createPickupLocation: async () => {
        throw new Error("NOT_USED");
      },
      createDraftOrder: async () => {
        calls.createDraftOrder += 1;
        return {
          providerOrderId: "987654321",
          providerReferenceNumber: "ref_1",
          status: "draft",
          message: "safe",
          providerMetadata: { stored: false }
        };
      },
      getRates: async () => {
        throw new Error("NOT_USED");
      },
      manifestOrder: async () => {
        calls.manifestOrder += 1;
        if (input.manifestFails) throw Object.assign(new Error("provider failed"), { code: "PROVIDER_FAILED" });
        return {
          awb: input.invalidAwb ? "" : "190123456789",
          trackingNumber: "190123456789",
          status: "manifested",
          providerReferenceNumber: "manifest_1",
          providerAwb: "190123456789",
          labelUrl: null,
          trackingUrl: null,
          message: "safe",
          providerMetadata: { stored: false }
        };
      },
      getLabel: async () => {
        calls.getLabel += 1;
        throw new Error("LABEL_NOT_ALLOWED");
      },
      trackOrder: async () => {
        calls.trackOrder += 1;
        throw new Error("TRACKING_NOT_ALLOWED");
      },
      cancelOrder: async () => ({ cancelled: true, status: "cancelled", message: "safe", providerMetadata: {} })
    } as any
  };
}

async function liveOneShot(input: {
  client?: any;
  live?: any;
  cert?: any;
  pickup?: any;
  adapter?: any;
} = {}) {
  const fake = input.client ? { client: input.client, state: null, calls: null } : fakeClient({ allowMutations: true });
  const provider = input.adapter ?? fakeAdapter();
  const result = await runCourierAwbCertificationLiveOneShot("merchant_1", "SHIPROCKET", {
    shipmentId: "shipment_1",
    pickupLocationId: "pickup_1",
    requestedTier: "smart",
    operatorNote: "Pilot Run 6H live AWB certification"
  }, {
    client: fake.client,
    adapter: provider.adapter,
    liveReadinessProvider: async () => input.live ?? liveReady(),
    certificationProvider: async () => input.cert ?? certification(),
    pickupServiceabilityProvider: async () => input.pickup ?? pickupServiceability()
  });
  return { result, fake, provider };
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

  it("live one-shot blocks without approval and does not call the provider", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      client: fake.client,
      adapter: provider,
      live: liveReadiness()
    });
    assert.equal(result.success, false);
    assert.equal(result.public_awb_status, "BLOCKED");
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"));
    assert.deepEqual(provider.calls, { createDraftOrder: 0, manifestOrder: 0, getLabel: 0, trackOrder: 0 });
    assert.equal(fake.state.shipment.awbNumber, null);
  });

  it("live one-shot blocks when the allowed shipment does not match", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      client: fake.client,
      adapter: provider,
      live: liveReady({
        ready: false,
        shiprocket: {
          oneShotEnabled: true,
          oneShotApprovalPresent: true,
          allowedMerchantMatched: true,
          allowedShipmentMatched: false,
          credentialId: "credential_1",
          credentialRef: "vault://credential_1",
          credentialRefConfigured: true,
          credentialResolved: true
        },
        blockers: ["LIVE_SHIPROCKET_ALLOWED_SHIPMENT_MISMATCH"]
      })
    });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_ALLOWED_SHIPMENT_MISMATCH"));
    assert.deepEqual(provider.calls, { createDraftOrder: 0, manifestOrder: 0, getLabel: 0, trackOrder: 0 });
  });

  it("live one-shot blocks when pickup is unavailable", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({
      client: fake.client,
      adapter: provider,
      pickup: pickupServiceability({
        status: "PICKUP_UNAVAILABLE",
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"]
      })
    });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_PICKUP_UNAVAILABLE"));
    assert.deepEqual(provider.calls, { createDraftOrder: 0, manifestOrder: 0, getLabel: 0, trackOrder: 0 });
  });

  it("live one-shot blocks when the selected rate has no numeric courier id", async () => {
    const fake = fakeClient({
      allowMutations: true,
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
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_COURIER_ID_MISSING"));
    assert.deepEqual(provider.calls, { createDraftOrder: 0, manifestOrder: 0, getLabel: 0, trackOrder: 0 });
  });

  it("live one-shot blocks when AWB already exists", async () => {
    const fake = fakeClient({ allowMutations: true, shipment: { awbNumber: "SM123" } });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, false);
    assert.equal(result.public_awb_status, "ALREADY_EXISTS");
    assert.equal(result.certification_status, "ALREADY_CERTIFIED");
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_EXISTING_AWB"));
    assert.deepEqual(provider.calls, { createDraftOrder: 0, manifestOrder: 0, getLabel: 0, trackOrder: 0 });
  });

  it("live one-shot success stores internal provider refs and Shipmastr AWB without label or tracking certification", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter();
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, true);
    assert.equal(result.public_awb_status, "CREATED");
    assert.equal(result.certification_status, "AWB_CERTIFIED");
    assert.equal(result.label_ready, false);
    assert.equal(result.tracking_ready, false);
    assert.match(result.shipmastr_awb_number ?? "", /^SM/);
    assert.equal(fake.state.shipment.awbNumber, result.shipmastr_awb_number);
    assert.equal(fake.state.shipment.status, "manifested");
    assert.equal((fake.state.shipment.metadata as any).phase42p.awbCertified, true);
    assert.equal((fake.state.shipment.metadata as any).phase42p.labelCertified, false);
    assert.equal((fake.state.shipment.metadata as any).phase42p.trackingCertified, false);
    assert.equal(fake.state.providerRef?.providerOrderId, "987654321");
    assert.equal(fake.state.providerRef?.providerAwb, "190123456789");
    assert.deepEqual(provider.calls, { createDraftOrder: 1, manifestOrder: 1, getLabel: 0, trackOrder: 0 });
  });

  it("provider failure does not store a public AWB", async () => {
    const fake = fakeClient({ allowMutations: true });
    const provider = fakeAdapter({ manifestFails: true });
    const { result } = await liveOneShot({ client: fake.client, adapter: provider });
    assert.equal(result.success, false);
    assert.ok(result.blockers.includes("AWB_CERTIFICATION_PROVIDER_CALL_FAILED"));
    assert.equal(fake.state.shipment.awbNumber, null);
    assert.equal(fake.state.shipment.status, "draft");
    assert.deepEqual(provider.calls, { createDraftOrder: 1, manifestOrder: 1, getLabel: 0, trackOrder: 0 });
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

  it("live one-shot serializer hides provider names, ids, secrets, and raw fields", async () => {
    const { result } = await liveOneShot();
    const serialized = serializeCourierAwbCertificationLiveOneShot({
      ...result,
      warnings: ["Shiprocket providerCourierId rawPayload Authorization Bearer secret"]
    });
    assert.equal(serialized.provider_key, "SHIPROCKET");
    const sellerSafe = JSON.stringify(serialized.seller_safe);
    assert.doesNotMatch(sellerSafe, /Shiprocket|SHIPROCKET|Bigship|Shipmozo|providerCourierId|providerPickupId|rawPayload|rawHeaders|Authorization|Bearer|token|secret|987654321|190123456789/i);
    assert.match(sellerSafe, /Shipmastr Courier Network/);
  });

  it("routes expose live one-shot behind admin and approval header while dry-run remains non-mutating", () => {
    const routes = readFileSync("src/modules/courierPartners/awbCertification/courier-awb-certification.routes.ts", "utf8");
    assert.match(routes, /post\("\/awb-certification\/providers\/:providerKey\/shipments\/:shipmentId\/dry-run"/);
    assert.match(routes, /post\("\/awb-certification\/providers\/:providerKey\/shipments\/:shipmentId\/live-one-shot"/);
    assert.match(routes, /requireInternalAdminRole/);
    assert.match(routes, /x-shipmastr-live-awb-approval/);
    assert.doesNotMatch(routes, /shipNowShipment|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
