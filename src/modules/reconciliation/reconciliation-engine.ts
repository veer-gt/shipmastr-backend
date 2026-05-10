import type { ReconciliationDisputeType, ReconciliationStatus } from "@prisma/client";

const COD_REMITTANCE_SLA_DAYS = 7;
const MONEY_TOLERANCE = 0.01;
const PLATFORM_FEE_DEFAULT = 0;

export type ReconciliationOrderInput = {
  id: string;
  merchantId: string;
  externalOrderId: string;
  codAmount: number;
  paymentMode: "PREPAID" | "COD";
  weightGrams?: number | null | undefined;
  status?: string | null | undefined;
};

export type ReconciliationShipmentInput = {
  orderId: string;
  merchantId: string;
  courierId?: string | null | undefined;
  awb?: string | null | undefined;
  weightGrams?: number | null | undefined;
  zone?: string | null | undefined;
  shipmentStatus?: string | null | undefined;
  rtoStatus?: string | null | undefined;
  deliveredAt?: Date | null | undefined;
};

export type ReconciliationRateCardInput = {
  courierId: string;
  zone: string;
  minWeight: number;
  maxWeight: number;
  baseRate: number;
  additionalRate: number;
  codFee: number;
  fuelSurcharge: number;
  rtoCharge: number;
  gstPercent?: number | null | undefined;
};

export type ReconciliationInvoiceLineInput = {
  id?: string | undefined;
  merchantId?: string | null | undefined;
  courierId: string;
  awb?: string | null | undefined;
  orderId?: string | null | undefined;
  externalOrderId?: string | null | undefined;
  chargedWeightGrams?: number | null | undefined;
  billedWeightGrams?: number | null | undefined;
  zone?: string | null | undefined;
  forwardFreight?: number | null | undefined;
  rtoFreight?: number | null | undefined;
  codFee?: number | null | undefined;
  otherCharges?: number | null | undefined;
  gstAmount?: number | null | undefined;
  totalCharge: number;
};

export type ReconciliationCodRemittanceInput = {
  merchantId: string;
  courierId?: string | null | undefined;
  awb?: string | null | undefined;
  orderId?: string | null | undefined;
  externalOrderId?: string | null | undefined;
  codAmount?: number | null | undefined;
  remittedAmount: number;
  remittedAt?: Date | null | undefined;
};

export type ReconciliationCourierEventInput = {
  awb?: string | null | undefined;
  orderId?: string | null | undefined;
  courierId?: string | null | undefined;
  eventType?: string | null | undefined;
  status?: string | null | undefined;
  remarks?: string | null | undefined;
  createdAt?: Date | null | undefined;
};

export type ReconciliationCourierPolicyInput = {
  courierId: string;
  codRemittanceSlaDays?: number | null | undefined;
};

export type ReconciliationDisputePlan = {
  type: ReconciliationDisputeType;
  amount: number;
  reason: string;
};

export type PaymentHoldPlan = {
  reason: string;
  amount: number;
};

export type ReconciliationResultPlan = {
  merchantId: string;
  orderId: string | null;
  externalOrderId: string | null;
  awb: string | null;
  courierId: string | null;
  status: ReconciliationStatus;
  expectedCourierCharge: number;
  invoicedCourierCharge: number | null;
  expectedCodAmount: number;
  remittedCodAmount: number | null;
  sellerPayable: number | null;
  courierPayable: number;
  mismatchAmount: number;
  disputeAmount: number;
  paymentHoldAmount: number;
  reasons: string[];
  disputes: ReconciliationDisputePlan[];
  holds: PaymentHoldPlan[];
  settlement: {
    status: "PENDING" | "BLOCKED" | "APPROVED";
    sellerPayable: number;
    codCollected: number;
    courierCharge: number;
    platformFee: number;
    adjustmentAmount: number;
  } | null;
  metadata: Record<string, unknown>;
};

export type ReconciliationRunPlan = {
  results: ReconciliationResultPlan[];
  summary: ReconciliationDashboardSummary;
};

export type ReconciliationDashboardSummary = {
  totalCodExpected: number;
  codReceived: number;
  codPending: number;
  courierPayable: number;
  sellerPayable: number;
  disputeAmount: number;
  paymentHoldAmount: number;
  courierWiseMismatchRate: Array<{ courierId: string; total: number; mismatches: number; mismatchRate: number }>;
  sellerWiseSettlementStatus: Array<{ merchantId: string; total: number; approved: number; blocked: number; settled: number }>;
};

