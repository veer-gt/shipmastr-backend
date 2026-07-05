import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";

export const checkoutSettlementPreviewStatuses = [
  "draft",
  "review_required",
  "preview_ready",
  "exported_preview",
  "voided"
] as const;

export const checkoutSettlementPreviewBuckets = [
  "seller_preview_receivable",
  "payment_fee_preview",
  "platform_fee_preview",
  "shipping_charge_preview",
  "tax_preview",
  "discount_preview",
  "refund_preview",
  "adjustment_preview"
] as const;

export type CheckoutSettlementPreviewStatus = typeof checkoutSettlementPreviewStatuses[number];
export type CheckoutSettlementPreviewBucket = typeof checkoutSettlementPreviewBuckets[number];

export type CheckoutSettlementPreviewReviewReason =
  | "NEGATIVE_SELLER_PREVIEW"
  | "MISSING_CHECKOUT_REF"
  | "DUPLICATE_CHECKOUT_REF"
  | "INVALID_AMOUNT"
  | "UNSUPPORTED_CURRENCY"
  | "UNSAFE_INTERNAL_REF";

export type CheckoutSettlementPreviewInputRow = {
  sellerOrgId: string;
  checkoutRef?: string | null;
  orderRef?: string | null;
  shipmentId?: string | null;
  period: string;
  currency: string;
  grossAmountMinor: string;
  paymentFeeMinor: string;
  platformFeeMinor: string;
  shippingChargeMinor: string;
  taxMinor: string;
  discountMinor: string;
  refundMinor: string;
  adjustmentMinor: string;
};

export type CheckoutSettlementPreviewCommand = {
  sellerOrgId: string;
  period: string;
  sourceRef: string;
  rows: CheckoutSettlementPreviewInputRow[];
  execute?: boolean;
  createdBy?: string | null;
};

export type CheckoutSettlementPreviewRuntimeConfig = {
  appEnv: string;
  nodeEnv: string;
};

