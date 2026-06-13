import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  confirmControlledCourierPickupTrial,
  createControlledCourierPickupRateRefresh,
  createControlledCourierPickupTrial
} from "../courier-pickup-trial.service.js";
import {
  serializeCourierPickupConfirmation,
  serializeCourierPickupTrial
} from "../courier-pickup-trial.serializer.js";

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
  onUpdate?: (args?: any) => void;
  updates?: any[];
} = {}) {
  const shipment = input.shipment ?? {
    id: "shipment_1",
    sellerId: "merchant_1",
    pickupLocationId: "pickup_1",
    fromPincode: "201301",
    toPincode: "400001",
    paymentMode: "prepaid",
    codAmountPaise: 0,
    deadWeightKg: 1,
    lengthCm: 10,
    breadthCm: 10,
    heightCm: 10,
    status: "draft",
    metadata: {}
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
      update: async (args: any) => {
        input.onUpdate?.(args);
        input.updates?.push(args);
        return {
          ...shipment,
          ...(args.data ?? {})
        };
      }
    },
    pickupLocation: {
      findFirst: async ({ where }: any) => pickups.find((pickup) => (
        pickup.id === where.id && pickup.sellerId === where.sellerId
      )) ?? null
    },
    shipmentRate: {
      findMany: async ({ where }: any) => (input.rates ?? [rate()])
        .filter((row) => row.shipmentId === where.shipmentId && row.sellerId === where.sellerId),
      create: async () => {
        throw new Error("controlled pickup trial must not create selected shipment rates");
      },
      update: async () => {
        throw new Error("controlled pickup trial must not update selected shipment rates");
      },
      deleteMany: async () => {
        throw new Error("controlled pickup trial must not delete selected shipment rates");
      }
    }
  } as any;
}

function providerRate(overrides: Record<string, unknown> = {}) {
  return {
    rateId: "provider_rate_1",
    serviceLevel: "Shipmastr Smart",
    courierNetwork: "Shipmastr Courier Network",
    totalCharge: 72,
    currency: "INR",
    tatDays: 2,
    chargedWeightKg: 1,
    codSupported: true,
    pickupAvailable: true,
    deliveryAvailable: true,
    providerCourierId: "54",
    providerMetadata: {
      providerCourierId: "54",
      rawHeaders: "unsafe"
    },
    ...overrides
  };
}

function adapter(rates: any[] = [providerRate()]) {
  return {
    code: "shiprocket",
    login: async () => ({ token: "never-printed", expiresAt: new Date("2026-06-12T11:00:00.000Z") }),
    ensureToken: async () => ({ token: "never-printed", expiresAt: new Date("2026-06-12T11:00:00.000Z") }),
    createPickupLocation: async () => {
      throw new Error("pickup mutation must not be called");
    },
    createDraftOrder: async () => {
      throw new Error("draft order mutation must not be called");
    },
    getRates: async () => rates,
    manifestOrder: async () => {
      throw new Error("AWB creation must not be called");
    },
    getLabel: async () => {
      throw new Error("label generation must not be called");
    },
    trackOrder: async () => {
      throw new Error("tracking must not be called");
    },
    cancelOrder: async () => {
      throw new Error("cancel must not be called");
    }
  } as any;
}

function eligibleEvidence(overrides: Record<string, unknown> = {}) {
  return {
    trial_id: "pickup_trial_shipment_1_pickup_2",
    provider_key: "SHIPROCKET",
    trial_pickup_location_id: "pickup_2",
    trial_pickup_pincode: "122001",
    delivery_pincode: "400001",
    status: "ELIGIBLE_RATES_FOUND",
    rate_context: {
      candidate_count: 1,
      eligible_count: 1,
      pickup_available_count: 1,
      delivery_available_count: 1,
      numeric_courier_id_count: 1
    },
    public_rate_options: [{
      public_service_code: "shipmastr_smart",
      public_service_name: "Shipmastr Smart",
      amount_paise: 7200,
      estimated_delivery_days: 2
    }],
    blockers: [],
    warnings: ["Stored safe trial evidence."],
    seller_safe_message: "Shipmastr shipping options are available for this pickup trial.",
    admin_next_actions: ["Explicitly confirm pickup before refreshing rates."],
    rawProviderResponseStored: false,
    refreshed_at: now.toISOString(),
    ...overrides
  };
}

