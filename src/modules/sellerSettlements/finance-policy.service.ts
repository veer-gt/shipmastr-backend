import type {
  CourierFinancePolicy,
  CourierPenalty,
  CourierSettlementFrequency,
  FinanceApprovalStatus,
  FinanceApprovalType,
  Prisma,
  ReconciliationResult,
  SellerSettlement
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { credit as creditWallet } from "../wallet/wallet.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

type MoneyLike = Prisma.Decimal | number | string | null | undefined;

export type CourierPenaltyPolicyInput = {
  creditPeriodDays?: number | null | undefined;
  codRemittanceSlaDays?: number | null | undefined;
  penaltyGraceDays?: number | null | undefined;
  codDelayPenaltyRateBps?: number | null | undefined;
  codDelayPenaltyFixedAmount?: MoneyLike;
  maxCodDelayPenaltyAmount?: MoneyLike;
  settlementFrequency?: CourierSettlementFrequency | undefined;
  settlementAnchorDay?: number | null | undefined;
};

export type SettlementCalendarResultRecord = Pick<
  ReconciliationResult,
  "id" | "courierId" | "createdAt" | "status" | "expectedCodAmount" | "remittedCodAmount" | "invoicedCourierCharge" | "courierPayable" | "disputeAmount"
>;

export type SettlementCalendarPenaltyRecord = Pick<CourierPenalty, "reconciliationResultId" | "courierId" | "penaltyAmount" | "status">;

export type SettlementCalendarNoteRecord = {
  courierId: string | null;
  reasonCode: string;
  note: string;
  createdAt: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function num(value: MoneyLike) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function omitUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T as undefined extends T[K] ? K : K]: Exclude<T[K], undefined>;
  };
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number) {
  const copy = new Date(value);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isoWeekday(value: Date) {
  const day = value.getUTCDay();
  return day === 0 ? 7 : day;
}

function defaultPolicy(courierId: string): CourierPenaltyPolicyInput & { courierId: string } {
  return {
    courierId,
    creditPeriodDays: 7,
    codRemittanceSlaDays: 7,
    penaltyGraceDays: 0,
    codDelayPenaltyRateBps: 50,
    codDelayPenaltyFixedAmount: 0,
    maxCodDelayPenaltyAmount: null,
    settlementFrequency: "WEEKLY",
    settlementAnchorDay: 5
  };
}

function normalizeAnchorDay(frequency: CourierSettlementFrequency | undefined, anchorDay: number | null | undefined) {
  const value = Number(anchorDay ?? 5);
  if (frequency === "MONTHLY") return Math.min(28, Math.max(1, value));
  return Math.min(7, Math.max(1, value));
}

function settlementDueDate(value: Date, policy: CourierPenaltyPolicyInput) {
  const frequency = policy.settlementFrequency ?? "WEEKLY";
  const anchorDay = normalizeAnchorDay(frequency, policy.settlementAnchorDay);
  const creditDate = addDays(value, Number(policy.creditPeriodDays ?? 7));

  if (frequency === "MONTHLY") {
    const due = new Date(Date.UTC(creditDate.getUTCFullYear(), creditDate.getUTCMonth(), anchorDay));
    if (due >= creditDate) return due;
    return new Date(Date.UTC(creditDate.getUTCFullYear(), creditDate.getUTCMonth() + 1, anchorDay));
  }

  const due = addDays(creditDate, (anchorDay - isoWeekday(creditDate) + 7) % 7);
  if (frequency === "BIWEEKLY") {
    const epoch = new Date(Date.UTC(2026, 0, 5));
    const weekDistance = Math.floor((due.getTime() - epoch.getTime()) / (7 * DAY_MS));
    return weekDistance % 2 === 0 ? due : addDays(due, 7);
  }

  return due;
}

export function calculateCodDelayPenalty(input: {
  deliveredAt: Date | null | undefined;
  remittedAt: Date | null | undefined;
  baseAmount: MoneyLike;
  policy: CourierPenaltyPolicyInput;
}) {
  if (!input.deliveredAt || !input.remittedAt) {
    return {
      delayedDays: 0,
      penaltyAmount: 0,
      reason: "COD remittance delivery/remittance dates are incomplete"
    };
  }

  const totalDays = Math.max(0, Math.ceil((input.remittedAt.getTime() - input.deliveredAt.getTime()) / DAY_MS));
  const delayedDays = Math.max(
    0,
    totalDays - Number(input.policy.codRemittanceSlaDays ?? 7) - Number(input.policy.penaltyGraceDays ?? 0)
  );
  if (!delayedDays) {
    return {
      delayedDays: 0,
      penaltyAmount: 0,
      reason: "COD remittance is within courier SLA"
    };
  }

  const variablePenalty = num(input.baseAmount) * (Number(input.policy.codDelayPenaltyRateBps ?? 0) / 10_000) * delayedDays;
  const uncapped = money(num(input.policy.codDelayPenaltyFixedAmount) + variablePenalty);
  const maxPenalty = input.policy.maxCodDelayPenaltyAmount === null || input.policy.maxCodDelayPenaltyAmount === undefined
    ? null
    : num(input.policy.maxCodDelayPenaltyAmount);
  const penaltyAmount = money(maxPenalty === null ? uncapped : Math.min(uncapped, maxPenalty));

  return {
    delayedDays,
    penaltyAmount,
    reason: `COD remittance delayed ${delayedDays} day${delayedDays === 1 ? "" : "s"} beyond courier SLA`
  };
}

export function buildCourierSettlementCalendarFromRecords(input: {
  results: SettlementCalendarResultRecord[];
  penalties: SettlementCalendarPenaltyRecord[];
  policies: Array<CourierPenaltyPolicyInput & { courierId: string }>;
  notes?: SettlementCalendarNoteRecord[] | undefined;
}) {
  const policies = new Map(input.policies.map((policy) => [policy.courierId, policy]));
  const penaltiesByResult = new Map<string, number>();
  const penaltiesByCourier = new Map<string, number>();

  for (const penalty of input.penalties.filter((item) => item.status !== "WAIVED")) {
    if (penalty.reconciliationResultId) {
      penaltiesByResult.set(
        penalty.reconciliationResultId,
        money((penaltiesByResult.get(penalty.reconciliationResultId) ?? 0) + num(penalty.penaltyAmount))
      );
    } else {
      penaltiesByCourier.set(
        penalty.courierId,
        money((penaltiesByCourier.get(penalty.courierId) ?? 0) + num(penalty.penaltyAmount))
      );
    }
  }

  const buckets = new Map<string, {
    courierId: string;
    settlementDate: string;
    invoiceTotal: number;
    approvedPayable: number;
    codPendingDeduction: number;
    disputeDeduction: number;
    penaltyDeduction: number;
    finalPayable: number;
    blockedReasons: string[];
    blockedReasonNotes: string[];
    resultCount: number;
    status: "SCHEDULED" | "BLOCKED";
  }>();

  for (const result of input.results) {
    const courierId = result.courierId ?? "UNKNOWN";
    const policy = policies.get(courierId) ?? defaultPolicy(courierId);
    const settlementDate = isoDate(settlementDueDate(result.createdAt, policy));
    const key = `${courierId}:${settlementDate}`;
    const bucket = buckets.get(key) ?? {
      courierId,
      settlementDate,
      invoiceTotal: 0,
      approvedPayable: 0,
      codPendingDeduction: 0,
      disputeDeduction: 0,
      penaltyDeduction: 0,
      finalPayable: 0,
      blockedReasons: [],
      blockedReasonNotes: [],
      resultCount: 0,
      status: "SCHEDULED" as const
    };

    const codPending = money(Math.max(0, num(result.expectedCodAmount) - num(result.remittedCodAmount)));
    const disputeAmount = money(result.disputeAmount);
    const penaltyAmount = money(penaltiesByResult.get(result.id) ?? 0);

    bucket.invoiceTotal = money(bucket.invoiceTotal + num(result.invoicedCourierCharge));
    bucket.approvedPayable = money(bucket.approvedPayable + num(result.courierPayable));
    bucket.codPendingDeduction = money(bucket.codPendingDeduction + codPending);
    bucket.disputeDeduction = money(bucket.disputeDeduction + disputeAmount);
    bucket.penaltyDeduction = money(bucket.penaltyDeduction + penaltyAmount);
    bucket.resultCount += 1;
    if (codPending > 0) bucket.blockedReasons.push("COD_PENDING");
    if (disputeAmount > 0) bucket.blockedReasons.push("UNRESOLVED_DISPUTE");
    if (result.status !== "AUTO_APPROVED" && result.status !== "SETTLED") bucket.blockedReasons.push(result.status);

    buckets.set(key, bucket);
  }

  const notesByCourier = new Map<string, SettlementCalendarNoteRecord[]>();
  for (const note of input.notes ?? []) {
    if (!note.courierId) continue;
    const list = notesByCourier.get(note.courierId) ?? [];
    list.push(note);
    notesByCourier.set(note.courierId, list);
  }

  return [...buckets.values()].map((bucket) => {
    const courierPenalty = penaltiesByCourier.get(bucket.courierId) ?? 0;
    bucket.penaltyDeduction = money(bucket.penaltyDeduction + courierPenalty);
    bucket.finalPayable = money(Math.max(
      0,
      bucket.approvedPayable - bucket.codPendingDeduction - bucket.disputeDeduction - bucket.penaltyDeduction
    ));
    bucket.blockedReasons = [...new Set(bucket.blockedReasons)];
    bucket.blockedReasonNotes = (notesByCourier.get(bucket.courierId) ?? [])
      .map((note) => `${note.reasonCode}: ${note.note}`)
      .slice(0, 6);
    bucket.status = bucket.blockedReasons.length ? "BLOCKED" : "SCHEDULED";
    return bucket;
  }).sort((left, right) => left.settlementDate.localeCompare(right.settlementDate) || left.courierId.localeCompare(right.courierId));
}

export function buildReconciliationStatement(input: {
  results: Array<Pick<ReconciliationResult, "id" | "createdAt" | "courierId" | "awb" | "orderId" | "status" | "expectedCodAmount" | "remittedCodAmount" | "invoicedCourierCharge" | "courierPayable" | "disputeAmount" | "paymentHoldAmount" | "sellerPayable">>;
  penalties: Array<Pick<CourierPenalty, "reconciliationResultId" | "penaltyAmount" | "status">>;
}) {
  const penaltyByResult = new Map<string, number>();
  for (const penalty of input.penalties.filter((item) => item.status !== "WAIVED")) {
    if (!penalty.reconciliationResultId) continue;
    penaltyByResult.set(
      penalty.reconciliationResultId,
      money((penaltyByResult.get(penalty.reconciliationResultId) ?? 0) + num(penalty.penaltyAmount))
    );
  }

  const rows = input.results.map((result) => {
    const codPending = money(Math.max(0, num(result.expectedCodAmount) - num(result.remittedCodAmount)));
    const penaltyAmount = penaltyByResult.get(result.id) ?? 0;
    return {
      resultId: result.id,
      date: result.createdAt.toISOString(),
      courierId: result.courierId ?? "UNKNOWN",
      awb: result.awb,
      orderId: result.orderId,
      status: result.status,
      expectedCodAmount: num(result.expectedCodAmount),
      remittedCodAmount: num(result.remittedCodAmount),
      codPending,
      invoiceCharge: num(result.invoicedCourierCharge),
      courierPayable: num(result.courierPayable),
      disputeAmount: num(result.disputeAmount),
      paymentHoldAmount: num(result.paymentHoldAmount),
      sellerPayable: num(result.sellerPayable),
      penaltyAmount,
      finalCourierPayable: money(Math.max(0, num(result.courierPayable) - penaltyAmount))
    };
  });

  return {
    summary: {
      totalRows: rows.length,
      expectedCodAmount: money(rows.reduce((sum, row) => sum + row.expectedCodAmount, 0)),
      remittedCodAmount: money(rows.reduce((sum, row) => sum + row.remittedCodAmount, 0)),
      codPending: money(rows.reduce((sum, row) => sum + row.codPending, 0)),
      invoiceCharge: money(rows.reduce((sum, row) => sum + row.invoiceCharge, 0)),
      courierPayable: money(rows.reduce((sum, row) => sum + row.courierPayable, 0)),
      disputeAmount: money(rows.reduce((sum, row) => sum + row.disputeAmount, 0)),
      paymentHoldAmount: money(rows.reduce((sum, row) => sum + row.paymentHoldAmount, 0)),
      sellerPayable: money(rows.reduce((sum, row) => sum + row.sellerPayable, 0)),
      penaltyAmount: money(rows.reduce((sum, row) => sum + row.penaltyAmount, 0)),
      finalCourierPayable: money(rows.reduce((sum, row) => sum + row.finalCourierPayable, 0))
    },
    rows
  };
}

export async function listCourierFinancePolicies(merchantId: string, client: Db = prisma) {
  return client.courierFinancePolicy.findMany({
    where: { merchantId },
    include: { courier: { select: { id: true, name: true, code: true, active: true } } },
    orderBy: { createdAt: "desc" }
  });
}

export async function upsertCourierFinancePolicy(input: {
  merchantId: string;
  courierId: string;
  actorId?: string | undefined;
  data: {
    creditPeriodDays?: number | undefined;
    codRemittanceSlaDays?: number | undefined;
    penaltyGraceDays?: number | undefined;
    codDelayPenaltyRateBps?: number | undefined;
    codDelayPenaltyFixedAmount?: number | undefined;
    maxCodDelayPenaltyAmount?: number | null | undefined;
    settlementFrequency?: CourierSettlementFrequency | undefined;
    settlementAnchorDay?: number | undefined;
    makerCheckerRequired?: boolean | undefined;
    active?: boolean | undefined;
    notes?: string | null | undefined;
  };
}, client: Db = prisma) {
  const courier = await client.courierPartner.findUnique({ where: { id: input.courierId } });
  if (!courier) throw new HttpError(404, "COURIER_NOT_FOUND");
  const data = omitUndefined(input.data);

  const policy = await client.courierFinancePolicy.upsert({
    where: {
      merchantId_courierId: {
        merchantId: input.merchantId,
        courierId: input.courierId
      }
    },
    update: data,
    create: {
      merchantId: input.merchantId,
      courierId: input.courierId,
      ...data
    }
  });

  await audit({
    merchantId: input.merchantId,
    action: "COURIER_FINANCE_POLICY_UPSERTED",
    entityType: "CourierFinancePolicy",
    entityId: policy.id,
    metadata: { courierId: input.courierId },
    ...(input.actorId ? { actorId: input.actorId } : {})
  }, client);

  return policy;
}

function policyInput(policy: CourierFinancePolicy | undefined, courierId: string) {
  if (!policy) return defaultPolicy(courierId);
  return {
    courierId: policy.courierId,
    creditPeriodDays: policy.creditPeriodDays,
    codRemittanceSlaDays: policy.codRemittanceSlaDays,
    penaltyGraceDays: policy.penaltyGraceDays,
    codDelayPenaltyRateBps: policy.codDelayPenaltyRateBps,
    codDelayPenaltyFixedAmount: policy.codDelayPenaltyFixedAmount,
    maxCodDelayPenaltyAmount: policy.maxCodDelayPenaltyAmount,
    settlementFrequency: policy.settlementFrequency,
    settlementAnchorDay: policy.settlementAnchorDay
  };
}

function remittanceKey(value: { awb?: string | null; orderId?: string | null }) {
  return value.awb ? `awb:${value.awb}` : value.orderId ? `order:${value.orderId}` : "";
}

export async function calculateCourierPenalties(input: {
  merchantId: string;
  courierId?: string | undefined;
  runId?: string | undefined;
  now?: Date | undefined;
}, client: Db = prisma) {
  const results = await client.reconciliationResult.findMany({
    where: {
      merchantId: input.merchantId,
      ...(input.courierId ? { courierId: input.courierId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      expectedCodAmount: { gt: 0 },
      remittedCodAmount: { not: null }
    },
    orderBy: { createdAt: "asc" }
  });

  const courierIds = [...new Set(results.map((result) => result.courierId).filter((value): value is string => Boolean(value)))];
  const orderIds = [...new Set(results.map((result) => result.orderId).filter((value): value is string => Boolean(value)))];
  const awbs = [...new Set(results.map((result) => result.awb).filter((value): value is string => Boolean(value)))];
  const [policies, orders, remittances] = await Promise.all([
    client.courierFinancePolicy.findMany({
      where: {
        merchantId: input.merchantId,
        courierId: { in: courierIds },
        active: true
      }
    }),
    orderIds.length
      ? client.order.findMany({
        where: { merchantId: input.merchantId, id: { in: orderIds } },
        include: { shipmentDetails: true }
      })
      : Promise.resolve([]),
    awbs.length || orderIds.length
      ? client.codRemittance.findMany({
        where: {
          merchantId: input.merchantId,
          OR: [
            ...(awbs.length ? [{ awb: { in: awbs } }] : []),
            ...(orderIds.length ? [{ orderId: { in: orderIds } }] : [])
          ]
        },
        orderBy: { remittedAt: "desc" }
      })
      : Promise.resolve([])
  ]);

  const policiesByCourier = new Map(policies.map((policy) => [policy.courierId, policy]));
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const remittanceByKey = new Map<string, (typeof remittances)[number]>();
  for (const remittance of remittances) {
    const key = remittanceKey(remittance);
    if (key && !remittanceByKey.has(key)) remittanceByKey.set(key, remittance);
  }

  const createdOrUpdated = [];

  for (const result of results) {
    if (!result.courierId) continue;
    const order = result.orderId ? orderById.get(result.orderId) : null;
    const deliveredAt = order?.shipmentDetails?.deliveredAt ?? null;
    const remittance = remittanceByKey.get(remittanceKey(result)) ?? null;
    const calculation = calculateCodDelayPenalty({
      deliveredAt,
      remittedAt: remittance?.remittedAt ?? null,
      baseAmount: result.expectedCodAmount,
      policy: policyInput(policiesByCourier.get(result.courierId), result.courierId)
    });

    if (!calculation.penaltyAmount) continue;

    const penalty = await client.courierPenalty.upsert({
      where: {
        reconciliationResultId_penaltyType: {
          reconciliationResultId: result.id,
          penaltyType: "COD_REMITTANCE_DELAY"
        }
      },
      update: {
        baseAmount: result.expectedCodAmount,
        penaltyAmount: calculation.penaltyAmount,
        delayedDays: calculation.delayedDays,
        reason: calculation.reason,
        calculatedAt: input.now ?? new Date(),
        metadata: json({
          deliveredAt,
          remittedAt: remittance?.remittedAt ?? null,
          policy: policyInput(policiesByCourier.get(result.courierId), result.courierId)
        })
      },
      create: {
        merchantId: input.merchantId,
        courierId: result.courierId,
        reconciliationResultId: result.id,
        awb: result.awb,
        orderId: result.orderId,
        penaltyType: "COD_REMITTANCE_DELAY",
        baseAmount: result.expectedCodAmount,
        penaltyAmount: calculation.penaltyAmount,
        delayedDays: calculation.delayedDays,
        reason: calculation.reason,
        calculatedAt: input.now ?? new Date(),
        metadata: json({
          deliveredAt,
          remittedAt: remittance?.remittedAt ?? null,
          policy: policyInput(policiesByCourier.get(result.courierId), result.courierId)
        })
      }
    });
    createdOrUpdated.push(penalty);
  }

  if (createdOrUpdated.length) {
    await audit({
      merchantId: input.merchantId,
      action: "COURIER_PENALTIES_CALCULATED",
      entityType: "CourierPenalty",
      metadata: {
        courierId: input.courierId ?? null,
        runId: input.runId ?? null,
        penaltyCount: createdOrUpdated.length,
        penaltyAmount: money(createdOrUpdated.reduce((sum, penalty) => sum + num(penalty.penaltyAmount), 0))
      }
    }, client);
  }

  return createdOrUpdated;
}

export async function listCourierPenalties(input: {
  merchantId: string;
  courierId?: string | undefined;
}, client: Db = prisma) {
  return client.courierPenalty.findMany({
    where: {
      merchantId: input.merchantId,
      ...(input.courierId ? { courierId: input.courierId } : {})
    },
    orderBy: { calculatedAt: "desc" },
    take: 200
  });
}

export async function buildCourierSettlementCalendar(input: {
  merchantId: string;
  courierId?: string | undefined;
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
}, client: Db = prisma) {
  const [results, policies, penalties, notes] = await Promise.all([
    client.reconciliationResult.findMany({
      where: {
        merchantId: input.merchantId,
        ...(input.courierId ? { courierId: input.courierId } : {}),
        ...(input.dateFrom || input.dateTo ? {
          createdAt: {
            ...(input.dateFrom ? { gte: input.dateFrom } : {}),
            ...(input.dateTo ? { lte: input.dateTo } : {})
          }
        } : {})
      }
    }),
    client.courierFinancePolicy.findMany({
      where: {
        merchantId: input.merchantId,
        ...(input.courierId ? { courierId: input.courierId } : {}),
        active: true
      }
    }),
    client.courierPenalty.findMany({
      where: {
        merchantId: input.merchantId,
        ...(input.courierId ? { courierId: input.courierId } : {})
      }
    }),
    client.paymentBlockNote.findMany({
      where: {
        merchantId: input.merchantId,
        ...(input.courierId ? { courierId: input.courierId } : {})
      },
      orderBy: { createdAt: "desc" },
      take: 100
    })
  ]);

  return buildCourierSettlementCalendarFromRecords({
    results,
    penalties,
    policies: policies.map((policy) => policyInput(policy, policy.courierId)),
    notes
  });
}

async function addBlockNote(input: {
  merchantId: string;
  reasonCode: string;
  note: string;
  createdBy?: string | undefined;
  paymentHoldId?: string | undefined;
  settlementId?: string | undefined;
  approvalId?: string | undefined;
  courierId?: string | undefined;
}, client: Db) {
  return client.paymentBlockNote.create({
    data: {
      merchantId: input.merchantId,
      reasonCode: input.reasonCode,
      note: input.note,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.paymentHoldId ? { paymentHoldId: input.paymentHoldId } : {}),
      ...(input.settlementId ? { settlementId: input.settlementId } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.courierId ? { courierId: input.courierId } : {})
    }
  });
}

export async function createFinanceApprovalRequest(input: {
  merchantId: string;
  requestedBy: string;
  settlementId?: string | undefined;
  paymentHoldId?: string | undefined;
  courierId?: string | undefined;
  amount?: number | undefined;
  reason?: string | undefined;
}, client: typeof prisma = prisma) {
  return client.$transaction(async (tx: Prisma.TransactionClient) => {
    let approvalType: FinanceApprovalType;
    let amount = money(input.amount);
    let reason = input.reason ?? "Finance approval requested";
    let settlement: SellerSettlement | null = null;
    let paymentHold: { status: string; amount: MoneyLike; reason: string } | null = null;

    if (input.paymentHoldId) {
      paymentHold = await tx.paymentHold.findFirst({
        where: { id: input.paymentHoldId, merchantId: input.merchantId }
      });
      if (!paymentHold) throw new HttpError(404, "PAYMENT_HOLD_NOT_FOUND");
      if (paymentHold.status !== "ACTIVE") throw new HttpError(409, "PAYMENT_HOLD_NOT_ACTIVE");
      approvalType = "PAYMENT_HOLD_RELEASE";
      amount = num(paymentHold.amount);
      reason = input.reason ?? `Release payment hold: ${paymentHold.reason}`;
    } else if (input.settlementId) {
      settlement = await tx.sellerSettlement.findFirst({
        where: { id: input.settlementId, merchantId: input.merchantId }
      });
      if (!settlement) throw new HttpError(404, "SELLER_SETTLEMENT_NOT_FOUND");
      if (settlement.status === "BLOCKED") {
        await addBlockNote({
          merchantId: input.merchantId,
          settlementId: settlement.id,
          reasonCode: "SETTLEMENT_BLOCKED_BY_RECONCILIATION",
          note: input.reason ?? "Seller settlement is blocked until COD, dispute, and charge reconciliation passes.",
          createdBy: input.requestedBy
        }, tx);
        throw new HttpError(409, "SETTLEMENT_BLOCKED_BY_RECONCILIATION");
      }
      approvalType = "SELLER_SETTLEMENT";
      amount = num(settlement.sellerPayable);
      reason = input.reason ?? "Release seller settlement after reconciliation approval";
    } else if (input.courierId) {
      approvalType = "COURIER_SETTLEMENT";
      reason = input.reason ?? "Release courier settlement after policy checks";
    } else {
      throw new HttpError(400, "PAYMENT_APPROVAL_TARGET_REQUIRED");
    }

    const approval = await tx.financeApprovalRequest.create({
      data: {
        merchantId: input.merchantId,
        approvalType,
        ...(input.settlementId ? { settlementId: input.settlementId } : {}),
        ...(input.paymentHoldId ? { paymentHoldId: input.paymentHoldId } : {}),
        ...(input.courierId ? { courierId: input.courierId } : {}),
        amount,
        reason,
        requestedBy: input.requestedBy,
        metadata: json({
          makerChecker: true,
          settlementStatus: settlement?.status ?? null,
          paymentHoldStatus: paymentHold?.status ?? null
        })
      }
    });

    await audit({
      merchantId: input.merchantId,
      actorId: input.requestedBy,
      action: "FINANCE_APPROVAL_REQUESTED",
      entityType: "FinanceApprovalRequest",
      entityId: approval.id,
      metadata: { approvalType, amount }
    }, tx);

    return approval;
  });
}

export async function listFinanceApprovals(input: {
  merchantId: string;
  status?: FinanceApprovalStatus | undefined;
}, client: Db = prisma) {
  return client.financeApprovalRequest.findMany({
    where: {
      merchantId: input.merchantId,
      ...(input.status ? { status: input.status } : {})
    },
    orderBy: { requestedAt: "desc" },
    take: 200
  });
}

export async function approveFinanceApprovalRequest(input: {
  merchantId: string;
  approvalId: string;
  checkedBy: string;
}, client: typeof prisma = prisma) {
  return client.$transaction(async (tx: Prisma.TransactionClient) => {
    const approval = await tx.financeApprovalRequest.findFirst({
      where: { id: input.approvalId, merchantId: input.merchantId }
    });
    if (!approval) throw new HttpError(404, "FINANCE_APPROVAL_NOT_FOUND");
    if (approval.status !== "PENDING") throw new HttpError(409, "FINANCE_APPROVAL_NOT_PENDING");
    if (approval.requestedBy === input.checkedBy) throw new HttpError(409, "MAKER_CHECKER_SAME_USER");

    let execution = null as unknown;

    if (approval.approvalType === "PAYMENT_HOLD_RELEASE") {
      if (!approval.paymentHoldId) throw new HttpError(400, "PAYMENT_HOLD_ID_REQUIRED");
      const hold = await tx.paymentHold.findFirst({
        where: { id: approval.paymentHoldId, merchantId: input.merchantId }
      });
      if (!hold) throw new HttpError(404, "PAYMENT_HOLD_NOT_FOUND");
      execution = await tx.paymentHold.update({
        where: { id: hold.id },
        data: { status: "RELEASED", releasedAt: new Date() }
      });
    }

    if (approval.approvalType === "SELLER_SETTLEMENT") {
      if (!approval.settlementId) throw new HttpError(400, "SETTLEMENT_ID_REQUIRED");
      const settlement = await tx.sellerSettlement.findFirst({
        where: { id: approval.settlementId, merchantId: input.merchantId }
      });
      if (!settlement) throw new HttpError(404, "SELLER_SETTLEMENT_NOT_FOUND");
      if (settlement.status === "BLOCKED") {
        await addBlockNote({
          merchantId: input.merchantId,
          settlementId: settlement.id,
          approvalId: approval.id,
          reasonCode: "SETTLEMENT_BLOCKED_BY_RECONCILIATION",
          note: "Checker could not release a blocked settlement.",
          createdBy: input.checkedBy
        }, tx);
        throw new HttpError(409, "SETTLEMENT_BLOCKED_BY_RECONCILIATION");
      }

      const updated = await tx.sellerSettlement.update({
        where: { id: settlement.id },
        data: { status: "SETTLED", settledAt: new Date() }
      });
      await creditWallet({
        merchantId: input.merchantId,
        orderId: updated.orderId,
        awb: updated.awb,
        entryType: "SELLER_SETTLEMENT",
        amount: updated.sellerPayable,
        referenceType: "SellerSettlement",
        referenceId: updated.id,
        idempotencyKey: `seller-settlement:${updated.id}:approval:${approval.id}`,
        description: "Seller settlement released after finance approval.",
        createdBy: input.checkedBy,
        metadata: json({ settlementId: updated.id, approvalId: approval.id })
      }, tx);
      if (updated.reconciliationResultId) {
        await tx.reconciliationResult.update({
          where: { id: updated.reconciliationResultId },
          data: { status: "SETTLED" }
        });
      }
      execution = updated;
    }

    if (approval.approvalType === "COURIER_SETTLEMENT") {
      execution = { courierId: approval.courierId, amount: num(approval.amount) };
    }

    const updatedApproval = await tx.financeApprovalRequest.update({
      where: { id: approval.id },
      data: {
        status: "APPROVED",
        checkedBy: input.checkedBy,
        checkedAt: new Date()
      }
    });

    await audit({
      merchantId: input.merchantId,
      actorId: input.checkedBy,
      action: "FINANCE_APPROVAL_APPROVED",
      entityType: "FinanceApprovalRequest",
      entityId: approval.id,
      metadata: { approvalType: approval.approvalType, amount: num(approval.amount) }
    }, tx);

    return { approval: updatedApproval, execution };
  });
}

export async function rejectFinanceApprovalRequest(input: {
  merchantId: string;
  approvalId: string;
  checkedBy: string;
  rejectionReason?: string | undefined;
}, client: Db = prisma) {
  const approval = await client.financeApprovalRequest.findFirst({
    where: { id: input.approvalId, merchantId: input.merchantId }
  });
  if (!approval) throw new HttpError(404, "FINANCE_APPROVAL_NOT_FOUND");
  if (approval.status !== "PENDING") throw new HttpError(409, "FINANCE_APPROVAL_NOT_PENDING");
  if (approval.requestedBy === input.checkedBy) throw new HttpError(409, "MAKER_CHECKER_SAME_USER");

  const updated = await client.financeApprovalRequest.update({
    where: { id: approval.id },
    data: {
      status: "REJECTED",
      checkedBy: input.checkedBy,
      checkedAt: new Date(),
      rejectionReason: input.rejectionReason ?? "Rejected by finance checker"
    }
  });

  await addBlockNote({
    merchantId: input.merchantId,
    approvalId: updated.id,
    settlementId: updated.settlementId ?? undefined,
    paymentHoldId: updated.paymentHoldId ?? undefined,
    courierId: updated.courierId ?? undefined,
    reasonCode: "FINANCE_APPROVAL_REJECTED",
    note: updated.rejectionReason ?? "Rejected by finance checker",
    createdBy: input.checkedBy
  }, client);

  await audit({
    merchantId: input.merchantId,
    actorId: input.checkedBy,
    action: "FINANCE_APPROVAL_REJECTED",
    entityType: "FinanceApprovalRequest",
    entityId: updated.id,
    metadata: { approvalType: updated.approvalType, rejectionReason: updated.rejectionReason }
  }, client);

  return updated;
}

export async function listPaymentBlockNotes(input: {
  merchantId: string;
  courierId?: string | undefined;
}, client: Db = prisma) {
  return client.paymentBlockNote.findMany({
    where: {
      merchantId: input.merchantId,
      ...(input.courierId ? { courierId: input.courierId } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });
}

export async function createPaymentBlockNote(input: {
  merchantId: string;
  reasonCode: string;
  note: string;
  createdBy?: string | undefined;
  paymentHoldId?: string | undefined;
  settlementId?: string | undefined;
  approvalId?: string | undefined;
  courierId?: string | undefined;
}, client: Db = prisma) {
  const note = await addBlockNote(input, client);

  await audit({
    merchantId: input.merchantId,
    action: "PAYMENT_BLOCK_NOTE_CREATED",
    entityType: "PaymentBlockNote",
    entityId: note.id,
    metadata: {
      reasonCode: input.reasonCode,
      paymentHoldId: input.paymentHoldId ?? null,
      settlementId: input.settlementId ?? null,
      approvalId: input.approvalId ?? null,
      courierId: input.courierId ?? null
    },
    ...(input.createdBy ? { actorId: input.createdBy } : {})
  }, client);

  return note;
}

function statementRange(input: {
  period: "monthly" | "yearly" | "till_date";
  year?: number | undefined;
  month?: number | undefined;
  now?: Date | undefined;
}) {
  const now = input.now ?? new Date();
  if (input.period === "monthly") {
    const year = input.year ?? now.getUTCFullYear();
    const month = input.month ?? now.getUTCMonth() + 1;
    return {
      periodLabel: `${year}-${String(month).padStart(2, "0")}`,
      from: new Date(Date.UTC(year, month - 1, 1)),
      to: new Date(Date.UTC(year, month, 1))
    };
  }
  if (input.period === "yearly") {
    const year = input.year ?? now.getUTCFullYear();
    return {
      periodLabel: String(year),
      from: new Date(Date.UTC(year, 0, 1)),
      to: new Date(Date.UTC(year + 1, 0, 1))
    };
  }

  return {
    periodLabel: "till_date",
    from: null,
    to: now
  };
}

export async function exportReconciliationStatement(input: {
  merchantId: string;
  period: "monthly" | "yearly" | "till_date";
  year?: number | undefined;
  month?: number | undefined;
  courierId?: string | undefined;
  format: "csv" | "json";
  now?: Date | undefined;
}, client: Db = prisma) {
  const range = statementRange(input);
  const results = await client.reconciliationResult.findMany({
    where: {
      merchantId: input.merchantId,
      ...(input.courierId ? { courierId: input.courierId } : {}),
      createdAt: {
        ...(range.from ? { gte: range.from } : {}),
        lt: range.to
      }
    },
    orderBy: { createdAt: "asc" }
  });
  const resultIds = results.map((result) => result.id);
  const penalties = resultIds.length
    ? await client.courierPenalty.findMany({
      where: {
        merchantId: input.merchantId,
        reconciliationResultId: { in: resultIds }
      }
    })
    : [];
  const statement = buildReconciliationStatement({ results, penalties });

  if (input.format === "json") {
    return {
      contentType: "application/json",
      fileName: `shipmastr-reconciliation-${range.periodLabel}.json`,
      body: JSON.stringify({
        period: input.period,
        periodLabel: range.periodLabel,
        summary: statement.summary,
        rows: statement.rows
      }, null, 2)
    };
  }

  const headers = [
    "resultId",
    "date",
    "courierId",
    "awb",
    "orderId",
    "status",
    "expectedCodAmount",
    "remittedCodAmount",
    "codPending",
    "invoiceCharge",
    "courierPayable",
    "disputeAmount",
    "paymentHoldAmount",
    "sellerPayable",
    "penaltyAmount",
    "finalCourierPayable"
  ] as const;
  const body = [
    headers.join(","),
    ...statement.rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n");

  return {
    contentType: "text/csv",
    fileName: `shipmastr-reconciliation-${range.periodLabel}.csv`,
    body
  };
}
