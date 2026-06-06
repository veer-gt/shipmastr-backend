import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CourierPartnerStatus,
  PartnerType,
  SellerCourierPartnerStatus,
  ShipmentSegment,
  ShipmentStatus
} from "@prisma/client";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { HttpError } from "../../lib/httpError.js";
import { cancelShipment } from "./shipping-cancel.service.js";
import { manifestShipment } from "./shipping-manifest.service.js";
import { createShippingPickupLocation, listShippingPickupLocations } from "./shipping-pickup-location.service.js";
import { fetchShipmentRates } from "./shipping-rates.service.js";
import { createShipmentDraft } from "./shipping-shipments.service.js";
import { fetchShipmentTracking } from "./shipping-tracking.service.js";

const now = new Date("2026-06-06T10:00:00.000Z");

function createFakeAdapter(): InternalCourierProviderAdapter & { calls: Record<string, number> } {
  const calls = {
    login: 0,
    ensureToken: 0,
    createPickupLocation: 0,
    createDraftOrder: 0,
    getRates: 0,
    manifestOrder: 0,
    trackOrder: 0,
    cancelOrder: 0
  };

  return {
    code: "bigship",
    calls,
    login: async () => {
      calls.login += 1;
      return { token: "internal_test_token", expiresAt: new Date("2026-06-06T11:00:00.000Z") };
    },
    ensureToken: async () => {
      calls.ensureToken += 1;
      return { token: "internal_test_token", expiresAt: new Date("2026-06-06T11:00:00.000Z") };
    },
    createPickupLocation: async () => {
      calls.createPickupLocation += 1;
      return {
        providerPickupId: "internal_pickup_001",
        status: "active",
        message: "saved",
        providerMetadata: { saved: true }
      };
    },
    createDraftOrder: async () => {
      calls.createDraftOrder += 1;
      return {
        providerOrderId: "internal_order_001",
        providerReferenceNumber: "internal_ref_001",
        status: "draft",
        message: "created",
        providerMetadata: { created: true }
      };
    },
    getRates: async () => {
      calls.getRates += 1;
      return [{
        rateId: "internal_rate_smart",
        serviceLevel: "Shipmastr Smart",
        courierNetwork: "Shipmastr Courier Network",
        totalCharge: 62,
        currency: "INR",
        tatDays: 2,
        chargedWeightKg: 1,
        providerCourierId: "internal_courier_smart",
        providerMetadata: { score: 92 }
      }, {
        rateId: "internal_rate_economy",
        serviceLevel: "Shipmastr Economy",
        courierNetwork: "Shipmastr Courier Network",
        totalCharge: 48,
        currency: "INR",
        tatDays: 4,
        chargedWeightKg: 1,
        providerCourierId: "internal_courier_economy",
        providerMetadata: { score: 80 }
      }];
    },
    manifestOrder: async () => {
      calls.manifestOrder += 1;
      return {
        awb: "mock_awb_001",
        trackingNumber: "mock_awb_001",
        status: "manifested",
        providerReferenceNumber: "internal_manifest_001",
        providerAwb: "mock_awb_001",
        message: "manifested",
        providerMetadata: { manifested: true }
      };
    },
    trackOrder: async () => {
      calls.trackOrder += 1;
      return {
        awb: "mock_awb_001",
        trackingNumber: "mock_awb_001",
        status: "in_transit",
        publicStatus: "In transit",
        latestEvent: "Shipment is moving.",
        events: [{
          status: "manifested",
          publicStatus: "Ready to ship",
          message: "Shipment manifested.",
          location: "Origin",
          checkpointTime: new Date("2026-06-06T10:30:00.000Z")
        }, {
          status: "in_transit",
          publicStatus: "In transit",
          message: "Shipment is moving.",
          location: "Transit hub",
          checkpointTime: new Date("2026-06-06T12:00:00.000Z")
        }],
        providerMetadata: { eventCount: 2 }
      };
    },
    cancelOrder: async () => {
      calls.cancelOrder += 1;
      return {
        cancelled: true,
        status: "cancelled",
        message: "cancelled",
        providerMetadata: { cancelled: true }
      };
    }
  };
}