function shipmentWithEvidence(evidence: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "shipment_1",
    sellerId: "merchant_1",
    pickupLocationId: "pickup_1",
    fromPincode: "201301",
    toPincode: "400001",
    paymentMode: "prepaid",
    codAmountPaise: 0,
    deadWeightKg: 1,
    lengthCm: 10,
    breadthCm: 10,
    heightCm: 10,
    status: "draft",
    awbNumber: null,
    metadata: {
      phase44d: {
        alternatePickupRateRefreshTrials: {
          pickup_2: evidence
        }
      }
    },
    ...overrides
  };
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

  it("runs a controlled alternate pickup rate refresh without mutating shipment pickup or creating shipping artifacts", async () => {
    const updates: any[] = [];
    const result = await createControlledCourierPickupRateRefresh("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      mode: "CONTROLLED_REFRESH"
    }, {
      client: makeClient({ updates }),
      adapter: adapter([providerRate()]),
      now: () => now
    });
    const update = updates[0];
    const stored = update?.data?.metadata?.phase44d?.alternatePickupRateRefreshTrials?.pickup_2;
    const json = JSON.stringify({
      result: serializeCourierPickupTrial(result),
      stored
    });

    assert.equal(result.status, "ELIGIBLE_RATES_FOUND");
    assert.equal(result.current_pickup_location_id, "pickup_1");
    assert.equal(result.trial_pickup_location_id, "pickup_2");
    assert.equal(result.trial_pickup_pincode, "122001");
    assert.equal(result.delivery_pincode, "400001");
    assert.equal(result.rate_context.candidate_count, 1);
    assert.equal(result.rate_context.eligible_count, 1);
    assert.equal(result.rate_context.pickup_available_count, 1);
    assert.equal(result.rate_context.delivery_available_count, 1);
    assert.equal(result.rate_context.numeric_courier_id_count, 1);
    assert.equal(result.public_rate_options[0]?.public_service_name, "Shipmastr Smart");
    assert.equal(updates.length, 1);
    assert.equal(update.data.pickupLocationId, undefined);
    assert.equal(update.data.fromPincode, undefined);
    assert.equal(update.data.status, undefined);
    assert.equal(update.data.awbNumber, undefined);
    assert.equal(stored.rawProviderResponseStored, false);
    assert.equal(stored.trial_pickup_location_id, "pickup_2");
    assert.doesNotMatch(json, /rawHeaders|rawResponse|rawPayload|providerMetadata|Authorization|Bearer|never-printed|token|secret|providerCourierId|raw provider/i);
  });

  it("stores unavailable alternate pickup refresh evidence and keeps the trial blocked", async () => {
    const updates: any[] = [];
    const result = await createControlledCourierPickupRateRefresh("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      mode: "CONTROLLED_REFRESH"
    }, {
      client: makeClient({ updates }),
      adapter: adapter([providerRate({ pickupAvailable: false })]),
      now: () => now
    });

    assert.equal(result.status, "PICKUP_UNAVAILABLE");
    assert.equal(result.rate_context.pickup_available_count, 0);
    assert.ok(result.blockers.includes("PROVIDER_PICKUP_UNAVAILABLE"));
    assert.equal(updates[0]?.data?.metadata?.phase44d?.alternatePickupRateRefreshTrials?.pickup_2?.status, "PICKUP_UNAVAILABLE");
  });

  it("reuses stored controlled refresh evidence on later dry-run trial checks", async () => {
    const result = await createControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      mode: "DRY_RUN"
    }, {
      client: makeClient({
        rates: [],
        shipment: {
          id: "shipment_1",
          sellerId: "merchant_1",
          pickupLocationId: "pickup_1",
          fromPincode: "201301",
          toPincode: "400001",
          paymentMode: "prepaid",
          codAmountPaise: 0,
          deadWeightKg: 1,
          lengthCm: 10,
          breadthCm: 10,
          heightCm: 10,
          status: "draft",
          metadata: {
            phase44d: {
              alternatePickupRateRefreshTrials: {
                pickup_2: {
                  status: "ELIGIBLE_RATES_FOUND",
                  rate_context: {
                    candidate_count: 1,
                    eligible_count: 1,
                    pickup_available_count: 1,
                    delivery_available_count: 1,
                    numeric_courier_id_count: 1
                  },
                  public_rate_options: [{
                    public_service_code: "shipmastr_express",
                    public_service_name: "Shipmastr Express",
                    amount_paise: 9900,
                    estimated_delivery_days: 1
                  }],
                  blockers: [],
                  warnings: ["Stored safe trial evidence."],
                  seller_safe_message: "Shipmastr shipping options are available for this pickup trial.",
                  admin_next_actions: ["Review the trial options."]
                }
              }
            }
          }
        }
      })
    });

    assert.equal(result.status, "ELIGIBLE_RATES_FOUND");
    assert.equal(result.rate_context.eligible_count, 1);
    assert.equal(result.public_rate_options[0]?.public_service_code, "shipmastr_express");
  });

  it("registers dry-run and controlled refresh trial routes without shipping mutations", () => {
    const routes = readFileSync("src/modules/courierPartners/pickupTrial/courier-pickup-trial.routes.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");

    assert.match(routes, /courier-pickup-trials\/providers\/:providerKey\/shipments\/:shipmentId/);
    assert.match(routes, /courier-pickup-trials\/providers\/:providerKey\/shipments\/:shipmentId\/rate-refresh/);
    assert.match(routes, /courier-pickup-trials\/providers\/:providerKey\/shipments\/:shipmentId\/confirm/);
    assert.match(routes, /COURIER_PICKUP_TRIAL_ADMIN_ONLY/);
    assert.match(shippingRoutes, /courierPickupTrialRouter/);
    assert.doesNotMatch(routes, /ship-now|manifestOrder|createLabel|getLabel|fetchShipmentRates|createDraftOrder|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });

  it("confirmation fails when the stored trial is not found", async () => {
    const result = await confirmControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      trialId: "missing_trial"
    }, {
      client: makeClient({ rates: [], shipment: shipmentWithEvidence(eligibleEvidence()) })
    });

    assert.equal(result.success, false);
    assert.equal(result.status, "TRIAL_NOT_FOUND");
    assert.ok(result.blockers.includes("PICKUP_CONFIRMATION_TRIAL_NOT_FOUND"));
  });

  it("confirmation fails when the trial is not eligible", async () => {
    const result = await confirmControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      trialId: "pickup_trial_shipment_1_pickup_2"
    }, {
      client: makeClient({
        shipment: shipmentWithEvidence(eligibleEvidence({
          status: "NO_ELIGIBLE_RATES",
          rate_context: {
            candidate_count: 1,
            eligible_count: 0,
            pickup_available_count: 1,
            delivery_available_count: 1,
            numeric_courier_id_count: 1
          }
        }))
      })
    });

    assert.equal(result.success, false);
    assert.equal(result.status, "TRIAL_NOT_ELIGIBLE");
    assert.ok(result.blockers.includes("PICKUP_CONFIRMATION_TRIAL_NOT_ELIGIBLE"));
    assert.ok(result.blockers.includes("PICKUP_CONFIRMATION_NO_ELIGIBLE_RATES"));
  });

  it("confirmation fails when pickup availability or courier id evidence is missing", async () => {
    const pickupUnavailable = await confirmControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      trialId: "pickup_trial_shipment_1_pickup_2"
    }, {
      client: makeClient({
        shipment: shipmentWithEvidence(eligibleEvidence({
          rate_context: {
            candidate_count: 1,
            eligible_count: 1,
            pickup_available_count: 0,
            delivery_available_count: 1,
            numeric_courier_id_count: 1
          }
        }))
      })
    });
    const courierMissing = await confirmControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      trialId: "pickup_trial_shipment_1_pickup_2"
    }, {
      client: makeClient({
        shipment: shipmentWithEvidence(eligibleEvidence({
          rate_context: {
            candidate_count: 1,
            eligible_count: 1,
            pickup_available_count: 1,
            delivery_available_count: 1,
            numeric_courier_id_count: 0
          }
        }))
      })
    });

    assert.ok(pickupUnavailable.blockers.includes("PICKUP_CONFIRMATION_PICKUP_UNAVAILABLE"));
    assert.ok(courierMissing.blockers.includes("PICKUP_CONFIRMATION_COURIER_ID_MISSING"));
  });

  it("confirmation fails when the shipment already has an AWB", async () => {
    const result = await confirmControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      trialId: "pickup_trial_shipment_1_pickup_2"
    }, {
      client: makeClient({
        shipment: shipmentWithEvidence(eligibleEvidence(), { awbNumber: "SM0001" })
      })
    });

    assert.equal(result.success, false);
    assert.equal(result.status, "SHIPMENT_ALREADY_HAS_AWB");
    assert.ok(result.blockers.includes("PICKUP_CONFIRMATION_SHIPMENT_ALREADY_HAS_AWB"));
  });

  it("confirmation succeeds after eligible trial evidence and updates only safe shipment pickup fields", async () => {
    const updates: any[] = [];
    const result = await confirmControlledCourierPickupTrial("merchant_1", {
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_2",
      trialId: "pickup_trial_shipment_1_pickup_2",
      operatorNote: "Pilot Run 6H alternate pickup confirmation"
    }, {
      client: makeClient({ updates, shipment: shipmentWithEvidence(eligibleEvidence()) }),
      now: () => now
    });
    const update = updates[0];
    const audit = update?.data?.metadata?.phase44e?.latestAlternatePickupConfirmation;
    const json = JSON.stringify(serializeCourierPickupConfirmation(result));

    assert.equal(result.success, true);
    assert.equal(result.status, "CONFIRMED");
    assert.equal(result.requires_rate_refresh, true);
    assert.equal(update.data.pickupLocationId, "pickup_2");
    assert.equal(update.data.fromPincode, "122001");
    assert.equal(update.data.awbNumber, undefined);
    assert.equal(update.data.status, undefined);
    assert.equal(audit.previous_pickup_location_id, "pickup_1");
    assert.equal(audit.confirmed_pickup_location_id, "pickup_2");
    assert.equal(audit.trial_id, "pickup_trial_shipment_1_pickup_2");
    assert.equal(audit.requires_rate_refresh, true);
    assert.equal(audit.rawProviderResponseStored, false);
    assert.doesNotMatch(json, /rawPayload|rawHeaders|rawResponse|Authorization|Bearer|token|secret|provider courier|provider pickup/i);
  });
});
