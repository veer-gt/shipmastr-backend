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
      }),
      successEnvelope("Shipments fetched successfully.", {
        shipments: [{
          shipment_id: "shipment_1",
          seller_order_id: "ORD1001",
          status: "draft",
          queue: "needs_attention",
          payment_mode: "cod",
          buyer: {
            name: "Rahul Sharma",
            phone: "9876543210",
            pincode: "110011",
            city: "Delhi",
            state: "Delhi"
          },
          pickup_location_id: "pickup_1",
          awb: null,
          tracking_number: null,
          courier_network: "Shipmastr Courier Network",
          service_level: null,
          attention: [{
            code: "no_rates_fetched",
            label: "Rates Pending",
            message: "Fetch Shipmastr service levels before AWB generation."
          }]
        }],
        pagination: {
          page: 1,
          per_page: 20,
          total: 1,
          has_more: false
        }
      }),
      successEnvelope("Shipment draft created from order successfully.", {
        shipment_id: "shipment_1",
        order_id: "order_1",
        seller_order_id: "ORD1001",
        status: "draft",
        segment: "domestic_b2c",
        payment_mode: "cod",
        pickup_location_id: "pickup_1",
        attention: []
      })
    ];

    const json = JSON.stringify(publicObjects);

    assert.match(json, /Shipmastr Courier Network/);
    assert.match(json, /Shipmastr Smart/);
    assert.doesNotMatch(json, forbiddenPublicTerms);
  });
});
