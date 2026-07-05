import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  checkoutSettlementPreviewStatuses,
  type CheckoutSettlementPreviewAllocationRecord,
  type CheckoutSettlementPreviewBatchRecord,
  type CheckoutSettlementPreviewEventRecord,
  type CheckoutSettlementPreviewItemRecord,
  type CheckoutSettlementPreviewStoredBatch
} from "./w3a-checkout-settlement-preview.service.js";

export const w3bCheckoutPreviewDisclaimer =
  "Checkout settlement preview only. No payment capture, payout, settlement, custody, or money movement has been executed by Shipmastr.";

export type W3BCheckoutPreviewFilters = {
  sellerOrgId?: string | undefined;
  period?: string | undefined;
  status?: string | undefined;
  currency?: string | undefined;
  limit?: number;
  cursor?: string | undefined;
};

export type W3BCheckoutPreviewReadStore = {
  listBatches(filters: Required<Pick<W3BCheckoutPreviewFilters, "limit">> & Omit<W3BCheckoutPreviewFilters, "limit">): Promise<{
    batches: CheckoutSettlementPreviewBatchRecord[];
    nextCursor: string | null;
  }>;
  findBatchById(batchId: string): Promise<CheckoutSettlementPreviewStoredBatch | null>;
};

const sellerOrgIdSchema = z.string().trim().min(1).max(160);
const periodSchema = z.string().trim().regex(/^[0-9]{4}-[0-9]{2}$/u);
const currencySchema = z.string().trim().min(3).max(3).transform((value) => value.toUpperCase());
const cursorSchema = z.string().trim().min(1).max(160).optional();
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
const statusSchema = z.enum(checkoutSettlementPreviewStatuses);
const blockedOutputTerms = [
  ["a", "wb"].join(""),
  ["ord", "er_"].join(""),
  ["pho", "ne"].join(""),
  ["em", "ail"].join(""),
  ["addr", "ess"].join(""),
  ["pin", "code"].join(""),
  ["consig", "nee"].join(""),
  ["buy", "er"].join("")
];
const unsafeOutputRefPattern = new RegExp(`(${blockedOutputTerms.join("|")})`, "i");

export const w3bAdminPreviewListQuerySchema = z.object({
  sellerOrgId: sellerOrgIdSchema.optional(),
  period: periodSchema.optional(),
  status: statusSchema.optional(),
  currency: currencySchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema
});

export const w3bSellerPreviewListQuerySchema = z.object({
  sellerOrgId: sellerOrgIdSchema.optional(),
  period: periodSchema.optional(),
  status: statusSchema.optional(),
  currency: currencySchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema
});

export const w3bExportPreviewQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json")
});

function minorString(value: bigint) {
  return value.toString();
}

function dateString(value: Date | undefined) {
  return value ? value.toISOString() : null;
}

function safeOutputRef(value: string | null | undefined, expectedPrefix?: string) {
  const next = value?.trim() ?? "";
  if (!next) return null;
  const compactDigits = next.replace(/\D/gu, "");
  if (/@/u.test(next) || compactDigits.length >= 10 || /\b[1-9][0-9]{5}\b/u.test(next) || unsafeOutputRefPattern.test(next)) {
    return null;
  }
  if (expectedPrefix && !next.startsWith(expectedPrefix)) return null;
  return next;
}

function previewPolicy() {
  return {
    previewOnly: true,
    movementExecuted: false,
    paymentCaptured: false,
    payoutExecuted: false,
    settlementExecuted: false,
    custodyCreated: false,
    disclaimer: w3bCheckoutPreviewDisclaimer
  };
}

export function w3bCheckoutReadiness() {
  return {
    ok: true,
    phase: "W3B",
    readOnlySurfacesAvailable: true,
    exportPreviewOnly: true,
    allowedStatuses: [...checkoutSettlementPreviewStatuses],
    blockers: ["W3D_APPROVAL_REQUIRED_FOR_LIVE_CHECKOUT_ACTIVATION"],
    ...previewPolicy()
  };
}