function money(value: unknown) {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

function matchesText(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && String(left).trim() === String(right).trim());
}

function eventIsRto(event: ReconciliationCourierEventInput) {
  const value = `${event.eventType ?? ""} ${event.status ?? ""}`.toLowerCase();
  return value.includes("rto") || value.includes("return");
}

function eventIsFakeAttempt(event: ReconciliationCourierEventInput) {
  const value = `${event.eventType ?? ""} ${event.status ?? ""} ${event.remarks ?? ""}`.toLowerCase();
  return value.includes("fake") || value.includes("false attempt");
}

function hasRtoSignal(input: {
  order: ReconciliationOrderInput | null;
  shipment: ReconciliationShipmentInput | null;
  events: ReconciliationCourierEventInput[];
}) {
  return String(input.order?.status ?? "").toUpperCase() === "RTO"
    || String(input.shipment?.shipmentStatus ?? "").toUpperCase().includes("RTO")
    || Boolean(input.shipment?.rtoStatus)
    || input.events.some(eventIsRto);
}

function isDeliveredAtLate(remittance: ReconciliationCodRemittanceInput | null, shipment: ReconciliationShipmentInput | null, slaDays = COD_REMITTANCE_SLA_DAYS) {
  if (!remittance?.remittedAt || !shipment?.deliveredAt) return false;
  const allowedMs = Math.max(0, slaDays) * 24 * 60 * 60 * 1000;
  return remittance.remittedAt.getTime() - shipment.deliveredAt.getTime() > allowedMs;
}

function invoiceLineTotal(line: ReconciliationInvoiceLineInput | null) {
  return line ? money(line.totalCharge) : null;
}

function lineRtoFreight(line: ReconciliationInvoiceLineInput | null) {
  return money(line?.rtoFreight);
}

function lineKey(line: ReconciliationInvoiceLineInput) {
  return line.awb ?? line.orderId ?? line.externalOrderId ?? line.id ?? "unknown";
}

function findOrderForLine(
  line: ReconciliationInvoiceLineInput,
  orders: ReconciliationOrderInput[],
  shipments: ReconciliationShipmentInput[]
) {
  if (line.awb) {
    const shipment = shipments.find((item) => matchesText(item.awb, line.awb));
    if (shipment) {
      const order = orders.find((item) => item.id === shipment.orderId) ?? null;
      return { order, shipment };
    }
  }

  if (line.orderId) {
    const order = orders.find((item) => item.id === line.orderId) ?? null;
    const shipment = order ? shipments.find((item) => item.orderId === order.id) ?? null : null;
    if (order) return { order, shipment };
  }

  if (line.externalOrderId) {
    const order = orders.find((item) => item.externalOrderId === line.externalOrderId) ?? null;
    const shipment = order ? shipments.find((item) => item.orderId === order.id) ?? null : null;
    if (order) return { order, shipment };
  }

  return { order: null, shipment: null };
}

function findRemittanceForOrder(input: {
  order: ReconciliationOrderInput;
  shipment: ReconciliationShipmentInput | null;
  remittances: ReconciliationCodRemittanceInput[];
}) {
  const awb = input.shipment?.awb;
  return input.remittances.find((item) => matchesText(item.awb, awb))
    ?? input.remittances.find((item) => item.orderId === input.order.id)
    ?? input.remittances.find((item) => item.externalOrderId === input.order.externalOrderId)
    ?? null;
}

function eventsFor(input: {
  awb: string | null;
  orderId: string | null;
  courierId: string | null;
  events: ReconciliationCourierEventInput[];
}) {
  return input.events.filter((event) => {
    const awbMatches = input.awb && matchesText(event.awb, input.awb);
    const orderMatches = input.orderId && event.orderId === input.orderId;
    const courierMatches = !input.courierId || !event.courierId || event.courierId === input.courierId;
    return Boolean(courierMatches && (awbMatches || orderMatches));
  });
}

function policyFor(courierId: string | null, policies: ReconciliationCourierPolicyInput[] = []) {
  if (!courierId) return null;
  return policies.find((policy) => policy.courierId === courierId) ?? null;
}

function rateFor(input: {
  courierId: string | null;
  zone: string | null;
  weightGrams: number;
  rateCards: ReconciliationRateCardInput[];
}) {
  return input.rateCards.find((rate) => {
    const courierMatches = !input.courierId || rate.courierId === input.courierId;
    const zoneMatches = !input.zone || rate.zone === input.zone;
    const weightMatches = rate.minWeight <= input.weightGrams && rate.maxWeight >= input.weightGrams;
    return courierMatches && zoneMatches && weightMatches;
  }) ?? null;
}

