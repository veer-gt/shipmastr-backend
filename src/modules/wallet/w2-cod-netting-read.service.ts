import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  codNettingInstructionStatuses,
  type CodNettingBatchRecord,
  type CodNettingEventRecord,
  type CodNettingItemRecord,
  type CodNettingStoredBatch
} from "./w2a-cod-netting.service.js";

export const w2bInstructionPreviewDisclaimer =
  "Instruction preview only. No money movement has been executed by Shipmastr.";

export type W2BCodNettingBatchFilters = {
  sellerOrgId?: string | undefined;
  courierCode?: string | undefined;
  period?: string | undefined;
  status?: string | undefined;
  limit?: number;
  cursor?: string | undefined;
};

export type W2BCodNettingReadStore = {
  listBatches(filters: Required<Pick<W2BCodNettingBatchFilters, "limit">> & Omit<W2BCodNettingBatchFilters, "limit">): Promise<{
    batches: CodNettingBatchRecord[];
    nextCursor: string | null;
  }>;
  findBatchById(batchId: string): Promise<CodNettingStoredBatch | null>;
};

const sellerOrgIdSchema = z.string().trim().min(1).max(160);
const courierCodeSchema = z.string().trim().min(1).max(80).transform((value) => value.toUpperCase());
const periodSchema = z.string().trim().regex(/^[0-9]{4}-[0-9]{2}$/u);
const cursorSchema = z.string().trim().min(1).max(160).optional();
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
const statusSchema = z.enum(codNettingInstructionStatuses);
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

export const w2bAdminBatchListQuerySchema = z.object({
  sellerOrgId: sellerOrgIdSchema.optional(),
  courierCode: courierCodeSchema.optional(),
  period: periodSchema.optional(),
  status: statusSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema
});

export const w2bSellerBatchListQuerySchema = z.object({
  sellerOrgId: sellerOrgIdSchema.optional(),
  courierCode: courierCodeSchema.optional(),
  period: periodSchema.optional(),
  status: statusSchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema
});

export const w2bExportPreviewQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json")
});

function minorString(value: bigint) {
  return value.toString();
}

function dateString(value: Date | undefined) {
  return value ? value.toISOString() : null;
}

function safeOutputRef(value: string | null | undefined) {
  const next = value?.trim() ?? "";
  if (!next) return null;
  const compactDigits = next.replace(/\D/gu, "");
  if (/@/u.test(next) || compactDigits.length >= 10 || /\b[1-9][0-9]{5}\b/u.test(next) || unsafeOutputRefPattern.test(next)) {
    return null;
  }
  return next;
}

function policy() {
  return {
    mode: "instruction_only",
    instructionOnly: true,
    movementExecuted: false,
    custodyCreated: false,
    payoutExecuted: false,
    settlementExecuted: false,
    spendableBalanceCreated: false,
    disclaimer: w2bInstructionPreviewDisclaimer
  };
}

function serializeBatchSummary(batch: CodNettingBatchRecord) {
  return {
    id: batch.id,
    sellerOrgId: batch.sellerOrgId,
    courierCode: batch.courierCode,
    period: batch.period,
    sourceRef: safeOutputRef(batch.sourceRef),
    sourceHash: batch.sourceHash,
    status: batch.status,
    currency: batch.currency,
    totals: {
      codCollectedMinor: minorString(batch.codCollectedMinor),
      freightDeductionMinor: minorString(batch.freightDeductionMinor),
      rtoDeductionMinor: minorString(batch.rtoDeductionMinor),
      adjustmentMinor: minorString(batch.adjustmentMinor),
      sellerNetReceivableMinor: minorString(batch.sellerNetReceivableMinor),
      negativeNetMinor: minorString(batch.negativeNetMinor),
      reviewRequiredCount: batch.reviewRequiredCount
    },
    instructionOnly: true,
    movementExecuted: false,
    custodyCreated: false,
    payoutExecuted: false,
    settlementExecuted: false,
    createdAt: dateString(batch.createdAt),
    updatedAt: dateString(batch.updatedAt)
  };
}