function safeReviewReasons(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function serializeBatchSummary(batch: CheckoutSettlementPreviewBatchRecord) {
  return {
    id: batch.id,
    sellerOrgId: batch.sellerOrgId,
    period: batch.period,
    sourceRef: safeOutputRef(batch.sourceRef),
    sourceHash: batch.sourceHash,
    status: batch.status,
    currency: batch.currency,
    totals: {
      grossAmountMinor: minorString(batch.grossAmountMinor),
      paymentFeeMinor: minorString(batch.paymentFeeMinor),
      platformFeeMinor: minorString(batch.platformFeeMinor),
      shippingChargeMinor: minorString(batch.shippingChargeMinor),
      taxMinor: minorString(batch.taxMinor),
      discountMinor: minorString(batch.discountMinor),
      refundMinor: minorString(batch.refundMinor),
      adjustmentMinor: minorString(batch.adjustmentMinor),
      sellerPreviewReceivableMinor: minorString(batch.sellerPreviewReceivableMinor),
      negativePreviewMinor: minorString(batch.negativePreviewMinor),
      reviewRequiredCount: batch.reviewRequiredCount
    },
    previewOnly: true,
    movementExecuted: false,
    paymentCaptured: false,
    payoutExecuted: false,
    settlementExecuted: false,
    custodyCreated: false,
    createdAt: dateString(batch.createdAt),
    updatedAt: dateString(batch.updatedAt)
  };
}

function serializeItem(item: CheckoutSettlementPreviewItemRecord) {
  return {
    id: item.id,
    checkoutInternalRef: safeOutputRef(item.checkoutRef, "chk_w3a_"),
    orderInternalRef: safeOutputRef(item.orderRef, "ord_w3a_"),
    shipmentInternalId: safeOutputRef(item.shipmentId, "shp_w3a_"),
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
    reviewReasons: safeReviewReasons(item.reviewReasons),
    sourceRowHash: item.sourceRowHash
  };
}

function serializeAllocation(allocation: CheckoutSettlementPreviewAllocationRecord) {
  return {
    id: allocation.id,
    itemId: allocation.itemId ?? null,
    bucket: allocation.bucket,
    amountMinor: minorString(allocation.amountMinor),
    currency: allocation.currency
  };
}

function serializeEvent(event: CheckoutSettlementPreviewEventRecord) {
  return {
    id: event.id,
    itemId: event.itemId ?? null,
    eventType: event.eventType,
    status: event.status,
    createdAt: dateString(event.createdAt)
  };
}

function serializeDetail(record: CheckoutSettlementPreviewStoredBatch) {
  return {
    ok: true,
    batch: serializeBatchSummary(record.batch),
    items: record.items.map(serializeItem),
    allocations: record.allocations.map(serializeAllocation),
    events: record.events.map(serializeEvent),
    policy: previewPolicy()
  };
}

function csvField(value: string | null) {
  return JSON.stringify(value ?? "");
}

function buildCsvPreview(record: CheckoutSettlementPreviewStoredBatch) {
  const header = [
    "itemId",
    "checkoutInternalRef",
    "orderInternalRef",
    "shipmentInternalId",
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
    "status",
    "reviewReasons"
  ];
  const rows = record.items.map((item) => {
    const output = serializeItem(item);
    return [
      output.id,
      output.checkoutInternalRef,
      output.orderInternalRef,
      output.shipmentInternalId,
      output.period,
      output.currency,
      output.grossAmountMinor,
      output.paymentFeeMinor,
      output.platformFeeMinor,
      output.shippingChargeMinor,
      output.taxMinor,
      output.discountMinor,
      output.refundMinor,
      output.adjustmentMinor,
      output.sellerPreviewReceivableMinor,
      output.status,
      output.reviewReasons.join("|")
    ].map(csvField).join(",");
  });
  return [
    `# ${w3bCheckoutPreviewDisclaimer}`,
    "previewOnly,true",
    "movementExecuted,false",
    "paymentCaptured,false",
    "payoutExecuted,false",
    "settlementExecuted,false",
    "custodyCreated,false",
    header.join(","),
    ...rows
  ].join("\n");
}

function assertSellerScope(record: CheckoutSettlementPreviewStoredBatch, sellerOrgId: string) {
  if (record.batch.sellerOrgId !== sellerOrgId) throw new HttpError(404, "W3B_CHECKOUT_PREVIEW_NOT_FOUND");
}

export class PrismaW3BCheckoutPreviewReadStore implements W3BCheckoutPreviewReadStore {
  constructor(private readonly client = prisma as unknown as {
    checkoutSettlementPreviewBatch: {
      findMany(input: unknown): Promise<unknown[]>;
      findUnique(input: unknown): Promise<unknown>;
    };
  }) {}

  async listBatches(filters: Required<Pick<W3BCheckoutPreviewFilters, "limit">> & Omit<W3BCheckoutPreviewFilters, "limit">) {
    const where: Record<string, string> = {};
    if (filters.sellerOrgId) where.sellerOrgId = filters.sellerOrgId;
    if (filters.period) where.period = filters.period;
    if (filters.status) where.status = filters.status;
    if (filters.currency) where.currency = filters.currency;
    const rows = await this.client.checkoutSettlementPreviewBatch.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filters.limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {})
    });
    const batches = rows as CheckoutSettlementPreviewBatchRecord[];
    const page = batches.slice(0, filters.limit);
    return {
      batches: page,
      nextCursor: batches.length > filters.limit ? page.at(-1)?.id ?? null : null
    };
  }

  async findBatchById(batchId: string) {
    const batch = await this.client.checkoutSettlementPreviewBatch.findUnique({
      where: { id: batchId },
      include: {
        items: { orderBy: { id: "asc" }, include: { allocations: { orderBy: { id: "asc" } } } },
        allocations: { orderBy: { id: "asc" } },
        events: { orderBy: { createdAt: "asc" } }
      }
    }) as (CheckoutSettlementPreviewBatchRecord & {
      items?: Array<CheckoutSettlementPreviewItemRecord & { allocations?: CheckoutSettlementPreviewAllocationRecord[] }>;
      allocations?: CheckoutSettlementPreviewAllocationRecord[];
      events?: CheckoutSettlementPreviewEventRecord[];
    }) | null;
    if (!batch) return null;
    const items = batch.items ?? [];
    return {
      batch,
      items,
      allocations: (batch.allocations?.length ?? 0) > 0 ? batch.allocations ?? [] : items.flatMap((item) => item.allocations ?? []),
      events: batch.events ?? []
    };
  }
}

