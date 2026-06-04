import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSellerSafeOrders } from "./orders.routes.js";

type SellerOrderInput = Parameters<typeof buildSellerSafeOrders>[0]["orders"][number];
type SellerCourierShipmentInput = NonNullable<Parameters<typeof buildSellerSafeOrders>[0]["courierShipments"]>[number];

const createdAt = new Date("2026-06-01T10:00:00.000Z");

function makeOrder(overrides: Partial<SellerOrderInput> = {}) {
  return {
    id: "order_internal_1",
    merchantId: "merchant_1",
    externalOrderId: "seller-demo-mpz1vdlw-e041cc26",
    buyerName: "Demo Buyer",
    city: "Mumbai",
    state: "MH",
    pincode: "400001",
    orderValue: 1299,
    codAmount: 0,
    paymentMode: "PREPAID",
    weightGrams: 500,
    status: "CREATED",
    createdAt,
    updatedAt: createdAt,
    shipmentDetails: null,
    ...overrides
  };
}

function makeCourierShipment(overrides: Partial<SellerCourierShipmentInput> = {}) {
  return {
    id: "courier_shipment_1",
    orderId: "seller-demo-mpz1vdlw-e041cc26",
    awbNumber: "DEMO-AWB-1001",
    status: "ready_to_ship",
    weightGrams: 800,
    createdAt,
    updatedAt: new Date("2026-06-01T11:00:00.000Z"),
    courier: {
      id: "courier_1",
      name: "Shipmastr Manual Courier",
      code: "MANUAL"
    },
    firstShipmentRequest: null,
    ...overrides
  };
}

describe("seller-safe order shipment mapping", () => {
  it("maps CourierShipment AWB metadata when shipment orderId matches order externalOrderId", () => {
    const [order] = buildSellerSafeOrders({
      orders: [
        makeOrder({
          shipmentDetails: {
            courierId: "courier_legacy",
            awb: "LEGACY-AWB",
            trackingNumber: "LEGACY-TRACKING",
            shipmentStatus: "CREATED",
            weightGrams: 500,
            volumetricWeight: null
          }
        })
      ],
      courierShipments: [makeCourierShipment()]
    });

    assert.equal(order?.awbNumber, "DEMO-AWB-1001");
    assert.equal(order?.awb, "DEMO-AWB-1001");
    assert.equal(order?.carrier, "Shipmastr Manual Courier");
    assert.equal(order?.shipmentStatus, "ready_to_ship");
    assert.equal(order?.deadWeightKg, 0.8);
    assert.equal(order?.chargeableWeightKg, 0.8);
    assert.deepEqual(order?.shipmentWeight, {
      deadWeightKg: 0.8,
      volumetricWeightKg: null,
      chargeableWeightKg: 0.8
    });
  });

  it("uses the most recent matching CourierShipment when multiple shipment rows exist", () => {
    const [order] = buildSellerSafeOrders({
      orders: [makeOrder()],
      courierShipments: [
        makeCourierShipment({
          id: "older_shipment",
          awbNumber: "OLDER-AWB",
          updatedAt: new Date("2026-06-01T10:30:00.000Z")
        }),
        makeCourierShipment({
          id: "newer_shipment",
          awbNumber: "NEWER-AWB",
          updatedAt: new Date("2026-06-01T12:30:00.000Z")
        })
      ]
    });

    assert.equal(order?.awbNumber, "NEWER-AWB");
  });

  it("preserves ShipmentDetails fallback when no CourierShipment exists", () => {
    const [order] = buildSellerSafeOrders({
      orders: [
        makeOrder({
          shipmentDetails: {
            courierId: "courier_1",
            awb: "SHIPMENT-DETAILS-AWB",
            trackingNumber: "SHIPMENT-DETAILS-TRACKING",
            shipmentStatus: "CREATED",
            weightGrams: 600,
            volumetricWeight: 1.2
          }
        })
      ],
      courierById: new Map([
        ["courier_1", { id: "courier_1", name: "Fallback Courier", code: "FALLBACK" }]
      ]),
      courierShipments: []
    });

    assert.equal(order?.awbNumber, "SHIPMENT-DETAILS-AWB");
    assert.equal(order?.carrier, "Fallback Courier");
    assert.equal(order?.shipmentStatus, "CREATED");
    assert.equal(order?.trackingNumber, "SHIPMENT-DETAILS-TRACKING");
    assert.equal(order?.deadWeightKg, 0.6);
    assert.equal(order?.volumetricWeightKg, 1.2);
    assert.equal(order?.chargeableWeightKg, 1.2);
  });

  it("keeps AWB empty for UI pending state when no shipment metadata exists", () => {
    const [order] = buildSellerSafeOrders({
      orders: [makeOrder()],
      courierShipments: []
    });

    assert.equal(order?.awbNumber, null);
    assert.equal(order?.awb, null);
    assert.equal(order?.carrier, null);
  });

  it("does not map a first-shipment-linked CourierShipment from another merchant", () => {
    const [order] = buildSellerSafeOrders({
      orders: [makeOrder()],
      courierShipments: [
        makeCourierShipment({
          firstShipmentRequest: { merchantId: "merchant_2" }
        })
      ]
    });

    assert.equal(order?.awbNumber, null);
    assert.equal(order?.carrier, null);
  });

  it("keeps seller order list free of raw buyer phone and address fields", () => {
    const [order] = buildSellerSafeOrders({
      orders: [makeOrder()],
      courierShipments: [makeCourierShipment()]
    });

    assert.equal("buyerPhone" in (order ?? {}), false);
    assert.equal("addressLine1" in (order ?? {}), false);
    assert.equal("addressLine2" in (order ?? {}), false);
  });
});
