import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSellerSafeOrders } from "../../orders/orders.routes.js";
import { publicTrackingEvents } from "../../tracking/tracking.routes.js";
import { updateManualShipmentStatus } from "./manual-shipment-status.service.js";

type ManualShipmentTestClient = Parameters<typeof updateManualShipmentStatus>[1];
type SellerOrderInput = Parameters<typeof buildSellerSafeOrders>[0]["orders"][number];
type TestCourierEvent = {
  id: string;
  courierShipmentId: string;
  courierId: string;
  courierUserId: string | null;
  eventType: string;
  status: string;
  location: string | null;
  remarks: string | null;
  rawPayload: null;
  createdAt: Date;
};

const now = new Date("2026-06-04T10:00:00.000Z");

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
    createdAt: now,
    updatedAt: now,
    shipmentDetails: null,
    ...overrides
  };
}

function makeClient() {
  const state = {
    shipments: [
      {
        id: "shipment_1",
        courierId: "courier_1",
        orderId: "seller-demo-mpz1vdlw-e041cc26",
        awbNumber: "DEMO-AWB-1001",
        status: "ready_to_ship",
        fromPincode: "201301",
        toPincode: "400001",
        weightGrams: 800,
        paymentMode: "PREPAID",
        trackingUrl: "https://shipmastr.com/tracking/?awb=DEMO-AWB-1001",
        lastEvent: "Shipment assigned to courier",
        createdAt: now,
        updatedAt: now,
        courier: {
          id: "courier_1",
          name: "Shipmastr Manual Courier",
          code: "MANUAL"
        },
        events: [
          {
            id: "event_1",
            courierShipmentId: "shipment_1",
            courierId: "courier_1",
            courierUserId: "admin_1",
            eventType: "shipment_assigned",
            status: "ready_to_ship",
            location: null,
            remarks: "Shipment assigned to courier",
            rawPayload: null,
            createdAt: now
          }
        ] as TestCourierEvent[]
      }
    ],
    auditLogs: [] as Array<Record<string, unknown>>
  };

  function shipmentWithIncludes(shipment: (typeof state.shipments)[number]) {
    return {
      ...shipment,
      courier: shipment.courier,
      events: [...shipment.events].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    };
  }

  const client = {
    $transaction: async (callback: (tx: unknown) => unknown) => callback(client),
    courierShipment: {
      findFirst: async ({ where }: { where: { OR?: Array<Record<string, string>> } }) => {
        const clauses = where.OR ?? [];
        return state.shipments.find((shipment) => clauses.some((clause) => (
          ("id" in clause && shipment.id === clause.id) ||
          ("awbNumber" in clause && shipment.awbNumber === clause.awbNumber)
        ))) ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: {
        status: string;
        lastEvent: string;
        events?: {
          create?: {
            courierId: string;
            courierUserId?: string | null;
            eventType: string;
            status: string;
            location?: string | null;
            remarks?: string | null;
          };
        };
      } }) => {
        const shipment = state.shipments.find((item) => item.id === where.id);
        if (!shipment) throw new Error("SHIPMENT_NOT_FOUND");

        shipment.status = data.status;
        shipment.lastEvent = data.lastEvent;
        shipment.updatedAt = now;
        if (data.events?.create) {
          const eventInput = data.events.create;
          shipment.events.push({
            id: `event_${shipment.events.length + 1}`,
            courierShipmentId: shipment.id,
            rawPayload: null,
            createdAt: now,
            courierId: eventInput.courierId,
            courierUserId: eventInput.courierUserId ?? null,
            eventType: eventInput.eventType,
            status: eventInput.status,
            location: eventInput.location ?? null,
            remarks: eventInput.remarks ?? null
          });
        }

        return shipmentWithIncludes(shipment);
      }
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const log = {
          id: `audit_${state.auditLogs.length + 1}`,
          createdAt: now,
          ...data
        };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as unknown as NonNullable<ManualShipmentTestClient>, state };
}

describe("manual shipment status updates", () => {
  it("updates shipment status, creates a timeline event, and writes a safe audit log", async () => {
    const { client, state } = makeClient();

    const result = await updateManualShipmentStatus({
      shipmentIdOrAwb: "DEMO-AWB-1001",
      actorId: "admin_1",
      status: "in_transit",
      eventType: "manual_scan",
      location: "Noida hub",
      remarks: "Shipment scanned at Noida hub"
    }, client);

    assert.equal(result.previousStatus, "ready_to_ship");
    assert.equal(result.shipment.status, "in_transit");
    assert.equal(result.shipment.lastEvent, "Shipment scanned at Noida hub");
    assert.equal(result.shipment.events.length, 2);
    assert.equal(result.shipment.events.at(-1)?.status, "in_transit");
    assert.equal(result.shipment.events.at(-1)?.location, "Noida hub");
    assert.equal(result.shipment.events.at(-1)?.remarks, "Shipment scanned at Noida hub");
    assert.equal(state.auditLogs[0]?.action, "ADMIN_MANUAL_SHIPMENT_STATUS_UPDATED");
    assert.equal((state.auditLogs[0]?.metadata as Record<string, unknown>)?.source, "admin_manual_status_update");

    const serialized = JSON.stringify({
      event: result.shipment.events.at(-1),
      audit: state.auditLogs[0]
    });
    assert.equal(/buyerPhone|raw address|otp|secret|token|Authorization/i.test(serialized), false);
  });

  it("makes the latest manual event visible in the public tracking timeline", async () => {
    const { client } = makeClient();

    const result = await updateManualShipmentStatus({
      shipmentIdOrAwb: "shipment_1",
      actorId: "admin_1",
      status: "out_for_delivery",
      location: "Mumbai delivery hub",
      remarks: "Shipment is out for delivery"
    }, client);
    const events = publicTrackingEvents(result.shipment);

    assert.equal(events.at(-1)?.status, "out_for_delivery");
    assert.equal(events.at(-1)?.location, "Mumbai delivery hub");
    assert.equal(events.at(-1)?.description, "Shipment is out for delivery");
  });

  it("lets seller order mapping read the latest shipment status", async () => {
    const { client } = makeClient();

    const result = await updateManualShipmentStatus({
      shipmentIdOrAwb: "DEMO-AWB-1001",
      actorId: "admin_1",
      status: "delivered",
      remarks: "Shipment delivered"
    }, client);
    const [order] = buildSellerSafeOrders({
      orders: [makeOrder()],
      courierShipments: [result.shipment]
    });

    assert.equal(order?.awbNumber, "DEMO-AWB-1001");
    assert.equal(order?.carrier, "Shipmastr Manual Courier");
    assert.equal(order?.shipmentStatus, "delivered");
  });

  it("returns a safe not-found error when the shipment does not exist", async () => {
    const { client } = makeClient();

    await assert.rejects(
      updateManualShipmentStatus({
        shipmentIdOrAwb: "UNKNOWN-AWB",
        actorId: "admin_1",
        status: "in_transit"
      }, client),
      /SHIPMENT_NOT_FOUND/
    );
  });

  it("keeps the admin shipment status route mounted behind admin JWT", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const adminRoutes = readFileSync("src/modules/admin/admin.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/admin", requireAdminJwt, adminRouter\);/);
    assert.match(adminRoutes, /adminRouter\.patch\("\/shipments\/:id\/status"/);
  });
});
