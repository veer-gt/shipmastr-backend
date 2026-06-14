import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  getCourierPickupLearningForPickup,
  getCourierPickupLearningForShipment,
  getCourierPickupLearningProvider,
  listCourierPickupLearningProviders
} from "../courier-pickup-learning.service.js";
import {
  serializeCourierPickupLearningClassification,
  serializeCourierPickupLearningProvider,
  serializeCourierPickupLearningProviders
} from "../courier-pickup-learning.serializer.js";

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
      phase6: {
        livePilotRatesMode: "LIVE",
        livePilotRatesReady: true,
        pickupAvailable: true,
        deliveryAvailable: true,
        providerCourierId: "123456",
        pickupLocationId: "pickup_1",
        pickupPincode: "201301",
        deliveryPincode: "400001",
        ...overrides
      }
    },
    createdAt: now,
    shipment: {
      id: "shipment_1",
      pickupLocationId: "pickup_1",
      fromPincode: "201301",
      toPincode: "400001"
    }
  };
}

function makeClient(input: { rates?: any[]; shipment?: any } = {}) {
  const shipment = input.shipment ?? {
    id: "shipment_1",
    sellerId: "merchant_1",
    pickupLocationId: "pickup_1",
    fromPincode: "201301",
    toPincode: "400001"
  };
  return {
    shipment: {
      findFirst: async ({ where }: any) => (
        where.id === shipment.id && where.sellerId === shipment.sellerId ? shipment : null
      )
    },
    shipmentRate: {
      findMany: async ({ where }: any) => (input.rates ?? [rate()])
        .filter((row) => row.sellerId === where.sellerId)
        .filter((row) => !where.shipmentId || row.shipmentId === where.shipmentId)
    }
  } as any;
}

describe("courier pickup availability learning", () => {
  it("classifies healthy pickup learning from stored safe rate observations", async () => {
    const result = await getCourierPickupLearningForPickup("merchant_1", "SHIPROCKET", "201301", {
      client: makeClient({
        rates: [rate(), rate(), rate(), rate()]
      })
    });
    const serialized = serializeCourierPickupLearningClassification(result);
    const json = JSON.stringify(serialized);

    assert.equal(result.status, "HEALTHY");
    assert.equal(result.availability_score, 1);
    assert.equal(result.observation_count, 4);
    assert.equal(result.recommendation, "USE_PICKUP");
    assert.doesNotMatch(json, /123456|providerCourierId|rawPayload|rawHeaders|rawResponse|Authorization|Bearer|token|secret|Bigship/i);
  });

  it("classifies repeated pickup failures as unavailable and recommends another pickup", async () => {
    const result = await getCourierPickupLearningForPickup("merchant_1", "SHIPROCKET", "201301", {
      client: makeClient({
        rates: [
          rate({ pickupAvailable: false }),
          rate({ pickupAvailable: false }),
          rate({ pickupAvailable: false })
        ]
      })
    });

    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.pickup_available_count, 0);
    assert.equal(result.pickup_unavailable_count, 3);
    assert.equal(result.recommendation, "TRY_ALTERNATE_PICKUP");
  });

  it("returns unknown learning when no stored observations exist", async () => {
    const result = await getCourierPickupLearningForPickup("merchant_1", "SHIPROCKET", "122001", {
      client: makeClient({ rates: [] }),
      deliveryPincode: "400001"
    });

    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.observation_count, 0);
    assert.equal(result.pickup_pincode, "122001");
    assert.equal(result.recommendation, "RUN_RATE_REFRESH");
  });

  it("summarizes provider pickup learning safely", async () => {
    const result = await getCourierPickupLearningProvider("merchant_1", "SHIPROCKET", {
      client: makeClient({
        rates: [
          rate({ pickupPincode: "201301", pickupAvailable: false }),
          rate({ pickupPincode: "201301", pickupAvailable: false }),
          rate({ pickupPincode: "122001", pickupAvailable: true, pickupLocationId: "pickup_2" })
        ]
      })
    });
    const list = await listCourierPickupLearningProviders("merchant_1", { client: makeClient({ rates: [] }) });
    const json = JSON.stringify([
      serializeCourierPickupLearningProvider(result),
      serializeCourierPickupLearningProviders(list)
    ]);

    assert.equal(result.pickup_count, 2);
    assert.equal(result.unavailable_pickup_count, 1);
    assert.doesNotMatch(json, /providerCourierId|123456|rawPayload|rawHeaders|Authorization|Bearer|token|secret/i);
  });

  it("classifies shipment pickup learning using shipment fallback context", async () => {
    const result = await getCourierPickupLearningForShipment("merchant_1", "SHIPROCKET", "shipment_1", {
      client: makeClient({
        rates: [{
          ...rate(),
          rateBreakup: {
            phase6: {
              livePilotRatesMode: "LIVE",
              livePilotRatesReady: true,
              pickupAvailable: false,
              deliveryAvailable: true,
              providerCourierId: "1"
            }
          },
          shipment: null
        }]
      })
    });

    assert.equal(result.pickup_pincode, "201301");
    assert.equal(result.delivery_pincode, "400001");
    assert.equal(result.status, "UNAVAILABLE");
  });

  it("registers read-only pickup learning routes without shipping mutations", () => {
    const routes = readFileSync("src/modules/courierPartners/pickupLearning/courier-pickup-learning.routes.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");

    assert.match(routes, /pickup-learning\/providers/);
    assert.match(routes, /pickup-learning\/providers\/:providerKey\/pickups\/:pickupPincode/);
    assert.match(routes, /pickup-learning\/providers\/:providerKey\/shipments\/:shipmentId/);
    assert.match(shippingRoutes, /courierPickupLearningRouter/);
    assert.doesNotMatch(routes, /post|ship-now|manifestOrder|createLabel|getLabel|fetchShipmentRates|createDraftOrder|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