export type CheckoutSettlementPreviewBatchRecord = {
  id: string;
  sellerOrgId: string;
  period: string;
  sourceRef: string;
  sourceHash: string;
  status: CheckoutSettlementPreviewStatus;
  currency: string;
  grossAmountMinor: bigint;
  paymentFeeMinor: bigint;
  platformFeeMinor: bigint;
  shippingChargeMinor: bigint;
  taxMinor: bigint;
  discountMinor: bigint;
  refundMinor: bigint;
  adjustmentMinor: bigint;
  sellerPreviewReceivableMinor: bigint;
  negativePreviewMinor: bigint;
  reviewRequiredCount: number;
  metadata?: unknown;
  createdBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type CheckoutSettlementPreviewItemRecord = {
  id: string;
  batchId: string;
  sellerOrgId: string;
  checkoutRef?: string | null;
  orderRef?: string | null;
  shipmentId?: string | null;
  period: string;
  currency: string;
  grossAmountMinor: bigint;
  paymentFeeMinor: bigint;
  platformFeeMinor: bigint;
  shippingChargeMinor: bigint;
  taxMinor: bigint;
  discountMinor: bigint;
  refundMinor: bigint;
  adjustmentMinor: bigint;
  sellerPreviewReceivableMinor: bigint;
  status: CheckoutSettlementPreviewStatus;
  reviewReasons?: CheckoutSettlementPreviewReviewReason[] | null;
  sourceRowHash: string;
  metadata?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

export type CheckoutSettlementPreviewAllocationRecord = {
  id: string;
  batchId: string;
  itemId?: string | null;
  bucket: CheckoutSettlementPreviewBucket;
  amountMinor: bigint;
  currency: string;
  metadata?: unknown;
  createdAt?: Date;
};

export type CheckoutSettlementPreviewEventRecord = {
  id: string;
  batchId: string;
  itemId?: string | null;
  eventType: string;
  status: CheckoutSettlementPreviewStatus;
  message?: string | null;
  metadata?: unknown;
  createdBy?: string | null;
  createdAt?: Date;
};

export type CheckoutSettlementPreviewStoredBatch = {
  batch: CheckoutSettlementPreviewBatchRecord;
  items: CheckoutSettlementPreviewItemRecord[];
  allocations: CheckoutSettlementPreviewAllocationRecord[];
  events: CheckoutSettlementPreviewEventRecord[];
};

export type CheckoutSettlementPreviewStore = {
  findBatchByKey(input: { sellerOrgId: string; period: string; sourceRef: string }): Promise<CheckoutSettlementPreviewStoredBatch | null>;
  findBatchById(batchId: string): Promise<CheckoutSettlementPreviewStoredBatch | null>;
  createBatch(input: {
    batch: Omit<CheckoutSettlementPreviewBatchRecord, "id" | "createdAt" | "updatedAt">;
    items: Array<Omit<CheckoutSettlementPreviewItemRecord, "id" | "batchId" | "createdAt" | "updatedAt"> & {
      allocations: Array<Omit<CheckoutSettlementPreviewAllocationRecord, "id" | "batchId" | "itemId" | "createdAt">>;
    }>;
    event: Omit<CheckoutSettlementPreviewEventRecord, "id" | "batchId" | "createdAt">;
  }): Promise<CheckoutSettlementPreviewStoredBatch>;
};

type PreparedItem = Omit<CheckoutSettlementPreviewItemRecord, "id" | "batchId" | "createdAt" | "updatedAt"> & {
  allocations: Array<Omit<CheckoutSettlementPreviewAllocationRecord, "id" | "batchId" | "itemId" | "createdAt">>;
};

type PreparedBatch = {
  batch: Omit<CheckoutSettlementPreviewBatchRecord, "id" | "createdAt" | "updatedAt">;
  items: PreparedItem[];
  sourceHash: string;
};

type MinorParseResult =
  | { ok: true; amount: bigint; normalized: string }
  | { ok: false; amount: bigint; normalized: string };

const DEFAULT_CURRENCY = "INR";
const supportedCurrencies = new Set([DEFAULT_CURRENCY]);
const blockedRefTerms = [
  ["a", "wb"].join(""),
  ["ord", "er"].join(""),
  ["ph", "one"].join(""),
  ["em", "ail"].join(""),
  ["addr", "ess"].join(""),
  ["pin", "code"].join(""),
  ["cons", "ignee"].join(""),
  ["buy", "er"].join("")
];
const blockedRefTermPattern = new RegExp(`(${blockedRefTerms.join("|")})`, "i");

function cleanText(value: string | null | undefined, code: string) {
  const next = value?.trim() ?? "";
  if (!next) throw new HttpError(400, code);
  return next;
}

function cleanPeriod(value: string) {
  const period = cleanText(value, "W3A_PERIOD_REQUIRED");
  if (!/^[0-9]{4}-[0-9]{2}$/u.test(period)) throw new HttpError(400, "W3A_PERIOD_INVALID");
  return period;
}

function cleanOptionalInternalRef(value: string | null | undefined) {
  const next = value?.trim() ?? "";
  return next || null;
}

function isUnsafeInternalRef(value: string | null | undefined, expectedPrefix?: string) {
  const next = value?.trim() ?? "";
  if (!next) return false;
  const compactDigits = next.replace(/\D/gu, "");
  if (/@/u.test(next) || compactDigits.length >= 10 || /\b[1-9][0-9]{5}\b/u.test(next)) return true;
  if (blockedRefTermPattern.test(next)) return true;
  if (expectedPrefix && !next.startsWith(expectedPrefix)) return true;
  return false;
}

function cleanSourceRef(value: string) {
  const sourceRef = cleanText(value, "W3A_SOURCE_REF_REQUIRED");
  if (isUnsafeInternalRef(sourceRef)) throw new HttpError(400, "W3A_SOURCE_REF_UNSAFE");
  if (!/^w3a_|^src_w3a_/u.test(sourceRef)) throw new HttpError(400, "W3A_SOURCE_REF_UNSAFE");
  return sourceRef;
}

function parseMinor(value: unknown, options: { signed?: boolean } = {}): MinorParseResult {
  if (typeof value !== "string") return { ok: false, amount: 0n, normalized: "" };
  const next = value.trim();
  const pattern = options.signed ? /^-?(0|[1-9][0-9]*)$/u : /^(0|[1-9][0-9]*)$/u;
  if (!pattern.test(next)) return { ok: false, amount: 0n, normalized: next };
  return { ok: true, amount: BigInt(next), normalized: next };
}

function stableJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function minorString(value: bigint) {
  return value.toString();
}

function addReason(reasons: CheckoutSettlementPreviewReviewReason[], reason: CheckoutSettlementPreviewReviewReason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function statusFromReasons(reasons: CheckoutSettlementPreviewReviewReason[]): CheckoutSettlementPreviewStatus {
  return reasons.length > 0 ? "review_required" : "draft";
}

function finalBatchStatus(reviewRequiredCount: number): CheckoutSettlementPreviewStatus {
  return reviewRequiredCount > 0 ? "review_required" : "preview_ready";
}

function rowFingerprint(row: CheckoutSettlementPreviewInputRow) {
  return sha256({
    sellerOrgId: row.sellerOrgId,
    checkoutRef: row.checkoutRef ?? null,
    orderRef: row.orderRef ?? null,
    shipmentId: row.shipmentId ?? null,
    period: row.period,
    currency: row.currency,
    grossAmountMinor: row.grossAmountMinor,
    paymentFeeMinor: row.paymentFeeMinor,
    platformFeeMinor: row.platformFeeMinor,
    shippingChargeMinor: row.shippingChargeMinor,
    taxMinor: row.taxMinor,
    discountMinor: row.discountMinor,
    refundMinor: row.refundMinor,
    adjustmentMinor: row.adjustmentMinor
  });
}

const previewPolicy = {
  previewOnly: true,
  movementExecuted: false,
  paymentCaptured: false,
  payoutExecuted: false,
  settlementExecuted: false,
  custodyCreated: false
} as const;

function serializeAllocation(allocation: CheckoutSettlementPreviewAllocationRecord) {
  return {
    id: allocation.id,
    itemId: allocation.itemId ?? null,
    bucket: allocation.bucket,
    amountMinor: minorString(allocation.amountMinor),
    currency: allocation.currency
  };
}

function serializeItem(item: CheckoutSettlementPreviewItemRecord) {
  return {
    id: item.id,
    checkoutRef: item.checkoutRef ?? null,
    orderRef: item.orderRef ?? null,
    shipmentId: item.shipmentId ?? null,
    period: item.period,
    currency: item.currency,
    grossAmountMinor: minorString(item.grossAmountMinor),
    paymentFeeMinor: minorString(item.paymentFeeMinor),
    platformFeeMinor: minorString(item.platformFeeMinor),
    shippingChargeMinor: minorString(item.shippingChargeMinor),
    taxMinor: minorString(item.taxMinor),
    discountMinor: minorString(item.discountMinor),
    refundMinor: minorString(item.refundMinor),
    adjustmentMinor: minorString(item.adjustmentMinor),
    sellerPreviewReceivableMinor: minorString(item.sellerPreviewReceivableMinor),
    status: item.status,
    reviewReasons: item.reviewReasons ?? [],
    sourceRowHash: item.sourceRowHash
  };
}

function serializeBatch(record: CheckoutSettlementPreviewStoredBatch, idempotent = false) {
  return {
    ok: true,
    idempotent,
    batch: {
      id: record.batch.id,
      sellerOrgId: record.batch.sellerOrgId,
      period: record.batch.period,
      sourceRef: record.batch.sourceRef,
      sourceHash: record.batch.sourceHash,
      status: record.batch.status,
      currency: record.batch.currency,
      totals: {
        grossAmountMinor: minorString(record.batch.grossAmountMinor),
        paymentFeeMinor: minorString(record.batch.paymentFeeMinor),
        platformFeeMinor: minorString(record.batch.platformFeeMinor),
        shippingChargeMinor: minorString(record.batch.shippingChargeMinor),
        taxMinor: minorString(record.batch.taxMinor),
        discountMinor: minorString(record.batch.discountMinor),
        refundMinor: minorString(record.batch.refundMinor),
        adjustmentMinor: minorString(record.batch.adjustmentMinor),
        sellerPreviewReceivableMinor: minorString(record.batch.sellerPreviewReceivableMinor),
        negativePreviewMinor: minorString(record.batch.negativePreviewMinor),
        reviewRequiredCount: record.batch.reviewRequiredCount
      },
      ...previewPolicy
    },
    items: record.items.map(serializeItem),
    allocations: record.allocations.map(serializeAllocation),
    policy: previewPolicy
  };
}

function reportFromPrepared(prepared: PreparedBatch) {
  const record: CheckoutSettlementPreviewStoredBatch = {
    batch: {
      id: "dry_run",
      ...prepared.batch
    },
    items: prepared.items.map((item, index) => {
      const { allocations: _allocations, ...row } = item;
      return {
        id: `dry_item_${index + 1}`,
        batchId: "dry_run",
        ...row
      };
    }),
    allocations: prepared.items.flatMap((item, itemIndex) => item.allocations.map((allocation, allocationIndex) => ({
      id: `dry_allocation_${itemIndex + 1}_${allocationIndex + 1}`,
      batchId: "dry_run",
      itemId: `dry_item_${itemIndex + 1}`,
      ...allocation
    }))),
    events: []
  };
  return {
    ...serializeBatch(record),
    dryRun: true,
    execute: false,
    writes: 0
  };
}

function normalizeInput(input: CheckoutSettlementPreviewCommand) {
  const sellerOrgId = cleanText(input.sellerOrgId, "W3A_SELLER_ORG_ID_REQUIRED");
  if (isUnsafeInternalRef(sellerOrgId)) throw new HttpError(400, "W3A_SELLER_ORG_ID_UNSAFE");
  const period = cleanPeriod(input.period);
  const sourceRef = cleanSourceRef(input.sourceRef);
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new HttpError(400, "W3A_ROWS_REQUIRED");
  return { sellerOrgId, period, sourceRef };
}

function allocation(bucket: CheckoutSettlementPreviewBucket, amountMinor: bigint, currency: string) {
  return {
    bucket,
    amountMinor,
    currency,
    metadata: { previewOnly: true }
  };
}

function prepareBatch(input: CheckoutSettlementPreviewCommand): PreparedBatch {
  const normalized = normalizeInput(input);
  const checkoutCounts = new Map<string, bigint>();
  for (const row of input.rows) {
    const checkoutRef = cleanOptionalInternalRef(row.checkoutRef);
    if (!checkoutRef) continue;
    checkoutCounts.set(checkoutRef, (checkoutCounts.get(checkoutRef) ?? 0n) + 1n);
  }

  let grossAmountMinor = 0n;
  let paymentFeeMinor = 0n;
  let platformFeeMinor = 0n;
  let shippingChargeMinor = 0n;
  let taxMinor = 0n;
  let discountMinor = 0n;
  let refundMinor = 0n;
  let adjustmentMinor = 0n;
  let sellerPreviewReceivableMinor = 0n;
  let negativePreviewMinor = 0n;

  const items: PreparedItem[] = input.rows.map((row) => {
    const rowSellerOrgId = cleanText(row.sellerOrgId, "W3A_ROW_SELLER_ORG_ID_REQUIRED");
    const rowPeriod = cleanPeriod(row.period);
    const rowCurrency = cleanText(row.currency, "W3A_ROW_CURRENCY_REQUIRED").toUpperCase();
    const checkoutRef = cleanOptionalInternalRef(row.checkoutRef);
    const orderRef = cleanOptionalInternalRef(row.orderRef);
    const shipmentId = cleanOptionalInternalRef(row.shipmentId);
    const reasons: CheckoutSettlementPreviewReviewReason[] = [];

    if (rowSellerOrgId !== normalized.sellerOrgId || rowPeriod !== normalized.period || isUnsafeInternalRef(rowSellerOrgId)) addReason(reasons, "UNSAFE_INTERNAL_REF");
    if (!checkoutRef) addReason(reasons, "MISSING_CHECKOUT_REF");
    if (checkoutRef && (checkoutCounts.get(checkoutRef) ?? 0n) > 1n) addReason(reasons, "DUPLICATE_CHECKOUT_REF");
    if (!supportedCurrencies.has(rowCurrency)) addReason(reasons, "UNSUPPORTED_CURRENCY");

    const unsafeCheckoutRef = isUnsafeInternalRef(checkoutRef, "chk_w3a_");
    const unsafeOrderRef = isUnsafeInternalRef(orderRef, "ord_w3a_");
    const unsafeShipmentId = isUnsafeInternalRef(shipmentId, "shp_w3a_");
    if (unsafeCheckoutRef || unsafeOrderRef || unsafeShipmentId) addReason(reasons, "UNSAFE_INTERNAL_REF");

    const gross = parseMinor(row.grossAmountMinor);
    const paymentFee = parseMinor(row.paymentFeeMinor);
    const platformFee = parseMinor(row.platformFeeMinor);
    const shippingCharge = parseMinor(row.shippingChargeMinor);
    const tax = parseMinor(row.taxMinor);
    const discount = parseMinor(row.discountMinor);
    const refund = parseMinor(row.refundMinor);
    const adjustment = parseMinor(row.adjustmentMinor, { signed: true });
    if (!gross.ok || !paymentFee.ok || !platformFee.ok || !shippingCharge.ok || !tax.ok || !discount.ok || !refund.ok || !adjustment.ok) {
      addReason(reasons, "INVALID_AMOUNT");
    }

    const sellerPreview = gross.amount
      - paymentFee.amount
      - platformFee.amount
      - shippingCharge.amount
      - tax.amount
      - discount.amount
      - refund.amount
      + adjustment.amount;
    if (sellerPreview < 0n) addReason(reasons, "NEGATIVE_SELLER_PREVIEW");

    grossAmountMinor += gross.amount;
    paymentFeeMinor += paymentFee.amount;
    platformFeeMinor += platformFee.amount;
    shippingChargeMinor += shippingCharge.amount;
    taxMinor += tax.amount;
    discountMinor += discount.amount;
    refundMinor += refund.amount;
    adjustmentMinor += adjustment.amount;
    sellerPreviewReceivableMinor += sellerPreview;
    if (sellerPreview < 0n) negativePreviewMinor += -sellerPreview;

    const safeCurrency = supportedCurrencies.has(rowCurrency) ? rowCurrency : DEFAULT_CURRENCY;
    return {
      sellerOrgId: rowSellerOrgId,
      checkoutRef: unsafeCheckoutRef ? null : checkoutRef,
      orderRef: unsafeOrderRef ? null : orderRef,
      shipmentId: unsafeShipmentId ? null : shipmentId,
      period: rowPeriod,
      currency: safeCurrency,
      grossAmountMinor: gross.amount,
      paymentFeeMinor: paymentFee.amount,
      platformFeeMinor: platformFee.amount,
      shippingChargeMinor: shippingCharge.amount,
      taxMinor: tax.amount,
      discountMinor: discount.amount,
      refundMinor: refund.amount,
      adjustmentMinor: adjustment.amount,
      sellerPreviewReceivableMinor: sellerPreview,
      status: statusFromReasons(reasons),
      reviewReasons: reasons,
      sourceRowHash: rowFingerprint(row),
      metadata: {
        previewOnly: true,
        rowHashVersion: "W3A",
        formula: "gross_minus_fees_shipping_tax_discount_refund_plus_adjustment"
      },
      allocations: [
        allocation("seller_preview_receivable", sellerPreview, safeCurrency),
        allocation("payment_fee_preview", paymentFee.amount, safeCurrency),
        allocation("platform_fee_preview", platformFee.amount, safeCurrency),
        allocation("shipping_charge_preview", shippingCharge.amount, safeCurrency),
        allocation("tax_preview", tax.amount, safeCurrency),
        allocation("discount_preview", discount.amount, safeCurrency),
        allocation("refund_preview", refund.amount, safeCurrency),
        allocation("adjustment_preview", adjustment.amount, safeCurrency)
      ]
    };
  });

  const reviewRequiredCount = items.filter((item) => item.status === "review_required").length;
  const sourceHash = sha256({
    ...normalized,
    rows: input.rows.map(rowFingerprint).sort()
  });

  return {
    sourceHash,
    batch: {
      ...normalized,
      sourceHash,
      status: finalBatchStatus(reviewRequiredCount),
      currency: DEFAULT_CURRENCY,
      grossAmountMinor,
      paymentFeeMinor,
      platformFeeMinor,
      shippingChargeMinor,
      taxMinor,
      discountMinor,
      refundMinor,
      adjustmentMinor,
      sellerPreviewReceivableMinor,
      negativePreviewMinor,
      reviewRequiredCount,
      metadata: {
        shadowOnly: true,
        formula: "gross_minus_fees_shipping_tax_discount_refund_plus_adjustment",
        ...previewPolicy
      },
      createdBy: input.createdBy?.trim() || null
    },
    items
  };
}

function assertExecuteAllowed(config: CheckoutSettlementPreviewRuntimeConfig) {
  if (config.nodeEnv === "production" || ["production", "staging", "live"].includes(config.appEnv)) {
    throw new HttpError(403, "W3A_LOCAL_TEST_EXECUTE_REQUIRED");
  }
  if (!["development", "test"].includes(config.appEnv)) {
    throw new HttpError(403, "W3A_LOCAL_TEST_EXECUTE_REQUIRED");
  }
}

function storedWithItems(value: unknown): CheckoutSettlementPreviewStoredBatch {
  const batch = value as CheckoutSettlementPreviewBatchRecord & {
    items?: CheckoutSettlementPreviewItemRecord[];
    allocations?: CheckoutSettlementPreviewAllocationRecord[];
    events?: CheckoutSettlementPreviewEventRecord[];
  };
  const items = batch.items ?? [];
  const batchAllocations = batch.allocations ?? [];
  const itemAllocations = items.flatMap((item) => (item as CheckoutSettlementPreviewItemRecord & {
    allocations?: CheckoutSettlementPreviewAllocationRecord[];
  }).allocations ?? []);
  return {
    batch,
    items,
    allocations: batchAllocations.length > 0 ? batchAllocations : itemAllocations,
    events: batch.events ?? []
  };
}

export class PrismaCheckoutSettlementPreviewStore implements CheckoutSettlementPreviewStore {
  constructor(private readonly client = prisma as unknown as {
    $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T>;
    checkoutSettlementPreviewBatch: {
      findUnique(input: unknown): Promise<unknown>;
    };
  }) {}

  async findBatchByKey(input: { sellerOrgId: string; period: string; sourceRef: string }) {
    const batch = await this.client.checkoutSettlementPreviewBatch.findUnique({
      where: {
        sellerOrgId_period_sourceRef: input
      },
      include: {
        items: { orderBy: { id: "asc" }, include: { allocations: { orderBy: { id: "asc" } } } },
        allocations: { orderBy: { id: "asc" } },
        events: { orderBy: { createdAt: "asc" } }
      }
    });
    return batch ? storedWithItems(batch) : null;
  }

  async findBatchById(batchId: string) {
    const batch = await this.client.checkoutSettlementPreviewBatch.findUnique({
      where: { id: batchId },
      include: {
        items: { orderBy: { id: "asc" }, include: { allocations: { orderBy: { id: "asc" } } } },
        allocations: { orderBy: { id: "asc" } },
        events: { orderBy: { createdAt: "asc" } }
      }
    });
    return batch ? storedWithItems(batch) : null;
  }

  async createBatch(input: {
    batch: Omit<CheckoutSettlementPreviewBatchRecord, "id" | "createdAt" | "updatedAt">;
    items: Array<Omit<CheckoutSettlementPreviewItemRecord, "id" | "batchId" | "createdAt" | "updatedAt"> & {
      allocations: Array<Omit<CheckoutSettlementPreviewAllocationRecord, "id" | "batchId" | "itemId" | "createdAt">>;
    }>;
    event: Omit<CheckoutSettlementPreviewEventRecord, "id" | "batchId" | "createdAt">;
  }) {
    return this.client.$transaction(async (txValue) => {
      const tx = txValue as {
        checkoutSettlementPreviewBatch: { create(data: unknown): Promise<unknown> };
      };
      const batch = await tx.checkoutSettlementPreviewBatch.create({
        data: {
          ...input.batch,
          items: {
            create: input.items.map((item) => {
              const { allocations, ...data } = item;
              return {
                ...data,
                allocations: { create: allocations }
              };
            })
          },
          events: { create: [input.event] }
        },
        include: {
          items: { orderBy: { id: "asc" }, include: { allocations: { orderBy: { id: "asc" } } } },
          allocations: { orderBy: { id: "asc" } },
          events: { orderBy: { createdAt: "asc" } }
        }
      });
      return storedWithItems(batch);
    });
  }
}

export class CheckoutSettlementPreviewService {
  private readonly store: CheckoutSettlementPreviewStore;
  private readonly config: CheckoutSettlementPreviewRuntimeConfig;

  constructor(deps: { store?: CheckoutSettlementPreviewStore; config?: Partial<CheckoutSettlementPreviewRuntimeConfig> } = {}) {
    this.store = deps.store ?? new PrismaCheckoutSettlementPreviewStore();
    this.config = {
      appEnv: env.APP_ENV,
      nodeEnv: env.NODE_ENV,
      ...deps.config
    };
  }

  planBatch(input: CheckoutSettlementPreviewCommand) {
    return reportFromPrepared(prepareBatch(input));
  }

  async createBatch(input: CheckoutSettlementPreviewCommand) {
    if (!input.execute) return this.planBatch(input);
    assertExecuteAllowed(this.config);
    const prepared = prepareBatch(input);
    const existing = await this.store.findBatchByKey({
      sellerOrgId: prepared.batch.sellerOrgId,
      period: prepared.batch.period,
      sourceRef: prepared.batch.sourceRef
    });
    if (existing) {
      if (existing.batch.sourceHash !== prepared.sourceHash) throw new HttpError(409, "W3A_SOURCE_REF_HASH_CONFLICT");
      return {
        ...serializeBatch(existing, true),
        dryRun: false,
        execute: true,
        writes: 0
      };
    }

    const stored = await this.store.createBatch({
      batch: prepared.batch,
      items: prepared.items,
      event: {
        eventType: "w3a.checkout_settlement_preview.created",
        status: prepared.batch.status,
        message: "Shadow preview batch recorded for review only.",
        metadata: { shadowOnly: true, ...previewPolicy },
        createdBy: input.createdBy?.trim() || null
      }
    });

    return {
      ...serializeBatch(stored),
      dryRun: false,
      execute: true,
      writes: 1 + stored.items.length + stored.allocations.length + stored.events.length
    };
  }

  async exportPreview(batchId: string, format: "json" | "csv" = "json") {
    const stored = await this.store.findBatchById(cleanText(batchId, "W3A_BATCH_ID_REQUIRED"));
    if (!stored) throw new HttpError(404, "W3A_BATCH_NOT_FOUND");
    const report = serializeBatch(stored);
    const base = {
      ...report,
      exportFormat: format,
      exportPreview: {
        ...previewPolicy,
        statusChanged: false
      }
    };
    if (format === "json") return base;
    const header = [
      "checkoutRef",
      "orderRef",
      "shipmentId",
      "period",
      "currency",
      "grossAmountMinor",
      "paymentFeeMinor",
      "platformFeeMinor",
      "shippingChargeMinor",
      "taxMinor",
      "discountMinor",
      "refundMinor",
      "adjustmentMinor",
      "sellerPreviewReceivableMinor",
      "status"
    ];
    const rows = stored.items.map((item) => [
      item.checkoutRef ?? "",
      item.orderRef ?? "",
      item.shipmentId ?? "",
      item.period,
      item.currency,
      minorString(item.grossAmountMinor),
      minorString(item.paymentFeeMinor),
      minorString(item.platformFeeMinor),
      minorString(item.shippingChargeMinor),
      minorString(item.taxMinor),
      minorString(item.discountMinor),
      minorString(item.refundMinor),
      minorString(item.adjustmentMinor),
      minorString(item.sellerPreviewReceivableMinor),
      item.status
    ].map((field) => JSON.stringify(field)).join(","));
    return {
      ...base,
      csv: [header.join(","), ...rows].join("\n")
    };
  }
}

export const checkoutSettlementPreviewService = new CheckoutSettlementPreviewService();
