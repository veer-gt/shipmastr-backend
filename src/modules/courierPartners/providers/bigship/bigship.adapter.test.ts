import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BigshipAdapter } from "./bigship.adapter.js";
import { BigshipClient } from "./bigship.client.js";
import { BigshipConfigError, normalizeBigshipError } from "./bigship.errors.js";
import type {
  BigshipCancelOrderRequest,
  BigshipCourierRateRequest,
  BigshipDomesticB2COrderRequest,
  BigshipPlaceOrderRequest,
  BigshipSaveWarehouseRequest,
  BigshipTrackingRequest
} from "./bigship.types.js";

const forbiddenSensitiveTerms = /access_key|bearer|warehouseId|warehouse_id|MasterCustomOrderId|providerOrder|token|password/i;

function pickupInput() {
  return {
    sellerId: "seller_1",
    pickupLocationId: "pickup_1",
    name: "Main pickup",
    contactPerson: "Ops",
    phone: "9999999999",
    email: "ops@example.test",
    addressLine1: "Line 1",
    city: "Bengaluru",
    state: "KA",
    country: "IN",
    pincode: "560001"
  };
}

function draftOrderInput() {
  return {
    sellerId: "seller_1",
    shipmentId: "shipment_1",
    sellerOrderId: "order_1",
    segment: "domestic_b2c" as const,
    paymentMode: "cod" as const,
    pickupLocationProviderId: "mock_provider_pickup_001",
    invoiceNumber: "INV-1",
    invoiceAmount: 1499,
    collectableAmount: 1499,
    deadWeightKg: 0.8,
    dimensions: {
      lengthCm: 20,
      breadthCm: 15,
      heightCm: 10
    },
    buyer: {
      name: "Demo Buyer",
      phone: "9999999999",
      addressLine1: "Buyer line",
      city: "Mumbai",
      state: "MH",
      country: "IN",
      pincode: "400001"
    }
  };
}

function rateInput() {
  return {
    sellerId: "seller_1",
    shipmentId: "shipment_1",
    providerOrderId: "mock_provider_order_001",
    pickupPincode: "560001",
    deliveryPincode: "400001",
    paymentMode: "prepaid" as const,
    deadWeightKg: 0.8,
    dimensions: {
      lengthCm: 20,
      breadthCm: 15,
      heightCm: 10
    }
  };
}

