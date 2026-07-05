import {
  CHECKOUT_MODES,
  minorToJsonInteger,
  quoteOptionsFromJson,
  type CheckoutOption,
  type CheckoutQuoteResult
} from "./checkout-quote.service.js";

type TimelineRecord = {
  createdAt: Date;
  type: string;
  message: string;
  actor: string;
};

type PaymentRecord = {
  id: string;
  amountMinor: bigint;
  currency: string;
  purpose: string;
  gateway: string;
  state: string;
  gatewayIntentRef?: string | null;
  gatewayOrderRef?: string | null;
  gatewayPaymentRef?: string | null;
  capturedAt?: Date | null;
};

type AccountingEventRecord = {
  id: string;
  eventType: string;
  sourceRef: string;
  amountMinor?: bigint | null;
  currency: string;
  metadata?: unknown;
  createdAt: Date;
};

type OrderRecord = {
  id: string;
  mode: string;
  state: string;
  currency: string;
  pincode: string;
  itemsJson: unknown;
  customerJson: unknown;
  itemsTotalMinor: bigint;
  codFeeMinor: bigint;
  discountMinor: bigint;
  grandTotalMinor: bigint;
  payNowMinor: bigint;
  payOnDeliveryMinor: bigint;
  advancePaidMinor: bigint;
  codCollectionStatus: string;
  codCollectionAmountMinor: bigint;
  codCollectionMethod?: string | null;
  codCollectionReference?: string | null;
  codCollectedAt?: Date | null;
  advanceExpiresAt?: Date | null;
  createdAt: Date;
  timeline?: TimelineRecord[];
  payments?: PaymentRecord[];
  accountingEvents?: AccountingEventRecord[];
  quote?: {
    id: string;
    riskNotes?: unknown;
  } | null;
};

function serializeOption(option: CheckoutOption) {
  return {
    key: option.key,
    label: option.label,
    available: option.available,
    reason: option.reason,
    payNow: minorToJsonInteger(option.payNow),
    payOnDelivery: minorToJsonInteger(option.payOnDelivery),
    codFee: minorToJsonInteger(option.codFee),
    discount: minorToJsonInteger(option.discount),
    total: minorToJsonInteger(option.total),
    badge: option.badge,
    currency: option.currency
  };
}

export function serializeCheckoutQuote(quote: CheckoutQuoteResult) {
  return {
    quoteId: quote.quoteId,
    expiresAt: quote.expiresAt.toISOString(),
    currency: quote.currency,
    itemsTotal: minorToJsonInteger(quote.itemsTotal),
    pincode: quote.pincode,
    options: {
      prepaid: serializeOption(quote.options.prepaid),
      partial_cod: serializeOption(quote.options.partial_cod),
      full_cod: serializeOption(quote.options.full_cod)
    }
  };
}

export function checkoutRiskNotesFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((note): note is string => typeof note === "string" && note.trim().length > 0);
}

export function deserializePersistedCheckoutQuote(record: {
  id: string;
  expiresAt: Date;
  currency: string;
  itemsTotalMinor: bigint;
  pincode: string;
  optionsJson: unknown;
  riskNotes?: unknown;
}): CheckoutQuoteResult {
  const options = quoteOptionsFromJson(record.optionsJson);
  return {
    quoteId: record.id,
    expiresAt: record.expiresAt,
    currency: record.currency,
    itemsTotal: record.itemsTotalMinor,
    pincode: record.pincode,
    options,
    riskNotes: checkoutRiskNotesFromJson(record.riskNotes)
  };
}

export function serializePersistedCheckoutQuote(record: {
  id: string;
  expiresAt: Date;
  currency: string;
  itemsTotalMinor: bigint;
  pincode: string;
  optionsJson: unknown;
  riskNotes?: unknown;
}) {
  return serializeCheckoutQuote(deserializePersistedCheckoutQuote(record));
}

function safeCustomerName(customerJson: unknown) {
  const customer = customerJson as Record<string, unknown> | null;
  const name = typeof customer?.name === "string" ? customer.name : "";
  return { name };
}

export function serializeBuyerOrder(order: OrderRecord) {
  return {
    id: order.id,
    mode: order.mode,
    state: order.state,
    amounts: {
      currency: order.currency,
      itemsTotal: minorToJsonInteger(order.itemsTotalMinor),
      codFee: minorToJsonInteger(order.codFeeMinor),
      discount: minorToJsonInteger(order.discountMinor),
      grandTotal: minorToJsonInteger(order.grandTotalMinor),
      payNow: minorToJsonInteger(order.payNowMinor),
      payOnDelivery: minorToJsonInteger(order.payOnDeliveryMinor),
      advancePaid: minorToJsonInteger(order.advancePaidMinor)
    },
    codCollection: {
      status: order.codCollectionStatus,
      amount: minorToJsonInteger(order.codCollectionAmountMinor),
      method: order.codCollectionMethod ?? null,
      reference: order.codCollectionReference ?? null,
      collectedAt: order.codCollectedAt?.toISOString() ?? null
    },
    timeline: (order.timeline ?? []).map((entry) => ({
      at: entry.createdAt.toISOString(),
      type: entry.type,
      message: entry.message,
      actor: entry.actor
    })),
    items: order.itemsJson,
    pincode: order.pincode,
    customer: safeCustomerName(order.customerJson),
    advanceExpiresAt: order.advanceExpiresAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString()
  };
}

export function serializeCheckoutPayment(payment: PaymentRecord) {
  return {
    id: payment.id,
    amount: minorToJsonInteger(payment.amountMinor),
    currency: payment.currency,
    purpose: payment.purpose,
    gateway: payment.gateway,
    state: payment.state,
    mockGateway: {
      orderRef: payment.gatewayOrderRef ?? null,
      intentRef: payment.gatewayIntentRef ?? null,
      paymentRef: payment.gatewayPaymentRef ?? null
    },
    capturedAt: payment.capturedAt?.toISOString() ?? null
  };
}

function serializeCheckoutAccountingEvent(event: AccountingEventRecord) {
  return {
    id: event.id,
    eventType: event.eventType,
    sourceRef: event.sourceRef,
    amount: event.amountMinor === null || event.amountMinor === undefined ? null : minorToJsonInteger(event.amountMinor),
    currency: event.currency,
    metadata: event.metadata ?? null,
    createdAt: event.createdAt.toISOString()
  };
}

export function serializeAdminCheckoutOrder(order: OrderRecord) {
  return {
    ...serializeBuyerOrder(order),
    merchantId: (order as { merchantId?: string }).merchantId ?? null,
    quoteId: (order as { quoteId?: string }).quoteId ?? null,
    riskNotes: checkoutRiskNotesFromJson(order.quote?.riskNotes),
    payments: (order.payments ?? []).map(serializeCheckoutPayment),
    accountingEvents: (order.accountingEvents ?? []).map(serializeCheckoutAccountingEvent)
  };
}

export function assertLowercaseCheckoutModes() {
  return CHECKOUT_MODES.every((mode) => mode === mode.toLowerCase());
}
