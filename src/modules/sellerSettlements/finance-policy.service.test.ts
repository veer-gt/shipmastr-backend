import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  buildCourierSettlementCalendarFromRecords,
  buildReconciliationStatement,
  calculateCodDelayPenalty
} from "./finance-policy.service.js";

type CalendarInput = Parameters<typeof buildCourierSettlementCalendarFromRecords>[0];
type StatementInput = Parameters<typeof buildReconciliationStatement>[0];

describe("courier finance policy enforcement", () => {
  it("calculates COD delay penalties from courier SLA policy", () => {
    const penalty = calculateCodDelayPenalty({
      deliveredAt: new Date("2026-05-01T00:00:00.000Z"),
      remittedAt: new Date("2026-05-06T00:00:00.000Z"),
      baseAmount: 1000,
      policy: {
        codRemittanceSlaDays: 2,
        penaltyGraceDays: 1,
        codDelayPenaltyRateBps: 100,
        codDelayPenaltyFixedAmount: 10
      }
    });

    assert.equal(penalty.delayedDays, 2);
    assert.equal(penalty.penaltyAmount, 30);
    assert.match(penalty.reason, /beyond courier SLA/);
  });

  it("caps COD delay penalties when contract max is configured", () => {
    const penalty = calculateCodDelayPenalty({
      deliveredAt: new Date("2026-05-01T00:00:00.000Z"),
      remittedAt: new Date("2026-05-10T00:00:00.000Z"),
      baseAmount: 5000,
      policy: {
        codRemittanceSlaDays: 1,
        codDelayPenaltyRateBps: 500,
        codDelayPenaltyFixedAmount: 100,
        maxCodDelayPenaltyAmount: 250
      }
    });

    assert.equal(penalty.penaltyAmount, 250);
  });

  it("builds courier-wise settlement calendar with block notes and deductions", () => {
    const input: CalendarInput = {
      results: [{
        id: "result_1",
        courierId: "courier_1",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        status: "COD_DELAYED",
        expectedCodAmount: new Prisma.Decimal(1000),
        remittedCodAmount: new Prisma.Decimal(700),
        invoicedCourierCharge: new Prisma.Decimal(150),
        courierPayable: new Prisma.Decimal(150),
        disputeAmount: new Prisma.Decimal(300)
      }],
      penalties: [{
        reconciliationResultId: "result_1",
        courierId: "courier_1",
        penaltyAmount: new Prisma.Decimal(25),
        status: "CALCULATED"
      }],
      policies: [{
        courierId: "courier_1",
        creditPeriodDays: 7,
        settlementFrequency: "WEEKLY",
        settlementAnchorDay: 5
      }],
      notes: [{
        courierId: "courier_1",
        reasonCode: "COD_PENDING",
        note: "Blocked until COD report is reconciled.",
        createdAt: new Date("2026-05-04T00:00:00.000Z")
      }]
    };

    const calendar = buildCourierSettlementCalendarFromRecords(input);

    assert.equal(calendar.length, 1);
    assert.equal(calendar[0]?.status, "BLOCKED");
    assert.equal(calendar[0]?.codPendingDeduction, 300);
    assert.equal(calendar[0]?.disputeDeduction, 300);
    assert.equal(calendar[0]?.penaltyDeduction, 25);
    assert.equal(calendar[0]?.finalPayable, 0);
    assert.ok(calendar[0]?.blockedReasonNotes.some((note) => note.includes("COD_PENDING")));
  });

  it("builds exportable reconciliation statements with penalty adjusted payable", () => {
    const input: StatementInput = {
      results: [{
        id: "result_1",
        createdAt: new Date("2026-05-03T00:00:00.000Z"),
        courierId: "courier_1",
        awb: "AWB1",
        orderId: "order_1",
        status: "AUTO_APPROVED",
        expectedCodAmount: new Prisma.Decimal(1000),
        remittedCodAmount: new Prisma.Decimal(1000),
        invoicedCourierCharge: new Prisma.Decimal(150),
        courierPayable: new Prisma.Decimal(150),
        disputeAmount: new Prisma.Decimal(0),
        paymentHoldAmount: new Prisma.Decimal(0),
        sellerPayable: new Prisma.Decimal(850)
      }],
      penalties: [{
        reconciliationResultId: "result_1",
        penaltyAmount: new Prisma.Decimal(20),
        status: "APPLIED"
      }]
    };

    const statement = buildReconciliationStatement(input);

    assert.equal(statement.summary.totalRows, 1);
    assert.equal(statement.summary.expectedCodAmount, 1000);
    assert.equal(statement.summary.penaltyAmount, 20);
    assert.equal(statement.summary.finalCourierPayable, 130);
    assert.equal(statement.rows[0]?.finalCourierPayable, 130);
  });
});