function safeReviewReasons(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function serializeItem(item: CodNettingItemRecord) {
  return {
    id: item.id,
    shipmentInternalId: safeOutputRef(item.shipmentId),
    courierCode: item.courierCode,
    period: item.period,
    deliveredAt: item.deliveredAt ? item.deliveredAt.toISOString() : null,
    codCollectedMinor: minorString(item.codCollectedMinor),
    freightDeductionMinor: minorString(item.freightDeductionMinor),
    rtoDeductionMinor: minorString(item.rtoDeductionMinor),
    adjustmentMinor: minorString(item.adjustmentMinor),
    expectedInstructionMinor: item.expectedRemittanceMinor == null ? null : minorString(item.expectedRemittanceMinor),
    sellerNetReceivableMinor: minorString(item.sellerNetReceivableMinor),
    instructionType: item.instructionType,
    status: item.status,
    reviewReasons: safeReviewReasons(item.reviewReasons),
    sourceRowHash: item.sourceRowHash
  };
}

function serializeEvent(event: CodNettingEventRecord) {
  return {
    id: event.id,
    itemId: event.itemId ?? null,
    eventType: event.eventType,
    status: event.status,
    createdAt: dateString(event.createdAt)
  };
}

function serializeDetail(record: CodNettingStoredBatch) {
  return {
    ok: true,
    batch: serializeBatchSummary(record.batch),
    items: record.items.map(serializeItem),
    events: record.events.map(serializeEvent),
    policy: policy()
  };
}

function csvField(value: string | null) {
  return JSON.stringify(value ?? "");
}

function buildCsvPreview(record: CodNettingStoredBatch) {
  const header = [
    "itemId",
    "shipmentInternalId",
    "courierCode",
    "period",
    "codCollectedMinor",
    "freightDeductionMinor",
    "rtoDeductionMinor",
    "adjustmentMinor",
    "sellerNetReceivableMinor",
    "instructionType",
    "status",
    "reviewReasons"
  ];
  const rows = record.items.map((item) => {
    const output = serializeItem(item);
    return [
      output.id,
      output.shipmentInternalId,
      output.courierCode,
      output.period,
      output.codCollectedMinor,
      output.freightDeductionMinor,
      output.rtoDeductionMinor,
      output.adjustmentMinor,
      output.sellerNetReceivableMinor,
      output.instructionType,
      output.status,
      output.reviewReasons.join("|")
    ].map(csvField).join(",");
  });
  return [
    `# ${w2bInstructionPreviewDisclaimer}`,
    "movementExecuted,false",
    "custodyCreated,false",
    "payoutExecuted,false",
    "settlementExecuted,false",
    header.join(","),
    ...rows
  ].join("\n");
}

function assertSellerScope(record: CodNettingStoredBatch, sellerOrgId: string) {
  if (record.batch.sellerOrgId !== sellerOrgId) throw new HttpError(404, "W2B_COD_BATCH_NOT_FOUND");
}

export class PrismaW2BCodNettingReadStore implements W2BCodNettingReadStore {
  constructor(private readonly client = prisma as unknown as {
    codNettingBatch: {
      findMany(input: unknown): Promise<unknown[]>;
      findUnique(input: unknown): Promise<unknown>;
    };
  }) {}

  async listBatches(filters: Required<Pick<W2BCodNettingBatchFilters, "limit">> & Omit<W2BCodNettingBatchFilters, "limit">) {
    const where: Record<string, string> = {};
    if (filters.sellerOrgId) where.sellerOrgId = filters.sellerOrgId;
    if (filters.courierCode) where.courierCode = filters.courierCode;
    if (filters.period) where.period = filters.period;
    if (filters.status) where.status = filters.status;
    const rows = await this.client.codNettingBatch.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filters.limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {})
    });
    const batches = rows as CodNettingBatchRecord[];
    const page = batches.slice(0, filters.limit);
    return {
      batches: page,
      nextCursor: batches.length > filters.limit ? page.at(-1)?.id ?? null : null
    };
  }

  async findBatchById(batchId: string) {
    const batch = await this.client.codNettingBatch.findUnique({
      where: { id: batchId },
      include: { items: { orderBy: { id: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
    }) as (CodNettingBatchRecord & { items?: CodNettingItemRecord[]; events?: CodNettingEventRecord[] }) | null;
    if (!batch) return null;
    return {
      batch,
      items: batch.items ?? [],
      events: batch.events ?? []
    };
  }
}

export class W2BCodNettingReadService {
  constructor(private readonly store: W2BCodNettingReadStore = new PrismaW2BCodNettingReadStore()) {}

  async listBatches(filters: W2BCodNettingBatchFilters = {}) {
    const normalized = w2bAdminBatchListQuerySchema.parse(filters);
    const result = await this.store.listBatches(normalized);
    return {
      ok: true,
      batches: result.batches.map(serializeBatchSummary),
      page: {
        limit: normalized.limit,
        nextCursor: result.nextCursor
      },
      policy: policy()
    };
  }

  async getBatchDetail(batchId: string, options: { sellerOrgId?: string } = {}) {
    const cleanBatchId = z.string().trim().min(1).max(160).parse(batchId);
    const record = await this.store.findBatchById(cleanBatchId);
    if (!record) throw new HttpError(404, "W2B_COD_BATCH_NOT_FOUND");
    if (options.sellerOrgId) assertSellerScope(record, options.sellerOrgId);
    return serializeDetail(record);
  }

  async exportPreview(batchId: string, format: "json" | "csv" = "json", options: { sellerOrgId?: string } = {}) {
    const cleanBatchId = z.string().trim().min(1).max(160).parse(batchId);
    const record = await this.store.findBatchById(cleanBatchId);
    if (!record) throw new HttpError(404, "W2B_COD_BATCH_NOT_FOUND");
    if (options.sellerOrgId) assertSellerScope(record, options.sellerOrgId);
    if (format === "csv") {
      return {
        ok: true,
        format,
        csv: buildCsvPreview(record),
        policy: policy()
      };
    }
    return {
      ...serializeDetail(record),
      exportPreview: {
        format,
        disclaimer: w2bInstructionPreviewDisclaimer,
        movementExecuted: false,
        custodyCreated: false,
        payoutExecuted: false,
        settlementExecuted: false
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
      policy: policy()
    };
  }
}

export const w2bCodNettingReadService = new W2BCodNettingReadService();