function fakeClient() {
  const calls = {
    login: 0,
    saveWarehouse: 0,
    createDomesticB2COrder: 0,
    getRates: 0,
    placeOrder: 0,
    trackOrder: 0,
    cancelOrder: 0
  };
  const requests = {
    warehouse: null as BigshipSaveWarehouseRequest | null,
    order: null as BigshipDomesticB2COrderRequest | null,
    rates: null as BigshipCourierRateRequest | null,
    manifest: null as BigshipPlaceOrderRequest | null,
    tracking: null as BigshipTrackingRequest | null,
    cancel: null as BigshipCancelOrderRequest | null
  };

  return {
    calls,
    requests,
    client: {
      login: async () => {
        calls.login += 1;
        return {
          token: `fake_internal_token_${calls.login}`,
          expires_in: 120
        };
      },
      saveWarehouse: async (input: BigshipSaveWarehouseRequest) => {
        calls.saveWarehouse += 1;
        requests.warehouse = input;
        return {
          warehouseId: "mock_provider_pickup_001",
          status: "active",
          message: "saved"
        };
      },
      createDomesticB2COrder: async (input: BigshipDomesticB2COrderRequest) => {
        calls.createDomesticB2COrder += 1;
        requests.order = input;
        return {
          order_id: "mock_provider_order_001",
          reference_number: "mock_ref_001",
          status: "draft",
          message: "created"
        };
      },
      getRates: async (input: BigshipCourierRateRequest) => {
        calls.getRates += 1;
        requests.rates = input;
        return {
          rates: [{
            courierId: "courier_economy",
            total_charge: 80,
            charged_weight: 0.8,
            tat_days: 5
          }, {
            courierId: "courier_smart",
            total_charge: 110,
            charged_weight: 0.8,
            tat_days: 3,
            recommended: true
          }, {
            courierId: "courier_express",
            total_charge: 150,
            charged_weight: 0.8,
            tat_days: 1
          }]
        };
      },
      placeOrder: async (input: BigshipPlaceOrderRequest) => {
        calls.placeOrder += 1;
        requests.manifest = input;
        return {
          awb_assigned: "mock_awb_001",
          tracking_number: "mock_awb_001",
          reference_number: "mock_manifest_001",
          status: "manifested",
          message: "manifested"
        };
      },
      trackOrder: async (input: BigshipTrackingRequest) => {
        calls.trackOrder += 1;
        requests.tracking = input;
        return {
          awb: input.awb ?? "mock_awb_001",
          tracking_number: input.tracking_number ?? "mock_awb_001",
          status: "out_for_delivery",
          latest_event: "Out for delivery",
          events: [{
            status: "picked_up",
            public_status: "Picked up",
            message: "Picked up",
            checkpoint_time: "2026-06-06T09:00:00.000Z"
          }, {
            status: "out_for_delivery",
            public_status: "Out for delivery",
            message: "Out for delivery",
            checkpoint_time: "2026-06-06T12:00:00.000Z"
          }]
        };
      },
      cancelOrder: async (input: BigshipCancelOrderRequest) => {
        calls.cancelOrder += 1;
        requests.cancel = input;
        return {
          cancelled: true,
          status: "cancelled",
          message: "cancelled"
        };
      }
    }
  };
}

