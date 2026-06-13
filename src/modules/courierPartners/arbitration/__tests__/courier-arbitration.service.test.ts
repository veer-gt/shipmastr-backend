import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { arbitrateCourierPickup } from "../courier-arbitration.service.js";
import {
  serializeCourierArbitrationAdmin,
  serializeCourierArbitrationSellerSafe
} from "../courier-arbitration.serializer.js";
import type { CourierCertificationSnapshot } from "../../certification/courier-certification.types.js";
import type { CourierLiveProviderKey } from "../../liveReadiness/courier-live-readiness.types.js";

const now = new Date("2026-06-12T10:00:00.000Z");

function dimension(key: string, status = "PASS", blockers: string[] = []) {
  return {
    key,
    status,
    blockers,
    warnings: [],
    safe_summary: {}
  } as CourierCertificationSnapshot["dimensions"][number];
}

function snapshot(providerKey: CourierLiveProviderKey, overrides: Partial<CourierCertificationSnapshot> = {}): CourierCertificationSnapshot {
  const dryRun = providerKey !== "SHIPROCKET";
  return {
    provider_key: providerKey,
    provider_label_internal: providerKey,
    public_network_name: "Shipmastr Courier Network",
    status: dryRun ? "READY_FOR_DRY_RUN" : "BLOCKED",
    live_ready: false,
    can_use_for_rates: false,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [
      dimension("CREDENTIALS"),
      dimension("PICKUPS"),
      dimension("SERVICEABILITY"),
      dimension("RATES"),
      dimension("COURIER_ID_MAPPING"),
      dimension("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
      dimension("LABEL", "WARN", ["PROVIDER_LABEL_NOT_CERTIFIED"]),
      dimension("TRACKING", "NOT_RUN", ["PROVIDER_TRACKING_NOT_CERTIFIED"]),
      dimension("PUBLIC_SAFETY")
    ],
    blockers: dryRun ? ["PROVIDER_DRY_RUN_ONLY"] : ["PROVIDER_PICKUP_UNAVAILABLE", "PROVIDER_AWB_NOT_CERTIFIED"],
    warnings: [],
    next_actions: ["Review courier certification blockers."],
    checked_at: now.toISOString(),
    ...overrides
  };
}

function shiprocketBlocked() {
  return snapshot("SHIPROCKET", {
    status: "BLOCKED",
    can_use_for_rates: true,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    blockers: ["PROVIDER_PICKUP_UNAVAILABLE", "PROVIDER_AWB_NOT_CERTIFIED"],
    dimensions: [
      dimension("CREDENTIALS"),
      dimension("PICKUPS"),
      dimension("SERVICEABILITY"),
      dimension("RATES", "FAIL", ["PROVIDER_PICKUP_UNAVAILABLE"]),
      dimension("COURIER_ID_MAPPING"),
      dimension("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
      dimension("LABEL", "WARN", ["PROVIDER_LABEL_NOT_CERTIFIED"]),
      dimension("TRACKING", "NOT_RUN", ["PROVIDER_TRACKING_NOT_CERTIFIED"]),
      dimension("PUBLIC_SAFETY")
    ]
  });
}

function shiprocketPilotReady() {
  return snapshot("SHIPROCKET", {
    status: "READY_FOR_PILOT",
    can_use_for_rates: true,
    can_use_for_awb: false,
    blockers: ["PROVIDER_AWB_NOT_CERTIFIED"],
    dimensions: [
      dimension("CREDENTIALS"),
      dimension("PICKUPS"),
      dimension("SERVICEABILITY"),
      dimension("RATES"),
      dimension("COURIER_ID_MAPPING"),
      dimension("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
      dimension("LABEL", "WARN", ["PROVIDER_LABEL_NOT_CERTIFIED"]),
      dimension("TRACKING", "NOT_RUN", ["PROVIDER_TRACKING_NOT_CERTIFIED"]),
      dimension("PUBLIC_SAFETY")
    ]
  });
}

function liveReadyProvider(providerKey: CourierLiveProviderKey) {
  return snapshot(providerKey, {
    status: "READY_FOR_LIVE",
    live_ready: true,
    can_use_for_rates: true,
    can_use_for_awb: true,
    can_use_for_label: true,
    can_use_for_tracking: true,
    blockers: [],
    dimensions: [
      dimension("CREDENTIALS"),
      dimension("PICKUPS"),
      dimension("SERVICEABILITY"),
      dimension("RATES"),
      dimension("COURIER_ID_MAPPING"),
      dimension("AWB"),
      dimension("LABEL"),
      dimension("TRACKING"),
      dimension("PUBLIC_SAFETY")
    ]
  });
}

function rate(overrides: Record<string, unknown> = {}) {
  return {
    id: `rate_${Math.random()}`,
    shipmentId: "shipment_1",
    sellerId: "merchant_1",
    publicServiceCode: "shipmastr_smart",
    publicServiceName: "Shipmastr Smart",
    amountPaise: 7200,
    rateBreakup: {
      phase6: {
        livePilotRatesMode: "LIVE",
        livePilotRatesReady: true,
        pickupAvailable: false,
        deliveryAvailable: true,
        providerCourierId: "123456",
        pickupLocationId: "pickup_1",
        pickupPincode: "201301",
        deliveryPincode: "400001",
        ...overrides
      }
    },
    createdAt: now
  };
}

function makeClient(input: {
  rates?: any[];
  pickups?: any[];
  awbNumber?: string | null;
} = {}) {
  const shipment = {
    id: "shipment_1",
    sellerId: "merchant_1",
    pickupLocationId: "pickup_1",
    fromPincode: "201301",
    toPincode: "400001",
    awbNumber: input.awbNumber ?? null,
    metadata: {}
  };
  const pickups = input.pickups ?? [
    { id: "pickup_1", sellerId: "merchant_1", label: "Noida", pincode: "201301", status: "active", createdAt: now },
    { id: "pickup_2", sellerId: "merchant_1", label: "Gurugram", pincode: "122001", status: "active", createdAt: now }
  ];
  return {
    shipment: {
      findFirst: async ({ where }: any) => (
        where.id === shipment.id && where.sellerId === shipment.sellerId ? shipment : null
      )
    },
    pickupLocation: {
      findFirst: async ({ where }: any) => pickups.find((pickup: any) => (
        pickup.id === where.id && pickup.sellerId === where.sellerId
      )) ?? null,
      findMany: async ({ where }: any) => pickups.filter((pickup: any) => (
        pickup.sellerId === where.sellerId && pickup.status === where.status
      ))
    },
    shipmentRate: {
      findMany: async ({ where }: any) => (input.rates ?? [rate()])
        .filter((row) => row.sellerId === where.sellerId)
        .filter((row) => !where.shipmentId || row.shipmentId === where.shipmentId)
    }
  } as any;
}

async function arbitrate(input: {
  client?: any;
  providers?: CourierCertificationSnapshot[];
  capability?: "RATES" | "AWB" | "LABEL" | "TRACKING";
} = {}) {
  const providers = input.providers ?? [shiprocketBlocked(), snapshot("BIGSHIP"), snapshot("SHIPMOZO")];
  return arbitrateCourierPickup("merchant_1", {
    shipmentId: "shipment_1",
    requestedCapability: input.capability ?? "AWB",
    preferredProviderKey: "SHIPROCKET",
    pickupLocationId: "pickup_1"
  }, {
    client: input.client ?? makeClient(),
    certificationProvider: async () => ({ providers })
  });
}

describe("courier pickup arbitration", () => {
  it("routes selected pickup unavailable with unchecked alternate pickup to RUN_PICKUP_TRIAL", async () => {
    const result = await arbitrate();

    assert.equal(result.decision, "RUN_PICKUP_TRIAL");
    assert.equal(result.selected_option?.pickup_location_id, "pickup_2");
    assert.ok(result.blockers.includes("CONTROLLED_TRIAL_REQUIRES_RATE_REFRESH"));
    assert.ok(result.blockers.includes("PROVIDER_AWB_NOT_CERTIFIED"));
  });

  it("keeps shipment in safe review when selected pickup is unavailable and no alternate pickup exists", async () => {
    const result = await arbitrate({
      client: makeClient({
        pickups: [{ id: "pickup_1", sellerId: "merchant_1", label: "Noida", pincode: "201301", status: "active", createdAt: now }]
      })
    });

    assert.equal(result.decision, "SAFE_REVIEW");
    assert.equal(result.selected_option, null);
  });

  it("uses a live-ready alternate provider when the selected provider is blocked and no pickup trial is available", async () => {
    const result = await arbitrate({
      client: makeClient({
        pickups: [{ id: "pickup_1", sellerId: "merchant_1", label: "Noida", pincode: "201301", status: "active", createdAt: now }]
      }),
      providers: [shiprocketBlocked(), liveReadyProvider("BIGSHIP"), snapshot("SHIPMOZO")]
    });

    assert.equal(result.decision, "TRY_ALTERNATE_PROVIDER");
    assert.equal(result.selected_option?.provider_key_internal, "BIGSHIP");
  });

  it("does not use dry-run-only providers for live AWB arbitration", async () => {
    const result = await arbitrate({
      client: makeClient({
        pickups: [{ id: "pickup_1", sellerId: "merchant_1", label: "Noida", pincode: "201301", status: "active", createdAt: now }]
      }),
      providers: [shiprocketBlocked(), snapshot("BIGSHIP"), snapshot("SHIPMOZO")]
    });

    assert.equal(result.decision, "SAFE_REVIEW");
    assert.equal(result.evaluated_options.find((option) => option.provider_key_internal === "BIGSHIP")?.status, "DRY_RUN_ONLY");
  });

  it("does not use selected provider for AWB when AWB certification is incomplete", async () => {
    const result = await arbitrate({
      client: makeClient({ rates: [rate({ pickupAvailable: true })] }),
      providers: [shiprocketPilotReady(), snapshot("BIGSHIP"), snapshot("SHIPMOZO")]
    });

    assert.notEqual(result.decision, "USE_SELECTED");
    assert.ok(result.evaluated_options[0]?.blockers.includes("PROVIDER_AWB_NOT_CERTIFIED"));
  });

  it("keeps seller-safe output free of provider names, ids, secrets, and raw payloads", async () => {
    const result = await arbitrate();
    const sellerSafe = serializeCourierArbitrationSellerSafe(result);
    const adminSafe = serializeCourierArbitrationAdmin(result);

    assert.match(JSON.stringify(adminSafe), /SHIPROCKET|PROVIDER_AWB_NOT_CERTIFIED/);
    assert.doesNotMatch(JSON.stringify(sellerSafe), /Shiprocket|SHIPROCKET|Bigship|BIGSHIP|Shipmozo|SHIPMOZO|123456|providerCourierId|rawPayload|rawHeaders|Authorization|Bearer|token|secret/i);
  });

  it("mounts authenticated read-only arbitration route without shipping mutations", () => {
    const routes = readFileSync("src/modules/courierPartners/arbitration/courier-arbitration.routes.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");

    assert.match(routes, /courier-arbitration\/shipments\/:shipmentId/);
    assert.match(shippingRoutes, /courierArbitrationRouter/);
    assert.doesNotMatch(routes, /post|ship-now|manifestOrder|createLabel|getLabel|fetchShipmentRates|createDraftOrder|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