export function calculateExpectedCourierCharge(input: {
  order: ReconciliationOrderInput;
  shipment: ReconciliationShipmentInput | null;
  invoiceLine?: ReconciliationInvoiceLineInput | null | undefined;
  rateCards: ReconciliationRateCardInput[];
  hasRto: boolean;
}) {
  const weightGrams = input.invoiceLine?.chargedWeightGrams
    ?? input.invoiceLine?.billedWeightGrams
    ?? input.shipment?.weightGrams
    ?? input.order.weightGrams
    ?? 500;
  const zone = input.invoiceLine?.zone ?? input.shipment?.zone ?? null;
  const courierId = input.invoiceLine?.courierId ?? input.shipment?.courierId ?? null;
  const rate = rateFor({ courierId, zone, weightGrams, rateCards: input.rateCards });

  if (!rate) {
    return {
      total: 0,
      subtotal: 0,
      gst: 0,
      forwardFreight: 0,
      rtoFreight: 0,
      codFee: 0,
      rateCardFound: false
    };
  }

  const extraWeight = Math.max(0, weightGrams - rate.minWeight);
  const extraBlocks = Math.ceil(extraWeight / 500);
  const forwardFreight = money(rate.baseRate + extraBlocks * rate.additionalRate + rate.fuelSurcharge);
  const rtoFreight = input.hasRto ? money(rate.rtoCharge) : 0;
  const codFee = input.order.paymentMode === "COD" ? money(rate.codFee) : 0;
  const subtotal = money(forwardFreight + rtoFreight + codFee);
  const gst = money(subtotal * (money(rate.gstPercent ?? 18) / 100));

  return {
    total: money(subtotal + gst),
    subtotal,
    gst,
    forwardFreight,
    rtoFreight,
    codFee,
    rateCardFound: true
  };
}

function resultStatus(disputes: ReconciliationDisputePlan[], holds: PaymentHoldPlan[]): ReconciliationStatus {
  if (disputes.some((item) => item.type === "DUPLICATE_BILLING")) return "DUPLICATE_BILLING";
  if (disputes.some((item) => item.type === "UNKNOWN_AWB")) return "MANUAL_REVIEW";
  if (disputes.some((item) => item.type === "RTO_CHARGE_ISSUE")) return "RTO_CHARGE_REVIEW";
  if (disputes.some((item) => item.type === "FAKE_ATTEMPT_NDR_ISSUE")) return "FAKE_ATTEMPT_REVIEW";
  if (disputes.some((item) => item.type === "WEIGHT_DISPUTE")) return "WEIGHT_DISPUTE";
  if (disputes.some((item) => item.type === "ZONE_DISPUTE")) return "ZONE_DISPUTE";
  if (disputes.some((item) => item.type === "COD_SHORTFALL")) return "COD_SHORTFALL";
  if (disputes.some((item) => item.type === "COD_DELAY")) return "COD_DELAYED";
  if (disputes.some((item) => item.type === "INVOICE_MISMATCH")) return "INVOICE_MISMATCH";
  if (holds.length) return "PAYMENT_HOLD";
  return "AUTO_APPROVED";
}