function createFakeClient() {
  const state = {
    courierPartners: [{
      id: "courier_internal_1",
      name: "Internal Partner",
      code: "internal_partner",
      active: true,
      status: CourierPartnerStatus.active,
      isSystemManaged: true,
      defaultForNewSellers: true,
      credentialsRequiredFromSeller: false,
      country: "IN",
      supportedSegments: [ShipmentSegment.domestic_b2c],
      priority: 50,
      createdAt: now
    }],
    sellerCourierPartners: [] as any[],
    pickupLocations: [] as any[],
    pickupMappings: [] as any[],
    shipments: [] as any[],
    providerRefs: [] as any[],
    rates: [] as any[],
    trackingEvents: [] as any[]
  };

  const id = (prefix: string, count: number) => `${prefix}_${count + 1}`;
  const byId = <T extends { id: string }>(rows: T[], rowId: string) => rows.find((row) => row.id === rowId);

  const client = {
    courierPartner: {
      findFirst: async () => state.courierPartners[0]
    },
    sellerCourierPartner: {
      findUnique: async ({ where }: any) => {
        const unique = where.sellerId_courierPartnerId;
        return state.sellerCourierPartners.find((row) =>
          row.sellerId === unique.sellerId && row.courierPartnerId === unique.courierPartnerId
        ) ?? null;
      },
      create: async ({ data }: any) => {
        const row = { id: id("scp", state.sellerCourierPartners.length), createdAt: now, updatedAt: now, ...data };
        state.sellerCourierPartners.push(row);
        return row;
      }
    },
    pickupLocation: {
      create: async ({ data }: any) => {
        const row = { id: id("pickup", state.pickupLocations.length), createdAt: now, updatedAt: now, ...data };
        state.pickupLocations.push(row);
        return row;
      },
      findMany: async ({ where }: any) => state.pickupLocations.filter((row) => row.sellerId === where.sellerId),
      findFirst: async ({ where }: any) => state.pickupLocations.find((row) =>
        row.id === where.id && (!where.sellerId || row.sellerId === where.sellerId)
      ) ?? null
    },
    pickupLocationProviderMapping: {
      findUnique: async ({ where }: any) => {
        const unique = where.pickupLocationId_courierPartnerId;
        return state.pickupMappings.find((row) =>
          row.pickupLocationId === unique.pickupLocationId && row.courierPartnerId === unique.courierPartnerId
        ) ?? null;
      },
      upsert: async ({ where, create, update }: any) => {
        const unique = where.pickupLocationId_courierPartnerId;
        const existing = state.pickupMappings.find((row) =>
          row.pickupLocationId === unique.pickupLocationId && row.courierPartnerId === unique.courierPartnerId
        );
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const row = { id: id("pickup_mapping", state.pickupMappings.length), createdAt: now, updatedAt: now, ...create };
        state.pickupMappings.push(row);
        return row;
      }
    },
    shipment: {
      create: async ({ data }: any) => {
        const row = { id: id("shipment", state.shipments.length), createdAt: now, updatedAt: now, awbNumber: null, trackingUrl: null, serviceLevel: null, ...data };
        state.shipments.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.shipments.find((row) =>
        row.id === where.id && (!where.sellerId || row.sellerId === where.sellerId)
      ) ?? null,
      update: async ({ where, data }: any) => {
        const row = byId(state.shipments, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    shipmentProviderRef: {
      findFirst: async ({ where }: any) => state.providerRefs.find((row) =>
        row.shipmentId === where.shipmentId &&
        (where.courierPartnerId === undefined || row.courierPartnerId === where.courierPartnerId)
      ) ?? null,
      create: async ({ data }: any) => {
        const row = { id: id("provider_ref", state.providerRefs.length), createdAt: now, updatedAt: now, ...data };
        state.providerRefs.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = byId(state.providerRefs, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    shipmentRate: {
      create: async ({ data }: any) => {
        const row = { id: id("rate", state.rates.length), createdAt: now, updatedAt: now, ...data };
        state.rates.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.rates.find((row) =>
        row.id === where.id && row.shipmentId === where.shipmentId && row.sellerId === where.sellerId
      ) ?? null
    },
    shipmentTrackingEvent: {
      create: async ({ data }: any) => {
        const row = { id: id("event", state.trackingEvents.length), createdAt: now, ...data };
        state.trackingEvents.push(row);
        return row;
      },
      findMany: async ({ where }: any) => state.trackingEvents
        .filter((row) => row.shipmentId === where.shipmentId)
        .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    }
  };

  return { client: client as any, state };
}

function pickupBody() {
  return {
    name: "Main warehouse",
    contact_person: "Ops Lead",
    phone: "9999999999",
    email: "ops@example.test",
    address: {
      line1: "Warehouse line",
      city: "Bengaluru",
      state: "KA",
      country: "IN",
      pincode: "560001"
    }
  };
}

function shipmentBody(pickupLocationId: string) {
  return {
    seller_order_id: "ORD1001",
    segment: "domestic_b2c" as const,
    pickup_location_id: pickupLocationId,
    payment_mode: "cod" as const,
    invoice: {
      invoice_number: "INV-1001",
      invoice_amount: 1499,
      collectable_amount: 1499
    },
    buyer: {
      name: "Demo Buyer",
      phone: "8888888888",
      address: {
        line1: "Buyer line",
        city: "Mumbai",
        state: "MH",
        country: "IN",
        pincode: "400001"
      }
    },
    boxes: [{
      weight_kg: 0.8,
      dimensions: {
        length_cm: 20,
        breadth_cm: 15,
        height_cm: 10
      },
      products: [{
        name: "Cotton Shirt",
        quantity: 1,
        unit_price: 1499
      }]
    }]
  };
}

describe("Shipmastr Shipping Network services", () => {
  it("creates pickup locations with internal mapping while returning only public fields", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();

    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const list = await listShippingPickupLocations("seller_1", client);
    const json = JSON.stringify({ pickup, list });

    assert.equal(adapter.calls.createPickupLocation, 1);
    assert.equal(state.pickupLocations.length, 1);
    assert.equal(state.pickupMappings.length, 1);
    assert.equal(state.pickupMappings[0]?.providerPickupId, "internal_pickup_001");
    assert.equal(pickup.pickup_location_id, "pickup_1");
    assert.equal(pickup.courier_network, "Shipmastr Courier Network");
    assert.equal(list.length, 1);
    assert.doesNotMatch(json, /internal_pickup_001|providerPickupId|internal_partner/i);
  });

  it("creates shipment drafts with seller-safe public fields", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });

    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    assert.equal(shipment.shipment_id, "shipment_1");
    assert.equal(shipment.seller_order_id, "ORD1001");
    assert.equal(shipment.status, "draft");
    assert.equal(shipment.segment, "domestic_b2c");
    assert.equal(shipment.payment_mode, "cod");
  });

  it("fetches rates, reuses provider drafts, and keeps public rates provider-safe", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const first = await fetchShipmentRates("seller_1", shipment.shipment_id, { client, adapter });
    const second = await fetchShipmentRates("seller_1", shipment.shipment_id, { client, adapter });
    const json = JSON.stringify(first);

    assert.equal(adapter.calls.createDraftOrder, 1);
    assert.equal(adapter.calls.getRates, 2);
    assert.equal(state.providerRefs.length, 1);
    assert.equal(state.rates.length, 4);
    assert.equal(first.rates.length, 2);
    assert.equal(second.rates.length, 2);
    assert.equal(first.rates[0]?.courier_network, "Shipmastr Courier Network");
    assert.doesNotMatch(json, /internal_courier|internal_order|providerOrder|provider_order|bigship/i);
  });

  it("manifests a shipment, stores internal AWB, and returns Shipmastr tracking fields", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    const rates = await fetchShipmentRates("seller_1", shipment.shipment_id, { client, adapter });

    const manifested = await manifestShipment("seller_1", shipment.shipment_id, rates.rates[0]!.rate_id, {
      client,
      adapter
    });

    assert.equal(adapter.calls.manifestOrder, 1);
    assert.equal(state.providerRefs[0]?.providerAwb, "mock_awb_001");
    assert.match(manifested.awb, /^SM/);
    assert.equal(manifested.tracking_number, manifested.awb);
    assert.equal(manifested.courier_network, "Shipmastr Courier Network");
    assert.equal(manifested.service_level, "Shipmastr Smart");
  });

  it("stores normalized public tracking history", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    const rates = await fetchShipmentRates("seller_1", shipment.shipment_id, { client, adapter });
    await manifestShipment("seller_1", shipment.shipment_id, rates.rates[0]!.rate_id, { client, adapter });

    const tracking = await fetchShipmentTracking("seller_1", shipment.shipment_id, { client, adapter });

    assert.equal(adapter.calls.trackOrder, 1);
    assert.equal(tracking.status, "in_transit");
    assert.equal(tracking.history.length, 2);
    assert.equal(tracking.history[0]?.label, "Ready to ship");
  });

  it("blocks terminal shipment cancellation and cancels cancellable shipments", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const cancelled = await cancelShipment("seller_1", shipment.shipment_id, "Seller request", { client, adapter });

    assert.equal(cancelled.status, "cancelled");
    assert.equal(adapter.calls.cancelOrder, 0);

    state.shipments[0]!.status = ShipmentStatus.delivered;
    await assert.rejects(
      () => cancelShipment("seller_1", shipment.shipment_id, "Too late", { client, adapter }),
      (error) => error instanceof HttpError && error.message === "SHIPMENT_STATUS_TERMINAL"
    );
  });

  it("preserves the existing manual /shipments route and mounts /shipping additively", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const legacyShipments = readFileSync("src/modules/shipments/shipments.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/shipping", requireJwtAuth, shippingNetworkRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/shipments", requireJwtAuth, shipmentsRouter\);/);
    assert.match(legacyShipments, /shipmentsRouter\.get\("\/",/);
    assert.match(legacyShipments, /shipmentsRouter\.post\("\/",/);
  });
});
