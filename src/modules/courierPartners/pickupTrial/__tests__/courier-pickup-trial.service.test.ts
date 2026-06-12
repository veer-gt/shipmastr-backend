import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createControlledCourierPickupTrial } from "../courier-pickup-trial.service.js";
import { serializeCourierPickupTrial } from "../courier-pickup-trial.serializer.js";

const now = new Date("2026-06-12T10:00:00.000Z");

function rate(overrides: Record<string, unknown> = {}) {
  return {
    id: "rate_1",
    shipmentId: "shipment_1",
    sellerId: "merchant_1",
    publicServiceCode: "shipmastr_smart",
    publicServiceName: "Shipmastr Smart",
    amountPaise: 7200,
    estimatedDeliveryDays: 2,
    rateBreakup: {
      phase6: {
        livePilotRatesMode: "LIVE",
        livePilotRatesReady: true,
        pickupAvailable: true,
        deliveryAvailable: true,
        providerCourierId: "1",
        pickupLocationId: "pickup_1",
        pickupPincode: "201301",
        ...overrides
      }
    },
    createdAt: now
  };
}

function makeClient(input: {
  rates?: any[];
  pickups?: any[];
  shipment?: any;
  onUpdate?: () => void;
} = {}) {
  const shipment = input.shipment ?? {
    id: "shipment_1",
    sellerId: "merchant_1",
    pickupLocationId: "pickup_1",
    fromPincode: "201301",
    toPincode: "400001",
    paymentMode: "prepaid",
    status: "draft"
  };
  const pickups = input.pickups ?? [{
    id: "pickup_1",
    sellerId: "merchant_1",
    pincode: "201301",
    status: "active"
  }, {
    id: "pickup_2",
    sellerId: "merchant_1",
    pincode: "122001",
    status: "active"
  }];
  return {
    shipment: {
      findFirst: async ({ where }: any) => (
        where.id === shipment.id && where.sellerId === shipment.sellerId ? shipment : null
      ),
      update: async () => {
        input.onUpdate?.();
        throw new Error("shipment update must not be called by pickup trial");
      }
    },
    pickupLocation: {
      findFirst: async ({ where }: any) => pickups.find((pickup) => (
        pickup.id === where.id && pickup.sellerId === where.sellerId
      )) ?? null
    },
    shipmentRate: {
      findMany: async ({ where }: any) => (input.rates ?? [rate()])
        .filter((row) => row.shipmentId === where.shipmentId && row.sellerId === where.sellerId)
    }
  } as any;
}

describe("controlled alternate pickup rate trial", () => {
  it("returns DRY_RUN_ONLY for an unchecked alternate pickup without mutating shipment", async () => {
    let updateCalled = false;
    const result = await createControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      mode: "DRY_RUN"
    }, {
      client: makeClient({
        onUpdate: () => {
          updateCalled = true;
        }
      })
    });
    const serialized = serializeCourierPickupTrial(result);
    const json = JSON.stringify(serialized);

    assert.equal(result.status, "DRY_RUN_ONLY");
    assert.equal(result.current_pickup_location_id, "pickup_1");
    assert.equal(result.trial_pickup_location_id, "pickup_2");
    assert.equal(result.rate_context.candidate_count, 0);
    assert.ok(result.blockers.includes("CONTROLLED_TRIAL_REQUIRES_RATE_REFRESH"));
    assert.equal(updateCalled, false);
    assert.doesNotMatch(json, /rawPayload|rawHeaders|rawResponse|Authorization|Bearer|token|secret|providerCourierId|provider pickup/i);
  });

  it("uses stored safe evidence when the trial pickup matches stored pickup metadata", async () => {
    const result = await createControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      mode: "DRY_RUN"
    }, {
      client: makeClient({
        rates: [rate({
          pickupLocationId: "pickup_2",
          pickupPincode: "122001",
          providerCourierId: "54"
        })]
      })
    });

    assert.equal(result.status, "ELIGIBLE_RATES_FOUND");
    assert.equal(result.rate_context.candidate_count, 1);
    assert.equal(result.rate_context.eligible_count, 1);
    assert.equal(result.public_rate_options[0]?.public_service_name, "Shipmastr Smart");
  });

  it("supports an injected mocked previewer without live provider calls", async () => {
    let previewerCalled = false;
    const result = await createControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      mode: "DRY_RUN"
    }, {
      client: makeClient({ rates: [] }),
      ratePreviewer: async () => {
        previewerCalled = true;
        return [{
          publicServiceCode: "shipmastr_express",
          publicServiceName: "Shipmastr Express",
          amountPaise: 9900,
          estimatedDeliveryDays: 1,
          pickupAvailable: true,
          deliveryAvailable: true,
          providerCourierId: "1"
        }];
      }
    });

    assert.equal(previewerCalled, true);
    assert.equal(result.status, "ELIGIBLE_RATES_FOUND");
    assert.equal(result.public_rate_options[0]?.public_service_code, "shipmastr_express");
  });

  it("classifies pickup-unavailable trial evidence safely", async () => {
    const result = await createControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      mode: "DRY_RUN"
    }, {
      client: makeClient({
        rates: [rate({
          pickupLocationId: "pickup_2",
          pickupPincode: "122001",
          pickupAvailable: false,
          providerCourierId: "1"
        })]
      })
    });

    assert.equal(result.status, "PICKUP_UNAVAILABLE");
    assert.equal(result.rate_context.pickup_available_count, 0);
    assert.equal(result.rate_context.delivery_available_count, 1);
    assert.equal(result.rate_context.numeric_courier_id_count, 1);
    assert.ok(result.blockers.includes("PROVIDER_PICKUP_UNAVAILABLE"));
  });

  it("registers only the dry-run trial route and no shipping mutations", () => {
    const routes = readFileSync("src/modules/courierPartners/pickupTrial/courier-pickup-trial.routes.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");

    assert.match(routes, /courier-pickup-trials\/providers\/:providerKey\/shipments\/:shipmentId/);
    assert.match(shippingRoutes, /courierPickupTrialRouter/);
    assert.doesNotMatch(routes, /ship-now|manifestOrder|createLabel|getLabel|fetchShipmentRates|createDraftOrder|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
