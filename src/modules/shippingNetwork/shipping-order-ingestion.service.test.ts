import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OrderStatus, PaymentMode, ShipmentStatus, ShippingPaymentMode } from "@prisma/client";
import { parseAmountToPaise } from "./shipping-amounts.js";
import { scoreAddress } from "./shipping-address-quality.js";
import { normalizeStateName } from "./shipping-indian-states.js";
import { validateOrder } from "./shipping-order-validation.js";
import {
  createShippingOrder,
  importShippingOrdersCsv,
  ShippingValidationError
} from "./shipping-order-ingestion.service.js";
import { updateShippingPickupLocation } from "./shipping-pickup-crud.service.js";

function now() {
  return new Date("2026-06-06T12:00:00.000Z");
}

function createFakeClient() {
  const state = {
    pickups: [{
      id: "pickup_1",
      sellerId: "merchant_1",
      label: "Main warehouse",
      contactName: "Ops",
      phone: "9876543210",
      addressLine1: "Warehouse 1 Industrial Area",
      addressLine2: null,
      city: "Delhi",
      state: "Delhi",
      pincode: "110001",
      country: "IN",
      status: "active",
      metadata: { isDefault: true },
      createdAt: now(),
      updatedAt: now()
    }],
    orders: [] as any[],
    shipments: [] as any[],
    batches: [] as any[]
  };
  const client = {
    pickupLocation: {
      findMany: async ({ where }: any = {}) => state.pickups.filter((pickup) => (
        (!where?.sellerId || pickup.sellerId === where.sellerId)
        && (!where?.status || pickup.status === where.status)
      )),
      findFirst: async ({ where }: any = {}) => state.pickups.find((pickup) => (
        (!where?.id || pickup.id === where.id)
        && (!where?.sellerId || pickup.sellerId === where.sellerId)
        && (!where?.status || pickup.status === where.status)
      )) ?? null,
      update: async ({ where, data }: any) => {
        const pickup = state.pickups.find((row) => row.id === where.id);
        assert.ok(pickup);
        Object.assign(pickup, data, { updatedAt: now() });
        return pickup;
      }
    },
    order: {
      findUnique: async ({ where }: any) => {
        if (where?.merchantId_externalOrderId) {
          return state.orders.find((order) => (
            order.merchantId === where.merchantId_externalOrderId.merchantId
            && order.externalOrderId === where.merchantId_externalOrderId.externalOrderId
          )) ?? null;
        }
        if (where?.id) return state.orders.find((order) => order.id === where.id) ?? null;
        return null;
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const order = state.orders.find((row) => row.id === where.id);
        if (!order) throw new Error("not found");
        return {
          ...order,
          pickupLocation: state.pickups.find((pickup) => pickup.id === order.pickupLocationId) ?? null
        };
      },
      findFirst: async ({ where }: any = {}) => state.orders.find((order) => (
        (!where?.id || order.id === where.id)
        && (!where?.merchantId || order.merchantId === where.merchantId)
        && (!where?.externalOrderId || order.externalOrderId === where.externalOrderId)
      )) ?? null,
      findMany: async ({ where }: any = {}) => state.orders.filter((order) => (
        (!where?.merchantId || order.merchantId === where.merchantId)
        && (!where?.paymentMode || order.paymentMode === where.paymentMode)
        && (!where?.status?.in || where.status.in.includes(order.status))
      )),
      count: async ({ where }: any = {}) => state.orders.filter((order) => (
        (!where?.merchantId || order.merchantId === where.merchantId)
      )).length,
      create: async ({ data }: any) => {
        const order = {
          id: `order_${state.orders.length + 1}`,
          createdAt: now(),
          updatedAt: now(),
          ...data
        };
        state.orders.push(order);
        return order;
      },
      update: async ({ where, data }: any) => {
        const order = state.orders.find((row) => row.id === where.id);
        assert.ok(order);
        Object.assign(order, data, { updatedAt: now() });
        return order;
      }
    },
    shipment: {
      findFirst: async ({ where }: any = {}) => state.shipments.find((shipment) => (
        (!where?.id || shipment.id === where.id)
        && (!where?.sellerId || shipment.sellerId === where.sellerId)
        && (!where?.orderId || shipment.orderId === where.orderId)
      )) ?? null,
      findMany: async () => state.shipments,
      create: async ({ data }: any) => {
        const shipment = {
          id: `shp_${state.shipments.length + 1}`,
          awbNumber: null,
          trackingUrl: null,
          serviceLevel: null,
          createdAt: now(),
          updatedAt: now(),
          ...data
        };
        state.shipments.push(shipment);
        return shipment;
      },
      update: async ({ where, data }: any) => {
        const shipment = state.shipments.find((row) => row.id === where.id);
        assert.ok(shipment);
        Object.assign(shipment, data, { updatedAt: now() });
        return shipment;
      }
    },
    orderImportBatch: {
      create: async ({ data }: any) => {
        const batch = {
          id: `batch_${state.batches.length + 1}`,
          createdAt: now(),
          updatedAt: now(),
          ...data
        };
        state.batches.push(batch);
        return batch;
      },
      update: async ({ where, data }: any) => {
        const batch = state.batches.find((row) => row.id === where.id);
        assert.ok(batch);
        Object.assign(batch, data, { updatedAt: now() });
        return batch;
      }
    }
  };

  return { state, client: client as any };
}

function validOrder(overrides: Record<string, unknown> = {}) {
  return {
    externalOrderId: "ORD-1",
    paymentMode: "COD" as const,
    orderAmount: 1499,
    codAmount: 1499,
    buyerName: "Rahul Sharma",
    buyerPhone: "9876543210",
    addressLine1: "221 Market Street, Block A",
    city: "Delhi",
    state: "DL",
    pincode: "110001",
    packageWeight: 800,
    packageLength: 120,
    packageWidth: 100,
    packageHeight: 80,
    productDescription: "Cotton shirt",
    ...overrides
  };
}

