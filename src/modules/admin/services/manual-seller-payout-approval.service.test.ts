import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSellerSafeOrders } from "../../orders/orders.routes.js";
import { approveManualSellerPayout } from "./manual-seller-payout-approval.service.js";

type ApprovalClient = Parameters<typeof approveManualSellerPayout>[1];
type SellerOrderInput = Parameters<typeof buildSellerSafeOrders>[0]["orders"][number];

const now = new Date("2026-06-05T10:00:00.000Z");

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
  settlement?: Record<string, unknown> | null;
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
    remittances: overrides.remittance === null ? [] : [
      overrides.remittance ?? {
        id: "cod_remittance_1",
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
        rawPayload: {},
        createdAt: now,
        updatedAt: now
      }
    ],
    results: overrides.result === null ? [] : [
      overrides.result ?? {
        id: "reconciliation_result_1",
        runId: "run_1",
        merchantId: "merchant_1",
        courierId: "courier_1",
        orderId: "order_internal_cod_1",
        externalOrderId: "seller-demo-mpzrjxf5-c30a8ee4",
        awb: "DEMO-COD-AWB-1001",
        status: "AUTO_APPROVED",
        expectedCodAmount: 1499,
        remittedCodAmount: 1499,
        sellerPayable: null,
        courierPayable: null,
        mismatchAmount: 0,
        disputeAmount: 0,
        paymentHoldAmount: 0,
        reasons: ["MANUAL_COD_REMITTANCE_RECONCILED"],
        metadata: {},
        createdAt: now,
        updatedAt: now
      }
    ],
    settlements: overrides.settlement === null ? [] : overrides.settlement ? [overrides.settlement] : [],
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
            ("awb" in clause && remittance.awb === clause.awb) ||
            ("orderId" in clause && remittance.orderId === clause.orderId) ||
            ("externalOrderId" in clause && remittance.externalOrderId === clause.externalOrderId)
          ))
        )) ?? null;
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
      }
    },
    sellerSettlement: {
      findFirst: async ({ where }: { where: { merchantId: string; OR?: Array<Record<string, string>> } }) => {
        const clauses = where.OR ?? [];
        return state.settlements.find((settlement) => (
          settlement.merchantId === where.merchantId &&
          clauses.some((clause) => (
            ("awb" in clause && settlement.awb === clause.awb) ||
            ("orderId" in clause && settlement.orderId === clause.orderId)
          ))
        )) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const settlement = {
          id: `seller_settlement_${state.settlements.length + 1}`,
          createdAt: now,
          updatedAt: now,
          settledAt: null,
          ...data
        };
        state.settlements.push(settlement);
        return settlement;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const settlement = state.settlements.find((item) => item.id === where.id);
        if (!settlement) throw new Error("SELLER_SETTLEMENT_NOT_FOUND");
        Object.assign(settlement, data, { updatedAt: now });
        return settlement;
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

  return { client: client as unknown as NonNullable<ApprovalClient>, state };
}

describe("manual seller payout approval", () => {
  it("approves reconciled delivered COD for payout review without marking it paid", async () => {
    const { client, state } = makeClient();

    const result = await approveManualSellerPayout({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      approvalReference: "PAYOUT-REVIEW-1001",
      remarks: "Ready for finance review",
      actorId: "admin_1"
    }, client);

    assert.equal(result.idempotent, false);
    assert.equal(result.payout.status, "approved_for_review");
    assert.equal(result.payout.settlementStatus, "APPROVED");
    assert.equal(result.payout.paid, false);
    assert.equal(result.payout.payoutMoved, false);
    assert.equal(state.settlements.length, 1);
    assert.equal(state.settlements[0]?.status, "APPROVED");
    assert.equal(state.settlements[0]?.sellerPayable, 1499);
    assert.equal(state.settlements[0]?.settledAt, null);
    assert.equal(state.auditLogs[0]?.action, "ADMIN_SELLER_PAYOUT_APPROVED_FOR_REVIEW");

    const serialized = JSON.stringify({ result, audit: state.auditLogs[0] });
    assert.equal(/buyerPhone|addressLine|otp|secret|token|provider|rawPayload|bank/i.test(serialized), false);
  });

  it("rejects unreconciled COD", async () => {
    const { client } = makeClient({ remittance: null });

    await assert.rejects(
      approveManualSellerPayout({
        awbNumber: "DEMO-COD-AWB-1001",
        amount: 1499,
        actorId: "admin_1"
      }, client),
      /COD_REMITTANCE_NOT_RECONCILED/
    );
  });

  it("rejects prepaid shipments through the COD payout path", async () => {
    const { client } = makeClient({
      shipment: { paymentMode: "PREPAID", codAmount: 0 },
      order: { paymentMode: "PREPAID", codAmount: 0 }
    });

    await assert.rejects(
      approveManualSellerPayout({
        awbNumber: "DEMO-COD-AWB-1001",
        amount: 1499,
        actorId: "admin_1"
      }, client),
      /SHIPMENT_NOT_COD/
    );
  });

  it("is idempotent for a previously approved AWB and approval reference", async () => {
    const { client, state } = makeClient({
      settlement: {
        id: "seller_settlement_existing",
        merchantId: "merchant_1",
        orderId: "order_internal_cod_1",
        awb: "DEMO-COD-AWB-1001",
        reconciliationResultId: "reconciliation_result_1",
        status: "APPROVED",
        codCollected: 1499,
        sellerPayable: 1499,
        approvedAt: now,
        settledAt: null,
        metadata: {
          approvalReference: "PAYOUT-REVIEW-1001",
          payoutMoved: false,
          paid: false
        },
        createdAt: now,
        updatedAt: now
      }
    });

    const result = await approveManualSellerPayout({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      approvalReference: "PAYOUT-REVIEW-1001",
      actorId: "admin_1"
    }, client);

    assert.equal(result.idempotent, true);
    assert.equal(state.settlements.length, 1);
    assert.equal(state.auditLogs[0]?.action, "ADMIN_SELLER_PAYOUT_APPROVAL_IDEMPOTENT");
  });

  it("makes seller finance order mapping reflect approved-not-paid payout state", async () => {
    const { client, state } = makeClient();
    await approveManualSellerPayout({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      approvalReference: "PAYOUT-REVIEW-1001",
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
      })),
      sellerSettlements: state.settlements.map((settlement) => ({
        merchantId: String(settlement.merchantId),
        orderId: String(settlement.orderId),
        awb: String(settlement.awb),
        status: String(settlement.status),
        sellerPayable: settlement.sellerPayable,
        approvedAt: settlement.approvedAt as Date,
        settledAt: settlement.settledAt as Date | null,
        createdAt: settlement.createdAt as Date,
        updatedAt: settlement.updatedAt as Date
      }))
    });

    assert.equal(order?.codRemittanceStatus, "reconciled");
    assert.equal(order?.sellerPayoutReadiness, "approved_for_review");
    assert.equal(order?.sellerPayoutApprovalStatus, "approved_not_paid");
    assert.equal(order?.sellerPayoutApprovedAmount, 1499);
    assert.equal(order?.sellerPayoutPaid, false);
    assert.equal("sellerSettlementId" in (order ?? {}), false);
  });

  it("keeps seller payout approval mounted behind admin JWT", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const adminRoutes = readFileSync("src/modules/admin/admin.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/admin", requireAdminJwt, adminRouter\);/);
    assert.match(adminRoutes, /adminRouter\.post\("\/finance\/seller-payouts\/approve"/);
  });
});
