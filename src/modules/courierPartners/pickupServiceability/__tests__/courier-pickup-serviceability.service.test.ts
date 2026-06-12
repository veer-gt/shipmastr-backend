import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  diagnoseCourierPickupServiceability,
  listCourierPickupServiceabilityTrials
} from "../courier-pickup-serviceability.service.js";
import {
  serializeCourierPickupServiceability,
  serializeCourierPickupTrial
} from "../courier-pickup-serviceability.serializer.js";

const now = new Date("2026-06-12T10:00:00.000Z");

function rate(overrides: Record<string, unknown> = {}) {
  return {
    id: `rate_${Math.random()}`,
    shipmentId: "shipment_1",
    sellerId: "merchant_1",
    publicServiceCode: "shipmastr_smart",
    publicServiceName: "Shipmastr Smart",
    amountPaise: 7200,
    rateBreakup: {
      providerCourierId: "1",
      phase6: {
        livePilotRatesMode: "LIVE",
        livePilotRatesReady: true,
        pickupAvailable: false,
        deliveryAvailable: true,
        providerCourierId: "1",
        ...overrides
      }
    },
    createdAt: now
  };
}

function makeClient(input: {
  rates?: any[];
  latestRefresh?: Record<string, unknown>;
  pickupLocationId?: string;
  pickupPincode?: string;
  extraPickups?: any[];
} = {}) {
  const pickupLocationId = input.pickupLocationId ?? "pickup_1";
  const pickupPincode = input.pickupPincode ?? "201301";
  const pickups = [{
    id: pickupLocationId,
    sellerId: "merchant_1",
    label: "Noida Warehouse",
    city: "Noida",
    state: "UP",
    pincode: pickupPincode,
    status: "active",
    createdAt: now
  }, ...(input.extraPickups ?? [])];
  const shipment = {
    id: "shipment_1",
    sellerId: "merchant_1",
    pickupLocationId,
    fromPincode: pickupPincode,
    toPincode: "400001",
    paymentMode: "cod",
    metadata: {
      phase6: {
        latestRateRefresh: input.latestRefresh ?? {
          status: "NO_ELIGIBLE_SHIPPING_RATES",
          selected_pickup_pincode: pickupPincode,
          delivery_pincode: "400001",
          live_provider_checked: true,
          live_serviceability_returned_count: input.rates?.length ?? 3,
          live_rate_candidates_count: input.rates?.length ?? 3,
          eligible_rate_count: 0,
          rejected_rate_reasons: [{ safe_reason: "PICKUP_UNAVAILABLE", count: input.rates?.length ?? 3 }],
          provider_pickup_available_any: false,
          provider_delivery_available_any: true,
          stale_selected_rate_ignored: true,
          checked_at: now.toISOString()
        }
      }
    }
  };
  return {
    shipment: {
      findFirst: async ({ where }: any) => (
        where.id === shipment.id && where.sellerId === shipment.sellerId ? shipment : null
      )
    },
    shipmentRate: {
      findMany: async ({ where }: any) => (input.rates ?? [rate(), rate({ providerCourierId: "54" }), rate()])
        .filter((row) => row.shipmentId === where.shipmentId && row.sellerId === where.sellerId)
    },
    pickupLocation: {
      findFirst: async ({ where }: any) => pickups.find((pickup) => (
        pickup.id === where.id && pickup.sellerId === where.sellerId
      )) ?? null,
      findMany: async ({ where }: any) => pickups.filter((pickup) => (
        pickup.sellerId === where.sellerId && pickup.status === where.status
      ))
    }
  } as any;
}

