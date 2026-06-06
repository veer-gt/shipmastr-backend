import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { successEnvelope } from "./shipping-public-serializers.js";

const forbiddenPublicTerms =
  /bigship|access_key|bearer|warehouseId|warehouse_id|MasterCustomOrderId|providerOrder|provider_order|token|password/i;

describe("Shipmastr Shipping Network public safety boundary", () => {
  it("keeps public shipment flow responses free of provider internals", () => {
    const publicObjects = [
      successEnvelope("Pickup location created successfully.", {
        pickup_location_id: "pickup_1",
        status: "active",
        courier_network: "Shipmastr Courier Network"
      }),
      successEnvelope("Rates fetched successfully.", {
        shipment_id: "shipment_1",
        rates: [{
          rate_id: "rate_1",
          courier_network: "Shipmastr Courier Network",
          service_level: "Shipmastr Smart",
          charged_weight_kg: 1,
          total_charge: 62,
          currency: "INR",
          estimated_tat_days: 2
        }]
      }),
      successEnvelope("Shipment manifested successfully.", {
        shipment_id: "shipment_1",
        status: "manifested",
        awb: "SM0001",
        tracking_number: "SM0001",
        courier_network: "Shipmastr Courier Network",
        service_level: "Shipmastr Smart"
      })
    ];

    const json = JSON.stringify(publicObjects);

    assert.match(json, /Shipmastr Courier Network/);
    assert.match(json, /Shipmastr Smart/);
    assert.doesNotMatch(json, forbiddenPublicTerms);
  });
});
