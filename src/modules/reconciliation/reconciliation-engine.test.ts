import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCourierPayableSummary,
  buildReconciliationPlan,
  type ReconciliationInvoiceLineInput
} from "./reconciliation-engine.js";

const deliveredAt = new Date("2026-05-01T00:00:00.000Z");

function baseInput(overrides: {
  invoiceLines?: ReconciliationInvoiceLineInput[] | undefined;
  remittedAmount?: number | undefined;
  remittanceDate?: Date | undefined;
  orderStatus?: string | undefined;
  shipmentStatus?: string | undefined;
  rtoStatus?: string | null | undefined;
  events?: Array<{ awb?: string; orderId?: string; courierId?: string; eventType?: string; status?: string; remarks?: string; createdAt?: Date }> | undefined;
} = {}) {
  const invoiceLines = overrides.invoiceLines ?? [
    {
      id: "line_1",
      merchantId: "merchant_1",
      courierId: "courier_1",
      awb: "AWB1",
      orderId: "order_1",
      chargedWeightGrams: 500,
      zone: "A",
      forwardFreight: 100,
      codFee: 20,
      gstAmount: 21.6,
      totalCharge: 141.6
    }
  ];

  return {
    orders: [
      {
        id: "order_1",
        merchantId: "merchant_1",
        externalOrderId: "EXT1",
        codAmount: 1000,
        paymentMode: "COD" as const,
        weightGrams: 500,
        status: overrides.orderStatus ?? "DELIVERED"
      }
    ],
    shipments: [
      {
        orderId: "order_1",
        merchantId: "merchant_1",
        courierId: "courier_1",
        awb: "AWB1",
        weightGrams: 500,
        zone: "A",
        shipmentStatus: overrides.shipmentStatus ?? "DELIVERED",
        rtoStatus: overrides.rtoStatus,
        deliveredAt
      }
    ],
    invoiceLines,
    codRemittances: [
      {
        merchantId: "merchant_1",
        courierId: "courier_1",
        awb: "AWB1",
        orderId: "order_1",
        codAmount: 1000,
        remittedAmount: overrides.remittedAmount ?? 1000,
        remittedAt: overrides.remittanceDate ?? new Date("2026-05-03T00:00:00.000Z")
      }
    ],
    rateCards: [
      {
        courierId: "courier_1",
        zone: "A",
        minWeight: 500,
        maxWeight: 500,
        baseRate: 100,
        additionalRate: 50,
        codFee: 20,
        fuelSurcharge: 0,
        rtoCharge: 80,
        gstPercent: 18
      }
    ],
    courierEvents: overrides.events ?? []
  };
}

describe("COD-first reconciliation engine", () => {
  it("auto-approves an exact invoice and COD match", () => {
    const plan = buildReconciliationPlan(baseInput());
    const result = plan.results[0];

    assert.equal(result?.status, "AUTO_APPROVED");
    assert.equal(result?.disputes.length, 0);
    assert.equal(result?.holds.length, 0);
    assert.equal(result?.settlement?.status, "APPROVED");
    assert.equal(result?.sellerPayable, 858.4);
  });

  it("uses courier COD remittance SLA policy for delay detection", () => {
    const plan = buildReconciliationPlan({
      ...baseInput({ remittanceDate: new Date("2026-05-04T00:00:00.000Z") }),
      courierPolicies: [{ courierId: "courier_1", codRemittanceSlaDays: 1 }]
    });
    const result = plan.results[0];

    assert.equal(result?.status, "COD_DELAYED");
    assert.ok(result?.reasons.some((reason) => reason.includes("1 day SLA")));
    assert.ok(result?.disputes.some((dispute) => dispute.type === "COD_DELAY"));
  });

  it("creates a dispute and payment hold for COD shortfall", () => {
    const plan = buildReconciliationPlan(baseInput({ remittedAmount: 700 }));
    const result = plan.results[0];

    assert.equal(result?.status, "COD_SHORTFALL");
    assert.ok(result?.disputes.some((dispute) => dispute.type === "COD_SHORTFALL"));
    assert.ok(result?.holds.some((hold) => hold.reason === "COD_SHORTFALL"));
    assert.equal(result?.paymentHoldAmount, 300);
  });

  it("creates duplicate billing disputes for duplicate AWBs", () => {
    const plan = buildReconciliationPlan(baseInput({
      invoiceLines: [
        {
          id: "line_1",
          merchantId: "merchant_1",
          courierId: "courier_1",
          awb: "AWB1",
          orderId: "order_1",
          chargedWeightGrams: 500,
          zone: "A",
          totalCharge: 141.6
        },
        {
          id: "line_2",
          merchantId: "merchant_1",
          courierId: "courier_1",
          awb: "AWB1",
          orderId: "order_1",
          chargedWeightGrams: 500,
          zone: "A",
          totalCharge: 141.6
        }
      ]
    }));

    assert.equal(plan.results.length, 2);
    assert.ok(plan.results.every((result) => result.status === "DUPLICATE_BILLING"));
    assert.ok(plan.results.every((result) => result.disputes.some((dispute) => dispute.type === "DUPLICATE_BILLING")));
  });

  it("creates an unknown AWB dispute when invoice line cannot be matched", () => {
    const plan = buildReconciliationPlan(baseInput({
      invoiceLines: [
        {
          id: "line_unknown",
          merchantId: "merchant_1",
          courierId: "courier_1",
          awb: "UNKNOWN_AWB",
          totalCharge: 150
        }
      ]
    }));
    const result = plan.results[0];

    assert.equal(result?.status, "MANUAL_REVIEW");
    assert.ok(result?.disputes.some((dispute) => dispute.type === "UNKNOWN_AWB"));
    assert.ok(result?.holds.some((hold) => hold.reason === "UNKNOWN_AWB"));
  });

  it("flags RTO charge when no RTO event exists", () => {
    const plan = buildReconciliationPlan(baseInput({
      invoiceLines: [
        {
          id: "line_rto",
          merchantId: "merchant_1",
          courierId: "courier_1",
          awb: "AWB1",
          orderId: "order_1",
          chargedWeightGrams: 500,
          zone: "A",
          forwardFreight: 100,
          codFee: 20,
          rtoFreight: 80,
          gstAmount: 36,
          totalCharge: 236
        }
      ]
    }));
    const result = plan.results[0];

    assert.equal(result?.status, "RTO_CHARGE_REVIEW");
    assert.ok(result?.disputes.some((dispute) => dispute.type === "RTO_CHARGE_ISSUE"));
  });

  it("blocks seller settlement until COD is reconciled", () => {
    const plan = buildReconciliationPlan(baseInput({ remittedAmount: 0 }));
    const result = plan.results[0];

    assert.equal(result?.status, "COD_SHORTFALL");
    assert.equal(result?.settlement, null);
    assert.equal(plan.summary.sellerPayable, 0);
  });

  it("deducts unresolved disputes from courier payable", () => {
    const plan = buildReconciliationPlan(baseInput({ remittedAmount: 700 }));
    const result = plan.results[0]!;
    const payables = buildCourierPayableSummary([result]);

    assert.equal(payables[0]?.courierId, "courier_1");
    assert.equal(payables[0]?.disputeAmount, 300);
    assert.ok((payables[0]?.courierPayable ?? 0) < 141.6);
  });
});