function buildMatchedResult(input: {
  order: ReconciliationOrderInput;
  shipment: ReconciliationShipmentInput | null;
  line: ReconciliationInvoiceLineInput | null;
  duplicateAwb: boolean;
  remittance: ReconciliationCodRemittanceInput | null;
  rateCards: ReconciliationRateCardInput[];
  events: ReconciliationCourierEventInput[];
  courierPolicies?: ReconciliationCourierPolicyInput[] | undefined;
}) {
  const awb = input.line?.awb ?? input.shipment?.awb ?? null;
  const courierId = input.line?.courierId ?? input.shipment?.courierId ?? null;
  const courierPolicy = policyFor(courierId, input.courierPolicies);
  const codRemittanceSlaDays = courierPolicy?.codRemittanceSlaDays ?? COD_REMITTANCE_SLA_DAYS;
  const relatedEvents = eventsFor({ awb, orderId: input.order.id, courierId, events: input.events });
  const hasRto = hasRtoSignal({ order: input.order, shipment: input.shipment, events: relatedEvents });
  const expectedCharge = calculateExpectedCourierCharge({
    order: input.order,
    shipment: input.shipment,
    invoiceLine: input.line,
    rateCards: input.rateCards,
    hasRto
  });
  const invoicedCourierCharge = invoiceLineTotal(input.line);
  const expectedCodAmount = input.order.paymentMode === "COD" ? money(input.order.codAmount) : 0;
  const remittedCodAmount = input.remittance ? money(input.remittance.remittedAmount) : null;
  const codPending = money(Math.max(0, expectedCodAmount - (remittedCodAmount ?? 0)));
  const mismatchAmount = invoicedCourierCharge === null ? 0 : money(Math.abs(invoicedCourierCharge - expectedCharge.total));
  const disputes: ReconciliationDisputePlan[] = [];
  const holds: PaymentHoldPlan[] = [];
  const reasons: string[] = [];

  if (input.duplicateAwb) {
    const amount = invoicedCourierCharge ?? expectedCharge.total;
    disputes.push({ type: "DUPLICATE_BILLING", amount, reason: "AWB appears more than once in courier invoice lines" });
    holds.push({ reason: "DUPLICATE_BILLING", amount });
    reasons.push("Duplicate AWB billed by courier");
  }

  if (!expectedCharge.rateCardFound) {
    disputes.push({ type: "INVOICE_MISMATCH", amount: invoicedCourierCharge ?? 0, reason: "No matching courier rate card found" });
    reasons.push("Rate card missing for courier/zone/weight");
  } else if (invoicedCourierCharge !== null && mismatchAmount > MONEY_TOLERANCE) {
    disputes.push({ type: "INVOICE_MISMATCH", amount: mismatchAmount, reason: "Courier invoice charge differs from expected rate-card charge" });
    reasons.push("Invoice charge mismatch");
  }

  if (input.line?.chargedWeightGrams && input.shipment?.weightGrams && input.line.chargedWeightGrams > input.shipment.weightGrams) {
    const amount = money(Math.max(0, (invoicedCourierCharge ?? 0) - expectedCharge.total));
    disputes.push({ type: "WEIGHT_DISPUTE", amount, reason: "Courier billed weight is higher than shipment weight" });
    reasons.push("Weight dispute");
  }

  if (input.line?.zone && input.shipment?.zone && input.line.zone !== input.shipment.zone) {
    const amount = money(Math.max(0, (invoicedCourierCharge ?? 0) - expectedCharge.total));
    disputes.push({ type: "ZONE_DISPUTE", amount, reason: "Courier invoice zone differs from shipment zone" });
    reasons.push("Zone dispute");
  }

  if (lineRtoFreight(input.line) > 0 && !hasRto) {
    const amount = lineRtoFreight(input.line);
    disputes.push({ type: "RTO_CHARGE_ISSUE", amount, reason: "RTO freight was billed without an RTO event" });
    holds.push({ reason: "RTO_CHARGE_ISSUE", amount });
    reasons.push("RTO charge without RTO event");
  }

  if (relatedEvents.some(eventIsFakeAttempt)) {
    disputes.push({ type: "FAKE_ATTEMPT_NDR_ISSUE", amount: expectedCharge.total, reason: "Courier event indicates fake attempt or NDR issue" });
    reasons.push("Fake attempt/NDR review");
  }

  if (expectedCodAmount > 0 && remittedCodAmount === null) {
    disputes.push({ type: "COD_SHORTFALL", amount: expectedCodAmount, reason: "COD remittance is missing for COD order" });
    holds.push({ reason: "MISSING_REMITTANCE", amount: expectedCodAmount });
    reasons.push("Missing COD remittance");
  } else if (codPending > MONEY_TOLERANCE) {
    disputes.push({ type: "COD_SHORTFALL", amount: codPending, reason: "COD remitted is lower than expected COD" });
    holds.push({ reason: "COD_SHORTFALL", amount: codPending });
    reasons.push("COD shortfall");
  }

  if (expectedCodAmount > 0 && isDeliveredAtLate(input.remittance, input.shipment, codRemittanceSlaDays)) {
    disputes.push({ type: "COD_DELAY", amount: codPending, reason: "COD remittance arrived after SLA" });
    holds.push({ reason: "COD_DELAYED", amount: Math.max(codPending, expectedCodAmount) });
    reasons.push(`COD delayed beyond ${codRemittanceSlaDays} day SLA`);
  }

  const disputeAmount = money(disputes.reduce((sum, item) => sum + item.amount, 0));
  const paymentHoldAmount = money(holds.reduce((sum, item) => sum + item.amount, 0));
  const sellerPayableAmount = money((remittedCodAmount ?? 0) - expectedCharge.total - PLATFORM_FEE_DEFAULT);
  const status = resultStatus(disputes, holds);
  const courierPayable = status === "AUTO_APPROVED"
    ? money(invoicedCourierCharge ?? expectedCharge.total)
    : money(Math.max(0, (invoicedCourierCharge ?? expectedCharge.total) - disputeAmount - codPending));

  return {
    merchantId: input.order.merchantId,
    orderId: input.order.id,
    externalOrderId: input.order.externalOrderId,
    awb,
    courierId,
    status,
    expectedCourierCharge: expectedCharge.total,
    invoicedCourierCharge,
    expectedCodAmount,
    remittedCodAmount,
    sellerPayable: status === "AUTO_APPROVED" ? sellerPayableAmount : null,
    courierPayable,
    mismatchAmount,
    disputeAmount,
    paymentHoldAmount,
    reasons,
    disputes,
    holds,
    settlement: status === "AUTO_APPROVED"
      ? {
          status: "APPROVED" as const,
          sellerPayable: sellerPayableAmount,
          codCollected: remittedCodAmount ?? 0,
          courierCharge: expectedCharge.total,
          platformFee: PLATFORM_FEE_DEFAULT,
          adjustmentAmount: 0
        }
      : null,
    metadata: {
      expectedCharge,
      hasRto,
      invoiceLineId: input.line?.id ?? null,
      remittanceMatched: Boolean(input.remittance),
      codRemittanceSlaDays
    }
  } satisfies ReconciliationResultPlan;
}