describe("Phase 5B shipping order foundation helpers", () => {
  it("scores address quality without throwing and reports weak addresses", () => {
    const strong = scoreAddress({
      addressLine1: "221 Market Street, Block A",
      city: "Delhi",
      state: "Delhi",
      pincode: "110001"
    });
    const weak = scoreAddress({
      addressLine1: "test",
      city: "",
      state: "",
      pincode: "000"
    });

    assert.equal(strong.passed, true);
    assert.equal(weak.passed, false);
    assert.ok(weak.flags.includes("PINCODE_INVALID_FORMAT"));
    assert.ok(weak.flags.includes("ADDRESS_LOOKS_TEST"));
  });

  it("validates orders into ready_to_ship and needs_attention states", () => {
    const ready = validateOrder({
      buyerName: "Rahul Sharma",
      buyerPhone: "9876543210",
      addressLine1: "221 Market Street, Block A",
      city: "Delhi",
      state: "Delhi",
      pincode: "110001",
      packageWeightGrams: 800,
      paymentMode: "COD",
      codAmountPaise: 149900,
      pickupLocationId: "pickup_1"
    });
    const needsAttention = validateOrder({
      buyerName: "",
      buyerPhone: "123",
      addressLine1: "test",
      city: "",
      state: "",
      pincode: "000",
      paymentMode: "COD",
      codAmountPaise: 1_200_000,
      pickupLocationId: null
    });

    assert.equal(ready.status, "ready_to_ship");
    assert.equal(needsAttention.status, "needs_attention");
    assert.ok(needsAttention.needsAttentionReasons.includes("MISSING_BUYER_NAME"));
    assert.ok(needsAttention.needsAttentionReasons.includes("COD_AMOUNT_OVER_LIMIT"));
  });

  it("parses money formats and normalizes Indian state names", () => {
    assert.equal(parseAmountToPaise("₹1,299.00"), 129900);
    assert.equal(parseAmountToPaise("499.50"), 49950);
    assert.equal(normalizeStateName("DL"), "Delhi");
    assert.equal(normalizeStateName("mh"), "Maharashtra");
  });
});

describe("Phase 5B shipping order ingestion services", () => {
  it("creates a manual order and Shipment candidate-equivalent for ready_to_ship data", async () => {
    const { state, client } = createFakeClient();
    const order = await createShippingOrder("merchant_1", validOrder(), client);

    assert.equal(order.status, "ready_to_ship");
    assert.equal(order.shipment_candidate?.status, ShipmentStatus.draft);
    assert.equal(state.shipments.length, 1);
    assert.equal(state.shipments[0]?.paymentMode, ShippingPaymentMode.cod);
    assert.doesNotMatch(JSON.stringify(order), /courierOverride|providerOrder|bigship/i);
  });

  it("rejects duplicate external order IDs for manual creation", async () => {
    const { client } = createFakeClient();
    await createShippingOrder("merchant_1", validOrder(), client);
    await assert.rejects(
      () => createShippingOrder("merchant_1", validOrder(), client),
      /ORDER_ALREADY_EXISTS/
    );
  });

  it("marks weak manual orders needs_attention without creating a candidate", async () => {
    const { state, client } = createFakeClient();
    const order = await createShippingOrder("merchant_1", validOrder({
      externalOrderId: "ORD-weak",
      buyerPhone: "9876543210",
      pincode: "110001",
      packageWeight: undefined,
      addressLine1: "test",
      city: "",
      state: ""
    }), client);

    assert.equal(order.status, "needs_attention");
    assert.ok(order.needs_attention_reasons.includes("ADDRESS_QUALITY_LOW"));
    assert.equal(state.shipments.length, 0);
  });

  it("imports CSV rows, continues past invalid rows, and reports duplicates", async () => {
    const { state, client } = createFakeClient();
    const csv = Buffer.from([
      "Order ID,Buyer Name,Phone,Address Line 1,City,State,Pincode,Payment Mode,Order Amount,COD Amount,Weight (g),Length (mm),Width (mm),Height (mm),Product",
      "CSV-1,Rahul Sharma,9876543210,221 Market Street Delhi,Delhi,DL,110001,COD,\"₹1,299.00\",\"1,299\",800,120,100,80,Cotton shirt",
      "CSV-1,Rahul Sharma,9876543210,221 Market Street Delhi,Delhi,DL,110001,COD,1299,1299,800,120,100,80,Cotton shirt",
      "CSV-2,,123,test,,DL,000,COD,499.50,499.50,,,,,Sample"
    ].join("\n"));

    const result = await importShippingOrdersCsv({
      merchantId: "merchant_1",
      filename: "orders.csv",
      mimeType: "text/csv",
      buffer: csv
    }, client);

    assert.equal(result.imported, 1);
    assert.equal(result.failed, 2);
    assert.equal(state.orders[0]?.orderValue, 1299);
    assert.ok(result.errors.some((error) => error.field === "externalOrderId"));
    assert.ok(result.errors.some((error) => error.field === "buyerPhone"));
  });

  it("keeps pickup location updates scoped to the authenticated seller", async () => {
    const { client } = createFakeClient();

    await assert.rejects(
      () => updateShippingPickupLocation("merchant_2", "pickup_1", { name: "Wrong seller" }, client),
      /PICKUP_LOCATION_NOT_FOUND/
    );
    const updated = await updateShippingPickupLocation("merchant_1", "pickup_1", { is_default: true }, client);
    assert.equal(updated.pickup_location_id, "pickup_1");
    assert.equal(updated.is_default, true);
  });
});
