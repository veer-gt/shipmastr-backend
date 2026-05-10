import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFinanceDashboardProjection,
  type FinanceDashboardDisputeRecord,
  type FinanceDashboardPaymentHoldRecord,
  type FinanceDashboardResultRecord,
  type FinanceDashboardSettlementRecord
} from "./finance-dashboard.service.js";

const now = new Date("2026-05-20T00:00:00.000Z");

const results: FinanceDashboardResultRecord[] = [
  {
    id: "result_1",
    runId: "run_1",
    merchantId: "merchant_1",
    courierId: "courier_1",
    status: "AUTO_APPROVED",
    expectedCodAmount: 1000,
    remittedCodAmount: 1000,
    invoicedCourierCharge: 100,
    courierPayable: 100,
    disputeAmount: 0,
    paymentHoldAmount: 0,
    sellerPayable: 900,
    mismatchAmount: 0,
    createdAt: new Date("2026-05-05T10:00:00.000Z")
  },
  {
    id: "result_2",
    runId: "run_1",
    merchantId: "merchant_1",
    courierId: "courier_1",
    status: "COD_SHORTFALL",
    expectedCodAmount: 2000,
    remittedCodAmount: 1500,
    invoicedCourierCharge: 150,
    courierPayable: 0,
    disputeAmount: 500,
    paymentHoldAmount: 500,
    sellerPayable: null,
    mismatchAmount: 500,
    createdAt: new Date("2026-05-06T10:00:00.000Z")
  },
  {
    id: "result_3",
    runId: "run_2",
    merchantId: "merchant_1",
    courierId: "courier_2",
    status: "INVOICE_MISMATCH",
    expectedCodAmount: 0,
    remittedCodAmount: null,
    invoicedCourierCharge: 200,
    courierPayable: 0,
    disputeAmount: 50,
    paymentHoldAmount: 0,
    sellerPayable: null,
    mismatchAmount: 50,
    createdAt: new Date("2026-05-07T10:00:00.000Z")
  }
];

const disputes: FinanceDashboardDisputeRecord[] = [
  {
    id: "dispute_1",
    reconciliationResultId: "result_2",
    merchantId: "merchant_1",
    courierId: "courier_1",
    type: "COD_SHORTFALL",
    status: "OPEN",
    amount: 500,
    createdAt: new Date("2026-05-10T00:00:00.000Z")
  },
  {
    id: "dispute_2",
    reconciliationResultId: "result_2",
    merchantId: "merchant_1",
    courierId: "courier_1",
    type: "COD_DELAY",
    status: "OPEN",
    amount: 300,
    createdAt: new Date("2026-05-01T00:00:00.000Z")
  },
  {
    id: "dispute_3",
    reconciliationResultId: "result_3",
    merchantId: "merchant_1",
    courierId: "courier_2",
    type: "DUPLICATE_BILLING",
    status: "OPEN",
    amount: 100,
    createdAt: new Date("2026-05-18T00:00:00.000Z")
  },
  {
    id: "dispute_4",
    reconciliationResultId: null,
    merchantId: "merchant_1",
    courierId: "courier_2",
    type: "UNKNOWN_AWB",
    status: "RESOLVED",
    amount: 25,
    createdAt: new Date("2026-05-04T00:00:00.000Z")
  },
  {
    id: "dispute_5",
    reconciliationResultId: "result_3",
    merchantId: "merchant_1",
    courierId: "courier_2",
    type: "WEIGHT_DISPUTE",
    status: "OPEN",
    amount: 50,
    createdAt: new Date("2026-05-12T00:00:00.000Z")
  },
  {
    id: "dispute_6",
    reconciliationResultId: "result_3",
    merchantId: "merchant_1",
    courierId: "courier_2",
    type: "RTO_CHARGE_ISSUE",
    status: "UNDER_REVIEW",
    amount: 80,
    createdAt: new Date("2026-05-02T00:00:00.000Z")
  }
];

