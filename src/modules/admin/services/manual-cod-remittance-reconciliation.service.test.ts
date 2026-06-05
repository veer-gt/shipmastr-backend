import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSellerSafeOrders } from "../../orders/orders.routes.js";
import { reconcileManualCodRemittance } from "./manual-cod-remittance-reconciliation.service.js";

type ReconcileClient = Parameters<typeof reconcileManualCodRemittance>[1];
type SellerOrderInput = Parameters<typeof buildSellerSafeOrders>[0]["orders"][number];

const now = new Date("2026-06-04T10:00:00.000Z");

function makeOrder(overrides: Partial<SellerOrderInput> = {}) {
  return {
    id: "order_internal_cod_1",
    merchantId: "merchant_1",
    externalOrderId: "seller-demo-mpzrjxf5-c30a8ee4",
    buyerName: "Demo Buyer",
    city: "Mumbai",
    state: "MH",
    pincode: "400001",
    orderValue: 1499,
    codAmount: 1499,
    paymentMode: "COD",
    weightGrams: 800,
    status: "CREATED",
    createdAt: now,
    updatedAt: now,
    shipmentDetails: null,
    ...overrides
  };
}

function makeClient(overrides: {
  shipment?: Record<string, unknown>;
  order?: Partial<ReturnType<typeof makeOrder>> | null;
  remittance?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
} = {}) {
  const state = {
    shipments: [
      {
        id: "shipment_cod_1",
        courierId: "courier_1",
        orderId: "seller-demo-mpzrjxf5-c30a8ee4",
        awbNumber: "DEMO-COD-AWB-1001",
        status: "delivered",
        paymentMode: "COD",
        codAmount: 1499,
        createdAt: now,
        updatedAt: now,
        courier: {
          id: "courier_1",
          name: "Shipmastr Manual Courier",
          code: "MANUAL"
        },
        ...overrides.shipment
      }
    ],
    orders: overrides.order === null ? [] : [makeOrder(overrides.order)],
    remittances: overrides.remittance === null ? [] : overrides.remittance ? [overrides.remittance] : [],
    runs: [] as Array<Record<string, unknown>>,
    results: overrides.result === null ? [] : overrides.result ? [overrides.result] : [],
    auditLogs: [] as Array<Record<string, unknown>>
  };

  const client = {
    $transaction: async (callback: (tx: unknown) => unknown) => callback(client),
    courierShipment: {
      findFirst: async ({ where }: { where: { OR?: Array<Record<string, string>> } }) => {
        const clauses = where.OR ?? [];
        return state.shipments.find((shipment) => clauses.some((clause) => (
          ("awbNumber" in clause && shipment.awbNumber === clause.awbNumber) ||
          ("id" in clause && shipment.id === clause.id)
        ))) ?? null;
      }
    },
    order: {
      findFirst: async ({ where }: { where: { OR?: Array<Record<string, string>> } }) => {
        const clauses = where.OR ?? [];
        return state.orders.find((order) => clauses.some((clause) => (
          ("id" in clause && order.id === clause.id) ||
          ("externalOrderId" in clause && order.externalOrderId === clause.externalOrderId)
        ))) ?? null;
      }
    },
    codRemittance: {
      findFirst: async ({ where }: { where: { merchantId: string; OR?: Array<Record<string, string>> } }) => {
        const clauses = where.OR ?? [];
        return state.remittances.find((remittance) => (
          remittance.merchantId === where.merchantId &&
          clauses.some((clause) => (
            ("awb" in clause && remittance.awb === clause.awb && !("utr" in clause) && !("status" in clause)) ||
            ("awb" in clause && "utr" in clause && remittance.awb === clause.awb && remittance.utr === clause.utr) ||
            ("awb" in clause && "status" in clause && remittance.awb === clause.awb && remittance.status === clause.status)
          ))
        )) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const remittance = {
          id: `cod_remittance_${state.remittances.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.remittances.push(remittance);
        return remittance;
      }
    },
    reconciliationRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const run = {
          id: `reconciliation_run_${state.runs.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.runs.push(run);
        return run;
      }
    },
    reconciliationResult: {
      findFirst: async ({ where }: { where: { merchantId: string; OR?: Array<Record<string, string>> } }) => {
        const clauses = where.OR ?? [];
        return state.results.find((result) => (
          result.merchantId === where.merchantId &&
          clauses.some((clause) => (
            ("awb" in clause && result.awb === clause.awb) ||
            ("orderId" in clause && result.orderId === clause.orderId) ||
            ("externalOrderId" in clause && result.externalOrderId === clause.externalOrderId)
          ))
        )) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const result = {
          id: `reconciliation_result_${state.results.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.results.push(result);
        return result;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const result = state.results.find((item) => item.id === where.id);
        if (!result) throw new Error("RECONCILIATION_RESULT_NOT_FOUND");
        Object.assign(result, data, { updatedAt: now });
        return result;
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

  return { client: client as unknown as NonNullable<ReconcileClient>, state };
}

describe("manual COD remittance reconciliation", () => {
  it("reconciles a delivered COD AWB without moving payout money", async () => {
    const { client, state } = makeClient();

    const result = await reconcileManualCodRemittance({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      receivedAt: now,
      referenceNumber: "UTR-DEMO-1001",
      remarks: "Manual courier remittance received",
      actorId: "admin_1"
    }, client);

    assert.equal(result.idempotent, false);
    assert.equal(result.remittance.status, "reconciled");
    assert.equal(result.remittance.persistence, "DATABASE");
    assert.equal(result.reconciliationResult.status, "AUTO_APPROVED");
    assert.equal(result.reconciliationResult.nextStep, "SELLER_FINANCE_RECONCILED");
    assert.equal(state.remittances.length, 1);
    assert.equal(state.results.length, 1);
    assert.equal(state.auditLogs[0]?.action, "ADMIN_MANUAL_COD_REMITTANCE_RECONCILED");
    assert.equal((state.auditLogs[0]?.metadata as Record<string, unknown>)?.payoutMoved, false);

    const serialized = JSON.stringify({ result, audit: state.auditLogs[0] });
    assert.equal(/buyerPhone|addressLine|otp|secret|token|provider|rawPayload/i.test(serialized), false);
  });

  it("rejects prepaid shipments", async () => {
    const { client } = makeClient({
      shipment: { paymentMode: "PREPAID", codAmount: 0 }
    });

    await assert.rejects(
      reconcileManualCodRemittance({
        awbNumber: "DEMO-COD-AWB-1001",
        amount: 1499,
        actorId: "admin_1"
      }, client),
      /SHIPMENT_NOT_COD/
    );
  });

  it("rejects undelivered COD shipments", async () => {
    const { client } = makeClient({
      shipment: { status: "in_transit" }
    });

    await assert.rejects(
      reconcileManualCodRemittance({
        awbNumber: "DEMO-COD-AWB-1001",
        amount: 1499,
        actorId: "admin_1"
      }, client),
      /SHIPMENT_NOT_DELIVERED/
    );
  });

  it("is idempotent for an existing AWB and reference", async () => {
    const { client, state } = makeClient({
      remittance: {
        id: "cod_remittance_existing",
        merchantId: "merchant_1",
        courierId: "courier_1",
        awb: "DEMO-COD-AWB-1001",
        orderId: "order_internal_cod_1",
        externalOrderId: "seller-demo-mpzrjxf5-c30a8ee4",
        codAmount: 1499,
        remittedAmount: 1499,
        remittedAt: now,
        utr: "UTR-DEMO-1001",
        status: "manual_reconciled",
        createdAt: now,
        updatedAt: now
      }
    });

    const result = await reconcileManualCodRemittance({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      receivedAt: now,
      referenceNumber: "UTR-DEMO-1001",
      actorId: "admin_1"
    }, client);

    assert.equal(result.idempotent, true);
    assert.equal(state.remittances.length, 1);
    assert.equal(result.remittance.id, "cod_remittance_existing");
  });

  it("makes seller finance order mapping reflect reconciled COD state", async () => {
    const { client, state } = makeClient();
    await reconcileManualCodRemittance({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      receivedAt: now,
      referenceNumber: "UTR-DEMO-1001",
      actorId: "admin_1"
    }, client);

    const [order] = buildSellerSafeOrders({
      orders: state.orders,
      courierShipments: state.shipments.map((shipment) => ({
        ...shipment,
        awbNumber: String(shipment.awbNumber),
        trackingUrl: null,
        weightGrams: 800,
        firstShipmentRequest: null,
        courier: {
          id: "courier_1",
          name: "Shipmastr Manual Courier",
          code: "MANUAL"
        }
      })),
      codRemittances: state.remittances.map((remittance) => ({
        id: String(remittance.id),
        merchantId: String(remittance.merchantId),
        awb: String(remittance.awb),
        orderId: String(remittance.orderId),
        externalOrderId: String(remittance.externalOrderId),
        remittedAmount: remittance.remittedAmount,
        remittedAt: remittance.remittedAt as Date,
        utr: String(remittance.utr),
        status: String(remittance.status),
        createdAt: remittance.createdAt as Date,
        updatedAt: remittance.updatedAt as Date
      }))
    });

    assert.equal(order?.codRemittanceStatus, "reconciled");
    assert.equal(order?.codRemittanceReadiness, "reconciled");
    assert.equal(order?.codRemittedAmount, 1499);
    assert.equal("codRemittanceReference" in (order ?? {}), false);
  });

  it("keeps manual reconciliation mounted behind admin JWT", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const adminRoutes = readFileSync("src/modules/admin/admin.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/admin", requireAdminJwt, adminRouter\);/);
    assert.match(adminRoutes, /adminRouter\.post\("\/finance\/cod-remittances\/reconcile"/);
  });
});
