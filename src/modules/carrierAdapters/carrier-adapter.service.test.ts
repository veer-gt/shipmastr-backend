import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getCarrierAdapter
} from "./carrier-adapter.factory.js";
import {
  applyCarrierTrackingUpdate
} from "./carrier-tracking.service.js";
import {
  manualCarrierAdapter,
  mockQaCarrierAdapter
} from "./manual-carrier.adapter.js";

const now = new Date("2026-05-09T10:00:00.000Z");

function makeTrackingClient() {
  const state = {
    shipments: [{
      id: "shipment_1",
      courierId: "courier_1",
      orderId: "order_1",
      awbNumber: "QA-AWB-0001",
      status: "pickup_scheduled",
      lastEvent: "Created",
      updatedAt: now
    }] as any[],
    events: [] as any[],
    auditLogs: [] as any[]
  };

  const client = {
    $transaction: async (callback: any) => callback(client),
    courierShipment: {
      findUnique: async ({ where }: any) => (
        state.shipments.find((shipment) => shipment.awbNumber === where.awbNumber) ?? null
      ),
      findFirst: async ({ where }: any) => (
        state.shipments.find((shipment) => shipment.orderId === where.orderId) ?? null
      ),
      update: async ({ where, data }: any) => {
        const shipment = state.shipments.find((item) => item.id === where.id);
        if (!shipment) throw new Error("SHIPMENT_NOT_FOUND");
        Object.assign(shipment, {
          status: data.status,
          lastEvent: data.lastEvent,
          updatedAt: now
        });
        if (data.events?.create) {
          state.events.push({
            id: `event_${state.events.length + 1}`,
            courierShipmentId: shipment.id,
            createdAt: now,
            ...data.events.create
          });
        }
        return shipment;
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

describe("carrier adapter foundation", () => {
  it("exposes the full carrier adapter contract without live booking support", async () => {
    const adapter = manualCarrierAdapter;

    assert.equal(typeof adapter.quote, "function");
    assert.equal(typeof adapter.createShipment, "function");
    assert.equal(typeof adapter.cancelShipment, "function");
    assert.equal(typeof adapter.trackShipment, "function");
    assert.equal(typeof adapter.parseWebhook, "function");
    assert.equal(adapter.supportsLiveBooking, false);

    const quote = await adapter.quote({
      pickupPincode: "400001",
      deliveryPincode: "560001",
      weightGrams: 500,
      paymentMode: "PREPAID"
    });

    assert.equal(quote.manualFallback, true);
    assert.equal(quote.manualFallbackStatus, "MANUAL_QUOTE_REQUIRED");
    assert.equal(quote.amount, null);
  });

  it("uses mock QA booking without pretending to call a real courier API", async () => {
    const booking = await mockQaCarrierAdapter.createShipment({
      merchantId: "merchant_qa",
      orderId: "qa-order-1",
      pickupPincode: "400001",
      deliveryPincode: "560001",
      weightGrams: 750,
      paymentMode: "COD",
      codAmountPaise: 129900,
      courierPreference: "QA manual lane"
    });

    assert.equal(booking.mode, "mock");
    assert.equal(booking.status, "BOOKED_MANUALLY");
    assert.match(booking.awb ?? "", /^QA-MOCK-AWB-/);
    assert.equal(booking.labelUrl, null);
    assert.equal(booking.metadata.mockOnly, true);
    assert.match(booking.message, /No real courier API was called/);
  });

  it("parses generic carrier webhook payloads through the adapter", async () => {
    const parsed = await manualCarrierAdapter.parseWebhook({
      externalId: "evt_1",
      eventType: "shipment.delivered",
      awbNumber: "QA-AWB-0001",
      orderId: "order_1",
      latestEvent: "Delivered to buyer",
      location: "Bengaluru"
    }, { receivedAt: now });

    assert.equal(parsed.externalId, "evt_1");
    assert.equal(parsed.eventType, "shipment.delivered");
    assert.equal(parsed.status, "delivered");
    assert.equal(parsed.awbNumber, "QA-AWB-0001");
    assert.equal(parsed.receivedAt, now.toISOString());
  });

  it("persists tracking updates and writes an audit log", async () => {
    const { client, state } = makeTrackingClient();

    const result = await applyCarrierTrackingUpdate({
      awbNumber: "QA-AWB-0001",
      status: "in_transit",
      eventType: "shipment.in_transit",
      latestEvent: "QA package moved through hub",
      location: "QA hub",
      actorId: "admin_1",
      rawPayload: { externalId: "evt_2" }
    }, client);

    assert.equal(result.updated, true);
    assert.equal(state.shipments[0]?.status, "in_transit");
    assert.equal(state.events[0]?.status, "in_transit");
    assert.equal(state.events[0]?.rawPayload.externalId, "evt_2");
    assert.equal(state.auditLogs[0]?.action, "CARRIER_TRACKING_UPDATE_RECORDED");
    assert.equal(state.auditLogs[0]?.metadata.fromStatus, "pickup_scheduled");
    assert.equal(state.auditLogs[0]?.metadata.toStatus, "in_transit");
  });

  it("blocks the mock adapter in production-like runtime settings", () => {
    assert.throws(() => getCarrierAdapter({
      provider: "mock",
      appEnv: "production",
      nodeEnv: "production"
    }), /CARRIER_MOCK_PROVIDER_NOT_ALLOWED_IN_PRODUCTION/);

    assert.equal(getCarrierAdapter({
      provider: "mock",
      appEnv: "test",
      nodeEnv: "test"
    }).name, "mock-qa-courier");
  });
});