function buildUnknownLineResult(line: ReconciliationInvoiceLineInput, duplicateAwb: boolean) {
  const amount = money(line.totalCharge);
  const disputes: ReconciliationDisputePlan[] = [
    { type: "UNKNOWN_AWB", amount, reason: "Courier invoice line could not be matched by AWB, orderId, or externalOrderId" }
  ];
  const holds: PaymentHoldPlan[] = [{ reason: "UNKNOWN_AWB", amount }];

  if (duplicateAwb) {
    disputes.push({ type: "DUPLICATE_BILLING", amount, reason: "Unknown AWB appears more than once in courier invoice lines" });
  }

  return {
    merchantId: line.merchantId ?? "UNKNOWN",
    orderId: line.orderId ?? null,
    externalOrderId: line.externalOrderId ?? null,
    awb: line.awb ?? null,
    courierId: line.courierId,
    status: duplicateAwb ? "DUPLICATE_BILLING" : "MANUAL_REVIEW",
    expectedCourierCharge: 0,
    invoicedCourierCharge: amount,
    expectedCodAmount: 0,
    remittedCodAmount: null,
    sellerPayable: null,
    courierPayable: 0,
    mismatchAmount: amount,
    disputeAmount: money(disputes.reduce((sum, item) => sum + item.amount, 0)),
    paymentHoldAmount: amount,
    reasons: duplicateAwb ? ["Unknown AWB", "Duplicate AWB billed by courier"] : ["Unknown AWB"],
    disputes,
    holds,
    settlement: null,
    metadata: {
      invoiceLineId: line.id ?? null,
      matchKey: lineKey(line)
    }
  } satisfies ReconciliationResultPlan;
}

function aggregate(results: ReconciliationResultPlan[]): ReconciliationDashboardSummary {
  const courierBuckets = new Map<string, { total: number; mismatches: number }>();
  const sellerBuckets = new Map<string, { total: number; approved: number; blocked: number; settled: number }>();

  for (const result of results) {
    const courierId = result.courierId ?? "UNKNOWN";
    const courier = courierBuckets.get(courierId) ?? { total: 0, mismatches: 0 };
    courier.total += 1;
    if (result.status !== "AUTO_APPROVED" && result.status !== "SETTLED") courier.mismatches += 1;
    courierBuckets.set(courierId, courier);

    const seller = sellerBuckets.get(result.merchantId) ?? { total: 0, approved: 0, blocked: 0, settled: 0 };
    seller.total += 1;
    if (result.settlement?.status === "APPROVED") seller.approved += 1;
    if (!result.settlement) seller.blocked += 1;
    if (result.status === "SETTLED") seller.settled += 1;
    sellerBuckets.set(result.merchantId, seller);
  }

  return {
    totalCodExpected: money(results.reduce((sum, item) => sum + item.expectedCodAmount, 0)),
    codReceived: money(results.reduce((sum, item) => sum + (item.remittedCodAmount ?? 0), 0)),
    codPending: money(results.reduce((sum, item) => sum + Math.max(0, item.expectedCodAmount - (item.remittedCodAmount ?? 0)), 0)),
    courierPayable: money(results.reduce((sum, item) => sum + item.courierPayable, 0)),
    sellerPayable: money(results.reduce((sum, item) => sum + (item.sellerPayable ?? 0), 0)),
    disputeAmount: money(results.reduce((sum, item) => sum + item.disputeAmount, 0)),
    paymentHoldAmount: money(results.reduce((sum, item) => sum + item.paymentHoldAmount, 0)),
    courierWiseMismatchRate: [...courierBuckets.entries()].map(([courierId, bucket]) => ({
      courierId,
      total: bucket.total,
      mismatches: bucket.mismatches,
      mismatchRate: bucket.total ? money(bucket.mismatches / bucket.total) : 0
    })),
    sellerWiseSettlementStatus: [...sellerBuckets.entries()].map(([merchantId, bucket]) => ({
      merchantId,
      ...bucket
    }))
  };
}