const paymentHolds: FinanceDashboardPaymentHoldRecord[] = [
  {
    id: "hold_1",
    reconciliationResultId: "result_2",
    merchantId: "merchant_1",
    orderId: "order_2",
    awb: "AWB2",
    reason: "COD_SHORTFALL",
    status: "ACTIVE",
    amount: 500,
    createdAt: new Date("2026-05-06T10:00:00.000Z")
  },
  {
    id: "hold_2",
    reconciliationResultId: "result_1",
    merchantId: "merchant_1",
    orderId: "order_1",
    awb: "AWB1",
    reason: "RELEASED_AFTER_RECONCILIATION",
    status: "RELEASED",
    amount: 200,
    createdAt: new Date("2026-05-05T10:00:00.000Z")
  }
];

const settlements: FinanceDashboardSettlementRecord[] = [
  {
    id: "settlement_1",
    reconciliationResultId: "result_1",
    merchantId: "merchant_1",
    status: "PENDING",
    sellerPayable: 900,
    createdAt: new Date("2026-05-05T10:00:00.000Z"),
    settledAt: null
  },
  {
    id: "settlement_2",
    reconciliationResultId: "result_4",
    merchantId: "merchant_1",
    status: "SETTLED",
    sellerPayable: 700,
    createdAt: new Date("2026-05-01T10:00:00.000Z"),
    settledAt: new Date("2026-05-03T10:00:00.000Z")
  }
];

describe("finance dashboard projection", () => {
  it("calculates COD, courier, dispute, hold, and settlement totals in paise", () => {
    const dashboard = buildFinanceDashboardProjection({
      results,
      disputes,
      paymentHolds,
      settlements,
      now
    });

    assert.equal(dashboard.metrics.totalCodExpected, 300000);
    assert.equal(dashboard.metrics.totalCodReceived, 250000);
    assert.equal(dashboard.metrics.codPending, 50000);
    assert.equal(dashboard.metrics.codDelayed, 30000);
    assert.equal(dashboard.metrics.courierInvoiceTotal, 45000);
    assert.equal(dashboard.metrics.approvedCourierPayable, 10000);
    assert.equal(dashboard.metrics.disputedAmount, 103000);
    assert.equal(dashboard.metrics.paymentHoldAmount, 50000);
    assert.equal(dashboard.metrics.sellerPayable, 90000);
    assert.equal(dashboard.metrics.sellerSettlementPending, 90000);
    assert.equal(dashboard.metrics.sellerSettlementReleased, 70000);
    assert.equal(dashboard.metrics.openDisputes, 5);
    assert.equal(dashboard.metrics.ageingDisputesOver7Days, 4);
    assert.equal(dashboard.metrics.duplicateBillingCount, 1);
    assert.equal(dashboard.metrics.unknownAwbCount, 1);
    assert.equal(dashboard.metrics.weightDisputeCount, 1);
    assert.equal(dashboard.metrics.rtoDisputeCount, 1);
    assert.equal(dashboard.metrics.mismatchRatePercent, 66.67);
  });

  it("builds ageing buckets and grouped mismatch summaries", () => {
    const dashboard = buildFinanceDashboardProjection({
      results,
      disputes,
      paymentHolds,
      settlements,
      now
    });

    assert.deepEqual(dashboard.ageingBuckets, {
      "0-3 days": 1,
      "4-7 days": 0,
      "8-15 days": 2,
      "15+ days": 2
    });

    const courierOne = dashboard.groupBy.courier.find((group) => group.key === "courier_1");
    const runTwo = dashboard.groupBy.reconciliationRun.find((group) => group.key === "run_2");

    assert.equal(courierOne?.totalCodExpected, 300000);
    assert.equal(courierOne?.totalCodReceived, 250000);
    assert.equal(courierOne?.courierInvoiceTotal, 25000);
    assert.equal(courierOne?.codPending, 50000);
    assert.equal(courierOne?.mismatchRatePercent, 50);
    assert.equal(runTwo?.mismatchRatePercent, 100);
  });
});