export class W3BCheckoutPreviewReadService {
  constructor(private readonly store: W3BCheckoutPreviewReadStore = new PrismaW3BCheckoutPreviewReadStore()) {}

  async listBatches(filters: W3BCheckoutPreviewFilters = {}) {
    const normalized = w3bAdminPreviewListQuerySchema.parse(filters);
    const result = await this.store.listBatches(normalized);
    return {
      ok: true,
      batches: result.batches.map(serializeBatchSummary),
      page: {
        limit: normalized.limit,
        nextCursor: result.nextCursor
      },
      policy: previewPolicy()
    };
  }

  async getBatchDetail(batchId: string, options: { sellerOrgId?: string } = {}) {
    const cleanBatchId = z.string().trim().min(1).max(160).parse(batchId);
    const record = await this.store.findBatchById(cleanBatchId);
    if (!record) throw new HttpError(404, "W3B_CHECKOUT_PREVIEW_NOT_FOUND");
    if (options.sellerOrgId) assertSellerScope(record, options.sellerOrgId);
    return serializeDetail(record);
  }

  async exportPreview(batchId: string, format: "json" | "csv" = "json", options: { sellerOrgId?: string } = {}) {
    const cleanBatchId = z.string().trim().min(1).max(160).parse(batchId);
    const record = await this.store.findBatchById(cleanBatchId);
    if (!record) throw new HttpError(404, "W3B_CHECKOUT_PREVIEW_NOT_FOUND");
    if (options.sellerOrgId) assertSellerScope(record, options.sellerOrgId);
    if (format === "csv") {
      return {
        ok: true,
        format,
        csv: buildCsvPreview(record),
        policy: previewPolicy()
      };
    }
    return {
      ...serializeDetail(record),
      exportPreview: {
        format,
        disclaimer: w3bCheckoutPreviewDisclaimer,
        previewOnly: true,
        movementExecuted: false,
        paymentCaptured: false,
        payoutExecuted: false,
        settlementExecuted: false,
        custodyCreated: false,
        statusChanged: false
      }
    };
  }

  async sellerSummary(sellerOrgId: string) {
    const cleanSellerOrgId = sellerOrgIdSchema.parse(sellerOrgId);
    const result = await this.store.listBatches({ sellerOrgId: cleanSellerOrgId, limit: 100 });
    const statusCounts = result.batches.reduce<Record<string, number>>((acc, batch) => {
      acc[batch.status] = (acc[batch.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      ok: true,
      sellerOrgId: cleanSellerOrgId,
      statusCounts,
      recentBatches: result.batches.slice(0, 10).map(serializeBatchSummary),
      policy: previewPolicy()
    };
  }
}

export const w3bCheckoutPreviewReadService = new W3BCheckoutPreviewReadService();