export function buildReconciliationPlan(input: {
  orders: ReconciliationOrderInput[];
  shipments: ReconciliationShipmentInput[];
  invoiceLines: ReconciliationInvoiceLineInput[];
  codRemittances: ReconciliationCodRemittanceInput[];
  rateCards: ReconciliationRateCardInput[];
  courierEvents: ReconciliationCourierEventInput[];
  courierPolicies?: ReconciliationCourierPolicyInput[] | undefined;
}): ReconciliationRunPlan {
  const awbCounts = new Map<string, number>();

  for (const line of input.invoiceLines) {
    if (!line.awb) continue;
    awbCounts.set(line.awb, (awbCounts.get(line.awb) ?? 0) + 1);
  }

  const results = input.invoiceLines.map((line) => {
    const duplicateAwb = Boolean(line.awb && (awbCounts.get(line.awb) ?? 0) > 1);
    const { order, shipment } = findOrderForLine(line, input.orders, input.shipments);

    if (!order) return buildUnknownLineResult(line, duplicateAwb);

    return buildMatchedResult({
      order,
      shipment,
      line,
      duplicateAwb,
      remittance: findRemittanceForOrder({ order, shipment, remittances: input.codRemittances }),
      rateCards: input.rateCards,
      events: input.courierEvents,
      courierPolicies: input.courierPolicies
    });
  });

  const lineOrderIds = new Set(results.map((result) => result.orderId).filter(Boolean));
  const missingCodResults = input.orders
    .filter((order) => order.paymentMode === "COD" && !lineOrderIds.has(order.id))
    .map((order) => {
      const shipment = input.shipments.find((item) => item.orderId === order.id) ?? null;
      const remittance = findRemittanceForOrder({ order, shipment, remittances: input.codRemittances });
      return buildMatchedResult({
        order,
        shipment,
        line: null,
        duplicateAwb: false,
        remittance,
        rateCards: input.rateCards,
        events: input.courierEvents,
        courierPolicies: input.courierPolicies
      });
    })
    .filter((result) => result.status !== "AUTO_APPROVED");

  const allResults = [...results, ...missingCodResults];

  return {
    results: allResults,
    summary: aggregate(allResults)
  };
}

export function buildCourierPayableSummary(results: Pick<ReconciliationResultPlan, "courierId" | "expectedCodAmount" | "remittedCodAmount" | "invoicedCourierCharge" | "courierPayable" | "disputeAmount">[]) {
  const buckets = new Map<string, { courierId: string; approvedCharges: number; codPending: number; disputeAmount: number; courierPayable: number }>();

  for (const result of results) {
    const courierId = result.courierId ?? "UNKNOWN";
    const bucket = buckets.get(courierId) ?? { courierId, approvedCharges: 0, codPending: 0, disputeAmount: 0, courierPayable: 0 };
    bucket.approvedCharges = money(bucket.approvedCharges + (result.invoicedCourierCharge ?? result.courierPayable));
    bucket.codPending = money(bucket.codPending + Math.max(0, result.expectedCodAmount - (result.remittedCodAmount ?? 0)));
    bucket.disputeAmount = money(bucket.disputeAmount + result.disputeAmount);
    bucket.courierPayable = money(bucket.courierPayable + result.courierPayable);
    buckets.set(courierId, bucket);
  }

  return [...buckets.values()];
}
