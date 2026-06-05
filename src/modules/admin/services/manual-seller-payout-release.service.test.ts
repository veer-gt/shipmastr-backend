import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSellerSafeOrders } from "../../orders/orders.routes.js";
import { releaseManualSellerPayout } from "./manual-seller-payout-release.service.js";

type ReleaseClient = Parameters<typeof releaseManualSellerPayout>[1];
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

function makeSettlement(overrides: Record<string, unknown> = {}) {
  return {
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
      paid: false,
      awaitingPayoutExecution: true
    },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function makeClient(overrides: {
  shipment?: Record<string, unknown>;
  order?: Partial<ReturnType<typeof makeOrder>> | null;
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
        weightGrams: 800,
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
    settlements: overrides.settlement === null ? [] : [makeSettlement(overrides.settlement ?? {})],
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

  return { client: client as unknown as NonNullable<ReleaseClient>, state };
}

describe("manual seller payout release confirmation", () => {
  it("release-confirms an approved payout without marking it paid", async () => {
    const { client, state } = makeClient();

    const result = await releaseManualSellerPayout({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      releaseReference: "PAYOUT-REL-1001",
      remarks: "Finance release confirmed",
      actorId: "admin_1"
    }, client);

    assert.equal(result.idempotent, false);
    assert.equal(result.payout.status, "finance_released");
    assert.equal(result.payout.settlementStatus, "APPROVED");
    assert.equal(result.payout.paid, false);
    assert.equal(result.payout.payoutMoved, false);
    assert.equal(result.payout.bankTransferCreated, false);
    assert.equal(result.payout.paymentProviderCalled, false);
    assert.equal(state.settlements[0]?.status, "APPROVED");
    assert.equal(state.settlements[0]?.settledAt, null);
    assert.equal((state.settlements[0]?.metadata as Record<string, unknown>).financeReleaseConfirmed, true);
    assert.equal((state.settlements[0]?.metadata as Record<string, unknown>).releasedForPayoutProcessing, true);
    assert.equal((state.settlements[0]?.metadata as Record<string, unknown>).paid, false);
    assert.equal((state.settlements[0]?.metadata as Record<string, unknown>).bankTransferCreated, false);
    assert.equal(state.auditLogs[0]?.action, "ADMIN_SELLER_PAYOUT_RELEASE_CONFIRMED");

    const serialized = JSON.stringify({ result, audit: state.auditLogs[0] });
    assert.equal(/buyerPhone|addressLine|otp|secret|token|rawPayload|bankDetails|bankAccount/i.test(serialized), false);
  });

  it("rejects unapproved COD payout release", async () => {
    const { client } = makeClient({
      settlement: {
        status: "PENDING"
      }
    });

    await assert.rejects(
      releaseManualSellerPayout({
        awbNumber: "DEMO-COD-AWB-1001",
        amount: 1499,
        actorId: "admin_1"
      }, client),
      /SELLER_PAYOUT_NOT_APPROVED_FOR_RELEASE/
    );
  });

  it("rejects amount mismatch safely", async () => {
    const { client } = makeClient();

    await assert.rejects(
      releaseManualSellerPayout({
        awbNumber: "DEMO-COD-AWB-1001",
        amount: 1498,
        releaseReference: "PAYOUT-REL-1001",
        actorId: "admin_1"
      }, client),
      /SELLER_PAYOUT_RELEASE_AMOUNT_MISMATCH/
    );
  });

  it("is idempotent for an already release-confirmed payout reference", async () => {
    const { client, state } = makeClient({
      settlement: {
        metadata: {
          approvalReference: "PAYOUT-REVIEW-1001",
          releaseReference: "PAYOUT-REL-1001",
          financeReleaseConfirmed: true,
          releasedForPayoutProcessing: true,
          financeReleasedAt: now.toISOString(),
          paid: false,
          payoutMoved: false,
          bankTransferCreated: false,
          paymentProviderCalled: false
        }
      }
    });

    const result = await releaseManualSellerPayout({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      releaseReference: "PAYOUT-REL-1001",
      actorId: "admin_1"
    }, client);

    assert.equal(result.idempotent, true);
    assert.equal(result.payout.status, "finance_released");
    assert.equal(result.payout.releasedAt?.toISOString(), now.toISOString());
    assert.equal(state.auditLogs[0]?.action, "ADMIN_SELLER_PAYOUT_RELEASE_IDEMPOTENT");
  });

  it("makes seller finance order mapping reflect released-not-paid payout state", async () => {
    const { client, state } = makeClient();
    await releaseManualSellerPayout({
      awbNumber: "DEMO-COD-AWB-1001",
      amount: 1499,
      releaseReference: "PAYOUT-REL-1001",
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
      codRemittances: [
        {
          id: "cod_remittance_1",
          merchantId: "merchant_1",
          awb: "DEMO-COD-AWB-1001",
          orderId: "order_internal_cod_1",
          externalOrderId: "seller-demo-mpzrjxf5-c30a8ee4",
          remittedAmount: 1499,
          remittedAt: now,
          utr: "UTR-DEMO-1001",
          status: "manual_reconciled",
          createdAt: now,
          updatedAt: now
        }
      ],
      sellerSettlements: state.settlements.map((settlement) => ({
        merchantId: String(settlement.merchantId),
        orderId: String(settlement.orderId),
        awb: String(settlement.awb),
        status: String(settlement.status),
        sellerPayable: settlement.sellerPayable,
        approvedAt: settlement.approvedAt as Date,
        settledAt: settlement.settledAt as Date | null,
        metadata: settlement.metadata,
        createdAt: settlement.createdAt as Date,
        updatedAt: settlement.updatedAt as Date
      }))
    });

    assert.equal(order?.codRemittanceStatus, "reconciled");
    assert.equal(order?.sellerPayoutReadiness, "finance_released");
    assert.equal(order?.sellerPayoutApprovalStatus, "released_not_paid");
    assert.equal(order?.sellerPayoutReleaseStatus, "released_for_payout_processing");
    assert.equal(order?.sellerPayoutReleaseConfirmed, true);
    assert.equal(order?.sellerPayoutReleasedAmount, 1499);
    assert.equal(order?.sellerPayoutPaid, false);
    assert.equal("sellerSettlementId" in (order ?? {}), false);
    assert.equal("releaseReference" in (order ?? {}), false);
    assert.equal("bankDetails" in (order ?? {}), false);
  });

  it("keeps seller payout release mounted behind admin JWT", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const adminRoutes = readFileSync("src/modules/admin/admin.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/admin", requireAdminJwt, adminRouter\);/);
    assert.match(adminRoutes, /adminRouter\.post\("\/finance\/seller-payouts\/release"/);
  });
});