describe("Bigship internal adapter", () => {
  it("login uses the injected client", async () => {
    const fake = fakeClient();
    const adapter = new BigshipAdapter({ client: fake.client });

    const token = await adapter.login();

    assert.equal(fake.calls.login, 1);
    assert.equal(token.token, "fake_internal_token_1");
    assert.ok(token.expiresAt > new Date());
  });

  it("ensureToken caches token until the refresh window", async () => {
    const fake = fakeClient();
    let now = new Date("2026-06-06T10:00:00.000Z");
    const adapter = new BigshipAdapter({
      client: fake.client,
      now: () => now,
      refreshWindowMs: 60_000
    });

    const first = await adapter.ensureToken();
    now = new Date("2026-06-06T10:00:30.000Z");
    const second = await adapter.ensureToken();

    assert.equal(fake.calls.login, 1);
    assert.equal(first.token, second.token);
  });

  it("ensureToken refreshes after expiry approaches", async () => {
    const fake = fakeClient();
    let now = new Date("2026-06-06T10:00:00.000Z");
    const adapter = new BigshipAdapter({
      client: fake.client,
      now: () => now,
      refreshWindowMs: 60_000
    });

    const first = await adapter.ensureToken();
    now = new Date("2026-06-06T10:01:10.000Z");
    const second = await adapter.ensureToken();

    assert.equal(fake.calls.login, 2);
    assert.notEqual(first.token, second.token);
  });

  it("mock mode works without credentials", async () => {
    const adapter = new BigshipAdapter({
      client: new BigshipClient({
        enabled: false,
        mockMode: true
      })
    });

    const pickup = await adapter.createPickupLocation(pickupInput());
    const rates = await adapter.getRates(rateInput());

    assert.equal(pickup.providerPickupId, "mock_provider_pickup_001");
    assert.deepEqual(rates.map((rate) => rate.serviceLevel).sort(), [
      "Shipmastr Economy",
      "Shipmastr Express",
      "Shipmastr Smart"
    ]);
  });

  it("real mode without credentials throws a safe config error", async () => {
    const client = new BigshipClient({
      enabled: true,
      mockMode: false
    });

    await assert.rejects(() => client.login(), BigshipConfigError);
  });

  it("createPickupLocation maps the internal pickup result", async () => {
    const fake = fakeClient();
    const adapter = new BigshipAdapter({ client: fake.client });

    const result = await adapter.createPickupLocation(pickupInput());

    assert.equal(fake.calls.saveWarehouse, 1);
    assert.equal(fake.requests.warehouse?.warehouseName, "Main pickup");
    assert.equal(result.providerPickupId, "mock_provider_pickup_001");
    assert.equal(result.status, "active");
  });

  it("createDraftOrder maps a domestic_b2c shipment", async () => {
    const fake = fakeClient();
    const adapter = new BigshipAdapter({ client: fake.client });

    const result = await adapter.createDraftOrder(draftOrderInput());

    assert.equal(fake.calls.createDomesticB2COrder, 1);
    assert.equal(fake.requests.order?.MasterCustomOrderId, "order_1");
    assert.equal(fake.requests.order?.MasterOrderCollectableAmount, 1499);
    assert.equal(result.providerOrderId, "mock_provider_order_001");
  });

  it("getRates maps raw rates to Smart, Economy, and Express", async () => {
    const fake = fakeClient();
    const adapter = new BigshipAdapter({ client: fake.client });

    const rates = await adapter.getRates(rateInput());

    assert.equal(fake.calls.getRates, 1);
    assert.deepEqual(rates.map((rate) => rate.serviceLevel).sort(), [
      "Shipmastr Economy",
      "Shipmastr Express",
      "Shipmastr Smart"
    ]);
    assert.equal(rates.find((rate) => rate.serviceLevel === "Shipmastr Economy")?.totalCharge, 80);
    assert.equal(rates.find((rate) => rate.serviceLevel === "Shipmastr Express")?.tatDays, 1);
    assert.equal(rates.find((rate) => rate.serviceLevel === "Shipmastr Smart")?.providerCourierId, "courier_smart");
  });

  it("manifestOrder maps AWB and reference values", async () => {
    const fake = fakeClient();
    const adapter = new BigshipAdapter({ client: fake.client });

    const result = await adapter.manifestOrder({
      sellerId: "seller_1",
      shipmentId: "shipment_1",
      providerOrderId: "mock_provider_order_001",
      providerCourierId: "courier_smart"
    });

    assert.equal(fake.calls.placeOrder, 1);
    assert.equal(result.awb, "mock_awb_001");
    assert.equal(result.trackingNumber, "mock_awb_001");
    assert.equal(result.status, "manifested");
  });

  it("trackOrder normalizes statuses", async () => {
    const fake = fakeClient();
    const adapter = new BigshipAdapter({ client: fake.client });

    const result = await adapter.trackOrder({ awb: "mock_awb_001" });

    assert.equal(fake.calls.trackOrder, 1);
    assert.equal(result.status, "out_for_delivery");
    assert.equal(result.publicStatus, "Out for delivery");
    assert.equal(result.events.length, 2);
  });

  it("cancelOrder normalizes cancellation", async () => {
    const fake = fakeClient();
    const adapter = new BigshipAdapter({ client: fake.client });

    const result = await adapter.cancelOrder({ awb: "mock_awb_001", reason: "Seller request" });

    assert.equal(fake.calls.cancelOrder, 1);
    assert.equal(result.cancelled, true);
    assert.equal(result.status, "cancelled");
  });

  it("errors are safe and redacted", () => {
    const normalized = normalizeBigshipError({
      statusCode: 503,
      headers: { authorization: "Bearer secret" },
      body: {
        access_key: "secret",
        token: "secret",
        password: "secret"
      }
    });

    const json = JSON.stringify(normalized);
    assert.equal(normalized.code, "COURIER_PROVIDER_ERROR");
    assert.equal(normalized.retryable, true);
    assert.doesNotMatch(json, forbiddenSensitiveTerms);
  });
});