describe("courier pickup serviceability resolution", () => {
  it("classifies stored live rates with pickup unavailable as PICKUP_UNAVAILABLE", async () => {
    const result = await diagnoseCourierPickupServiceability("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1"
    }, { client: makeClient() });
    const serialized = serializeCourierPickupServiceability(result);
    const json = JSON.stringify(serialized);

    assert.equal(result.status, "PICKUP_UNAVAILABLE");
    assert.equal(result.latest_rate_context.pickup_available_count, 0);
    assert.equal(result.latest_rate_context.delivery_available_count, 3);
    assert.equal(result.latest_rate_context.numeric_courier_id_count, 3);
    assert.ok(result.blockers.includes("PROVIDER_PICKUP_UNAVAILABLE"));
    assert.ok(result.blockers.includes("TRY_ALTERNATE_PICKUP") === false);
    assert.doesNotMatch(json, /Shiprocket|shiprocket|providerCourierId|provider pickup|rawPayload|rawHeaders|rawResponse|Authorization|Bearer|token|secret/i);
  });

  it("does not blame courier id mapping or credentials when pickup is the remaining blocker", async () => {
    const result = await diagnoseCourierPickupServiceability("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1"
    }, { client: makeClient() });

    assert.equal(result.latest_rate_context.delivery_available_count, 3);
    assert.equal(result.latest_rate_context.numeric_courier_id_count, 3);
    assert.equal(result.blockers.includes("PROVIDER_COURIER_ID_MISSING"), false);
    assert.equal(result.blockers.includes("PROVIDER_CREDENTIALS_MISSING"), false);
  });

  it("returns selected and alternate active pickups safely without provider calls", async () => {
    const client = makeClient({
      extraPickups: [{
        id: "pickup_2",
        sellerId: "merchant_1",
        label: "Mumbai Warehouse",
        city: "Mumbai",
        state: "MH",
        pincode: "400001",
        status: "active",
        createdAt: now
      }]
    });
    const result = await listCourierPickupServiceabilityTrials("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1"
    }, { client });
    const serialized = serializeCourierPickupTrial(result);
    const json = JSON.stringify(serialized);

    assert.equal(result.pickups.length, 2);
    assert.equal(result.pickups.find((pickup) => pickup.selected)?.status, "PICKUP_UNAVAILABLE");
    assert.equal(result.pickups.find((pickup) => !pickup.selected)?.status, "NOT_CHECKED");
    assert.equal(result.recommendation.action, "TRY_ALTERNATE_PICKUP");
    assert.equal(result.recommendation.pickup_location_id, "pickup_2");
    assert.doesNotMatch(json, /Shiprocket|shiprocket|providerCourierId|rawPayload|rawHeaders|rawResponse|Authorization|Bearer|token|secret/i);
  });

  it("reports no provider candidates from the latest refresh without exposing raw details", async () => {
    const result = await diagnoseCourierPickupServiceability("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1"
    }, {
      client: makeClient({
        rates: [],
        latestRefresh: {
          status: "PROVIDER_SERVICEABILITY_NO_CANDIDATES",
          selected_pickup_pincode: "201301",
          delivery_pincode: "400001",
          live_provider_checked: true,
          live_serviceability_returned_count: 0,
          live_rate_candidates_count: 0,
          eligible_rate_count: 0,
          rejected_rate_reasons: [],
          provider_pickup_available_any: null,
          provider_delivery_available_any: null,
          stale_selected_rate_ignored: true,
          checked_at: now.toISOString()
        }
      })
    });

    assert.equal(result.status, "NO_PROVIDER_CANDIDATES");
    assert.ok(result.blockers.includes("PROVIDER_NO_PICKUP_AVAILABLE_CANDIDATES"));
  });

  it("mounts read-only serviceability routes without shipping mutations", () => {
    const routes = readFileSync("src/modules/courierPartners/pickupServiceability/courier-pickup-serviceability.routes.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");

    assert.match(routes, /courier-pickup-serviceability\/providers\/:providerKey\/shipments\/:shipmentId/);
    assert.match(routes, /courier-pickup-serviceability\/providers\/:providerKey\/shipments\/:shipmentId\/pickups/);
    assert.match(shippingRoutes, /courierPickupServiceabilityRouter/);
    assert.doesNotMatch(routes, /ship-now|manifestOrder|createLabel|getLabel|createDraftOrder|fetchShipmentRates|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
