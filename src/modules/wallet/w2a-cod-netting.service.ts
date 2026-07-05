import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";

export const codNettingInstructionStatuses = [
  "draft",
  "review_required",
  "approved_instruction",
  "exported_instruction",
  "voided"
] as const;

export const codNettingInstructionTypes = [
  "seller_receivable_instruction",
  "seller_payable_to_platform_or_courier_instruction",
  "zero_net_instruction"
] as const;

export type CodNettingInstructionStatus = typeof codNettingInstructionStatuses[number];
export type CodNettingInstructionType = typeof codNettingInstructionTypes[number];

export type CodNettingReviewReason =
  | "NEGATIVE_NET"
  | "MISSING_SHIPMENT_ID"
  | "DUPLICATE_SHIPMENT_ID"
  | "INVALID_AMOUNT"
  | "UNKNOWN_COURIER_CODE"
  | "UNSAFE_INTERNAL_REF";

export type CodNettingInputRow = {
  sellerOrgId: string;
  shipmentId?: string | null;
  courierCode: string;
  deliveredAt?: string | Date | null;
  codCollectedMinor: string;
  freightDeductionMinor: string;
  rtoDeductionMinor: string;
  adjustmentMinor: string;
  expectedRemittanceMinor?: string | null;
  remittanceRef?: string | null;
  period: string;
};

export type CodNettingBatchCommand = {
  sellerOrgId: string;
  courierCode: string;
  period: string;
  sourceRef: string;
  rows: CodNettingInputRow[];
  execute?: boolean;
  createdBy?: string | null;
};

export type CodNettingRuntimeConfig = {
  appEnv: string;
  nodeEnv: string;
};

export type CodNettingBatchRecord = {
  id: string;
  sellerOrgId: string;
  courierCode: string;
  period: string;
  sourceRef: string;
  sourceHash: string;
  status: CodNettingInstructionStatus;
  currency: string;
  codCollectedMinor: bigint;
  freightDeductionMinor: bigint;
  rtoDeductionMinor: bigint;
  adjustmentMinor: bigint;
  sellerNetReceivableMinor: bigint;
  negativeNetMinor: bigint;
  reviewRequiredCount: number;
  metadata?: unknown;
  createdBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type CodNettingItemRecord = {
  id: string;
  batchId: string;
  sellerOrgId: string;
  courierCode: string;
  period: string;
  shipmentId?: string | null;
  deliveredAt?: Date | null;
  codCollectedMinor: bigint;
  freightDeductionMinor: bigint;
  rtoDeductionMinor: bigint;
  adjustmentMinor: bigint;
  expectedRemittanceMinor?: bigint | null;
  remittanceRef?: string | null;
  sellerNetReceivableMinor: bigint;
  instructionType: CodNettingInstructionType;
  status: CodNettingInstructionStatus;
  reviewReasons?: CodNettingReviewReason[] | null;
  sourceRowHash: string;
  metadata?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

export type CodNettingEventRecord = {
  id: string;
  batchId: string;
  itemId?: string | null;
  eventType: string;
  status: CodNettingInstructionStatus;
  message?: string | null;
  metadata?: unknown;
  createdBy?: string | null;
  createdAt?: Date;
};

export type CodNettingStoredBatch = {
  batch: CodNettingBatchRecord;
  items: CodNettingItemRecord[];
  events: CodNettingEventRecord[];
};

export type CodNettingStore = {
  findBatchByKey(input: {
    sellerOrgId: string;
    courierCode: string;
    period: string;
    sourceRef: string;
  }): Promise<CodNettingStoredBatch | null>;
  findBatchById(batchId: string): Promise<CodNettingStoredBatch | null>;
  createBatch(input: {
    batch: Omit<CodNettingBatchRecord, "id" | "createdAt" | "updatedAt">;
    items: Array<Omit<CodNettingItemRecord, "id" | "batchId" | "createdAt" | "updatedAt">>;
    event: Omit<CodNettingEventRecord, "id" | "batchId" | "createdAt">;
  }): Promise<CodNettingStoredBatch>;
  updateBatchStatus(input: {
    batchId: string;
    status: CodNettingInstructionStatus;
    eventType: string;
    message?: string | null;
    createdBy?: string | null;
  }): Promise<CodNettingStoredBatch>;
};

type PreparedItem = Omit<CodNettingItemRecord, "id" | "batchId" | "createdAt" | "updatedAt">;

type PreparedBatch = {
  batch: Omit<CodNettingBatchRecord, "id" | "createdAt" | "updatedAt">;
  items: PreparedItem[];
  sourceHash: string;
};

type MinorParseResult =
  | { ok: true; amount: bigint; normalized: string }
  | { ok: false; amount: bigint; normalized: string };

const DEFAULT_CURRENCY = "INR";
const knownCourierCodes = new Set(["BIGSHIP_SYNTHETIC", "SHIPROCKET_SYNTHETIC", "DELHIVERY_SYNTHETIC", "MANUAL_SYNTHETIC"]);
const blockedRefTerms = [
  ["a", "wb"].join(""),
  ["ord", "er"].join(""),
  ["pho", "ne"].join(""),
  ["em", "ail"].join(""),
  ["addr", "ess"].join(""),
  ["pin", "code"].join(""),
  ["buy", "er"].join("")
];
const blockedRefTermPattern = new RegExp(`(${blockedRefTerms.join("|")})`, "i");

function cleanText(value: string | null | undefined, code: string) {
  const next = value?.trim() ?? "";
  if (!next) throw new HttpError(400, code);
  return next;
}

function cleanPeriod(value: string) {
  const period = cleanText(value, "W2A_PERIOD_REQUIRED");
  if (!/^[0-9]{4}-[0-9]{2}$/u.test(period)) throw new HttpError(400, "W2A_PERIOD_INVALID");
  return period;
}

function normalizeCourierCode(value: string) {
  const courierCode = cleanText(value, "W2A_COURIER_CODE_REQUIRED").toUpperCase().replace(/[^A-Z0-9_-]/gu, "_");
  if (!courierCode) throw new HttpError(400, "W2A_COURIER_CODE_REQUIRED");
  return courierCode;
}

function cleanOptionalInternalRef(value: string | null | undefined) {
  const next = value?.trim() ?? "";
  return next || null;
}

function isUnsafeInternalRef(value: string | null | undefined) {
  const next = value?.trim() ?? "";
  if (!next) return false;
  const compactDigits = next.replace(/\D/gu, "");
  return /@/u.test(next)
    || compactDigits.length >= 10
    || /\b[1-9][0-9]{5}\b/u.test(next)
    || blockedRefTermPattern.test(next);
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

function statusFromReasons(reasons: CodNettingReviewReason[]): CodNettingInstructionStatus {
  return reasons.length > 0 ? "review_required" : "draft";
}

function instructionTypeFor(netMinor: bigint): CodNettingInstructionType {
  if (netMinor < 0n) return "seller_payable_to_platform_or_courier_instruction";
  if (netMinor === 0n) return "zero_net_instruction";
  return "seller_receivable_instruction";
}

function parseDeliveredAt(value: string | Date | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return date.toString() === "Invalid Date" ? null : date;
}

function rowFingerprint(row: CodNettingInputRow) {
  return sha256({
    sellerOrgId: row.sellerOrgId,
    shipmentId: row.shipmentId ?? null,
    courierCode: row.courierCode,
    deliveredAt: row.deliveredAt instanceof Date ? row.deliveredAt.toISOString() : row.deliveredAt ?? null,
    codCollectedMinor: row.codCollectedMinor,
    freightDeductionMinor: row.freightDeductionMinor,
    rtoDeductionMinor: row.rtoDeductionMinor,
    adjustmentMinor: row.adjustmentMinor,
    expectedRemittanceMinor: row.expectedRemittanceMinor ?? null,
    remittanceRef: row.remittanceRef ?? null,
    period: row.period
  });
}

function serializeItem(item: CodNettingItemRecord) {
  return {
    id: item.id,
    shipmentId: item.shipmentId ?? null,
    courierCode: item.courierCode,
    period: item.period,
    deliveredAt: item.deliveredAt ? item.deliveredAt.toISOString() : null,
    codCollectedMinor: minorString(item.codCollectedMinor),
    freightDeductionMinor: minorString(item.freightDeductionMinor),
    rtoDeductionMinor: minorString(item.rtoDeductionMinor),
    adjustmentMinor: minorString(item.adjustmentMinor),
    expectedRemittanceMinor: item.expectedRemittanceMinor == null ? null : minorString(item.expectedRemittanceMinor),
    sellerNetReceivableMinor: minorString(item.sellerNetReceivableMinor),
    instructionType: item.instructionType,
    status: item.status,
    reviewReasons: item.reviewReasons ?? [],
    sourceRowHash: item.sourceRowHash
  };
}

function serializeBatch(record: CodNettingStoredBatch, idempotent = false) {
  return {
    ok: true,
    idempotent,
    batch: {
      id: record.batch.id,
      sellerOrgId: record.batch.sellerOrgId,
      courierCode: record.batch.courierCode,
      period: record.batch.period,
      sourceRef: record.batch.sourceRef,
      sourceHash: record.batch.sourceHash,
      status: record.batch.status,
      currency: record.batch.currency,
      totals: {
        codCollectedMinor: minorString(record.batch.codCollectedMinor),
        freightDeductionMinor: minorString(record.batch.freightDeductionMinor),
        rtoDeductionMinor: minorString(record.batch.rtoDeductionMinor),
        adjustmentMinor: minorString(record.batch.adjustmentMinor),
        sellerNetReceivableMinor: minorString(record.batch.sellerNetReceivableMinor),
        negativeNetMinor: minorString(record.batch.negativeNetMinor),
        reviewRequiredCount: record.batch.reviewRequiredCount
      },
      instructionOnly: true,
      movementExecuted: false
    },
    items: record.items.map(serializeItem)
  };
}

function reportFromPrepared(prepared: PreparedBatch) {
  const record: CodNettingStoredBatch = {
    batch: {
      id: "dry_run",
      ...prepared.batch
    },
    items: prepared.items.map((item, index) => ({
      id: `dry_item_${index + 1}`,
      batchId: "dry_run",
      ...item
    })),
    events: []
  };
  return {
    ...serializeBatch(record),
    dryRun: true,
    execute: false
  };
}

function normalizeInput(input: CodNettingBatchCommand) {
  const sellerOrgId = cleanText(input.sellerOrgId, "W2A_SELLER_ORG_ID_REQUIRED");
  const courierCode = normalizeCourierCode(input.courierCode);
  const period = cleanPeriod(input.period);
  const sourceRef = cleanText(input.sourceRef, "W2A_SOURCE_REF_REQUIRED");
  if (isUnsafeInternalRef(sourceRef)) throw new HttpError(400, "W2A_SOURCE_REF_UNSAFE");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new HttpError(400, "W2A_ROWS_REQUIRED");
  return { sellerOrgId, courierCode, period, sourceRef };
}

function addReason(reasons: CodNettingReviewReason[], reason: CodNettingReviewReason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function prepareBatch(input: CodNettingBatchCommand): PreparedBatch {
  const normalized = normalizeInput(input);
  const shipmentCounts = new Map<string, bigint>();
  for (const row of input.rows) {
    const shipmentId = cleanOptionalInternalRef(row.shipmentId);
    if (!shipmentId) continue;
    shipmentCounts.set(shipmentId, (shipmentCounts.get(shipmentId) ?? 0n) + 1n);
  }

  let codCollectedMinor = 0n;
  let freightDeductionMinor = 0n;
  let rtoDeductionMinor = 0n;
  let adjustmentMinor = 0n;
  let sellerNetReceivableMinor = 0n;
  let negativeNetMinor = 0n;

  const items: PreparedItem[] = input.rows.map((row) => {
    const rowSellerOrgId = cleanText(row.sellerOrgId, "W2A_ROW_SELLER_ORG_ID_REQUIRED");
    const rowCourierCode = normalizeCourierCode(row.courierCode);
    const rowPeriod = cleanPeriod(row.period);
    const shipmentId = cleanOptionalInternalRef(row.shipmentId);
    const remittanceRef = cleanOptionalInternalRef(row.remittanceRef);
    const reasons: CodNettingReviewReason[] = [];

    if (rowSellerOrgId !== normalized.sellerOrgId || rowPeriod !== normalized.period) addReason(reasons, "UNSAFE_INTERNAL_REF");
    if (rowCourierCode !== normalized.courierCode || !knownCourierCodes.has(rowCourierCode)) addReason(reasons, "UNKNOWN_COURIER_CODE");
    if (!shipmentId) addReason(reasons, "MISSING_SHIPMENT_ID");
    if (shipmentId && (shipmentCounts.get(shipmentId) ?? 0n) > 1n) addReason(reasons, "DUPLICATE_SHIPMENT_ID");
    const unsafeShipmentId = isUnsafeInternalRef(shipmentId);
    const unsafeRemittanceRef = isUnsafeInternalRef(remittanceRef);
    if (unsafeShipmentId || unsafeRemittanceRef) addReason(reasons, "UNSAFE_INTERNAL_REF");

    const collected = parseMinor(row.codCollectedMinor);
    const freight = parseMinor(row.freightDeductionMinor);
    const rto = parseMinor(row.rtoDeductionMinor);
    const adjustment = parseMinor(row.adjustmentMinor, { signed: true });
    const expected = row.expectedRemittanceMinor == null || row.expectedRemittanceMinor.trim() === ""
      ? null
      : parseMinor(row.expectedRemittanceMinor);
    if (!collected.ok || !freight.ok || !rto.ok || !adjustment.ok || (expected !== null && !expected.ok)) {
      addReason(reasons, "INVALID_AMOUNT");
    }

    const net = collected.amount - freight.amount - rto.amount + adjustment.amount;
    if (net < 0n) addReason(reasons, "NEGATIVE_NET");

    codCollectedMinor += collected.amount;
    freightDeductionMinor += freight.amount;
    rtoDeductionMinor += rto.amount;
    adjustmentMinor += adjustment.amount;
    sellerNetReceivableMinor += net;
    if (net < 0n) negativeNetMinor += -net;

    return {
      sellerOrgId: rowSellerOrgId,
      courierCode: rowCourierCode,
      period: rowPeriod,
      shipmentId: unsafeShipmentId ? null : shipmentId,
      deliveredAt: parseDeliveredAt(row.deliveredAt),
      codCollectedMinor: collected.amount,
      freightDeductionMinor: freight.amount,
      rtoDeductionMinor: rto.amount,
      adjustmentMinor: adjustment.amount,
      expectedRemittanceMinor: expected === null ? null : expected.amount,
      remittanceRef: unsafeRemittanceRef ? null : remittanceRef,
      sellerNetReceivableMinor: net,
      instructionType: instructionTypeFor(net),
      status: statusFromReasons(reasons),
      reviewReasons: reasons,
      sourceRowHash: rowFingerprint(row),
      metadata: {
        instructionOnly: true,
        rowHashVersion: "W2A"
      }
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
      status: reviewRequiredCount > 0 ? "review_required" : "draft",
      currency: DEFAULT_CURRENCY,
      codCollectedMinor,
      freightDeductionMinor,
      rtoDeductionMinor,
      adjustmentMinor,
      sellerNetReceivableMinor,
      negativeNetMinor,
      reviewRequiredCount,
      metadata: {
        instructionOnly: true,
        formula: "cod_collected_minus_deductions_plus_adjustment",
        movementExecuted: false
      },
      createdBy: input.createdBy?.trim() || null
    },
    items
  };
}

function assertExecuteAllowed(config: CodNettingRuntimeConfig) {
  if (config.nodeEnv === "production" || config.appEnv === "production" || config.appEnv === "staging") {
    throw new HttpError(403, "W2A_LOCAL_TEST_EXECUTE_REQUIRED");
  }
  if (!["development", "test"].includes(config.appEnv)) {
    throw new HttpError(403, "W2A_LOCAL_TEST_EXECUTE_REQUIRED");
  }
}

function storedWithItems(value: unknown): CodNettingStoredBatch {
  const batch = value as CodNettingBatchRecord & { items?: CodNettingItemRecord[]; events?: CodNettingEventRecord[] };
  return {
    batch,
    items: batch.items ?? [],
    events: batch.events ?? []
  };
}

export class PrismaCodNettingStore implements CodNettingStore {
  constructor(private readonly client = prisma as unknown as {
    $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T>;
    codNettingBatch: {
      findUnique(input: unknown): Promise<unknown>;
    };
  }) {}

  async findBatchByKey(input: { sellerOrgId: string; courierCode: string; period: string; sourceRef: string }) {
    const batch = await this.client.codNettingBatch.findUnique({
      where: {
        sellerOrgId_courierCode_period_sourceRef: input
      },
      include: { items: { orderBy: { id: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
    });
    return batch ? storedWithItems(batch) : null;
  }

  async findBatchById(batchId: string) {
    const batch = await this.client.codNettingBatch.findUnique({
      where: { id: batchId },
      include: { items: { orderBy: { id: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
    });
    return batch ? storedWithItems(batch) : null;
  }

  async createBatch(input: {
    batch: Omit<CodNettingBatchRecord, "id" | "createdAt" | "updatedAt">;
    items: Array<Omit<CodNettingItemRecord, "id" | "batchId" | "createdAt" | "updatedAt">>;
    event: Omit<CodNettingEventRecord, "id" | "batchId" | "createdAt">;
  }) {
    return this.client.$transaction(async (txValue) => {
      const tx = txValue as {
        codNettingBatch: { create(data: unknown): Promise<unknown> };
      };
      const batch = await tx.codNettingBatch.create({
        data: {
          ...input.batch,
          items: { create: input.items },
          events: { create: [input.event] }
        },
        include: { items: { orderBy: { id: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
      });
      return storedWithItems(batch);
    });
  }

  async updateBatchStatus(input: {
    batchId: string;
    status: CodNettingInstructionStatus;
    eventType: string;
    message?: string | null;
    createdBy?: string | null;
  }) {
    return this.client.$transaction(async (txValue) => {
      const tx = txValue as {
        codNettingBatch: {
          update(data: unknown): Promise<unknown>;
        };
      };
      const batch = await tx.codNettingBatch.update({
        where: { id: input.batchId },
        data: {
          status: input.status,
          events: {
            create: [{
              eventType: input.eventType,
              status: input.status,
              message: input.message ?? null,
              createdBy: input.createdBy ?? null,
              metadata: { instructionOnly: true, movementExecuted: false }
            }]
          }
        },
        include: { items: { orderBy: { id: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
      });
      return storedWithItems(batch);
    });
  }
}

export class CodInstructionNettingService {
  private readonly store: CodNettingStore;
  private readonly config: CodNettingRuntimeConfig;

  constructor(deps: { store?: CodNettingStore; config?: Partial<CodNettingRuntimeConfig> } = {}) {
    this.store = deps.store ?? new PrismaCodNettingStore();
    this.config = {
      appEnv: env.APP_ENV,
      nodeEnv: env.NODE_ENV,
      ...deps.config
    };
  }

  planBatch(input: CodNettingBatchCommand) {
    return reportFromPrepared(prepareBatch(input));
  }

  async createBatch(input: CodNettingBatchCommand) {
    if (!input.execute) return this.planBatch(input);
    assertExecuteAllowed(this.config);
    const prepared = prepareBatch(input);
    const existing = await this.store.findBatchByKey({
      sellerOrgId: prepared.batch.sellerOrgId,
      courierCode: prepared.batch.courierCode,
      period: prepared.batch.period,
      sourceRef: prepared.batch.sourceRef
    });
    if (existing) {
      if (existing.batch.sourceHash !== prepared.sourceHash) {
        throw new HttpError(409, "W2A_SOURCE_REF_HASH_CONFLICT");
      }
      return {
        ...serializeBatch(existing, true),
        dryRun: false,
        execute: true
      };
    }

    const stored = await this.store.createBatch({
      batch: prepared.batch,
      items: prepared.items,
      event: {
        eventType: "w2a.cod_netting_batch.created",
        status: prepared.batch.status,
        message: "Instruction batch recorded for review/export only.",
        metadata: { instructionOnly: true, movementExecuted: false },
        createdBy: input.createdBy?.trim() || null
      }
    });

    return {
      ...serializeBatch(stored),
      dryRun: false,
      execute: true
    };
  }
}

export class CodNettingBatchService {
  constructor(private readonly store: CodNettingStore = new PrismaCodNettingStore()) {}

  async approveInstructionBatch(batchId: string, input: { approvedBy?: string | null } = {}) {
    const stored = await this.store.findBatchById(cleanText(batchId, "W2A_BATCH_ID_REQUIRED"));
    if (!stored) throw new HttpError(404, "W2A_BATCH_NOT_FOUND");
    if (stored.batch.status === "voided") throw new HttpError(400, "W2A_BATCH_VOIDED");
    if (stored.batch.reviewRequiredCount > 0 || stored.items.some((item) => item.status === "review_required")) {
      throw new HttpError(409, "W2A_REVIEW_REQUIRED");
    }
    const approved = await this.store.updateBatchStatus({
      batchId,
      status: "approved_instruction",
      eventType: "w2a.cod_netting_batch.approved",
      message: "Instruction batch approved; no movement is executed.",
      createdBy: input.approvedBy?.trim() || null
    });
    return serializeBatch(approved);
  }

  async exportInstructionReport(batchId: string, format: "json" | "csv" = "json") {
    const stored = await this.store.findBatchById(cleanText(batchId, "W2A_BATCH_ID_REQUIRED"));
    if (!stored) throw new HttpError(404, "W2A_BATCH_NOT_FOUND");
    const report = serializeBatch(stored);
    const base = {
      ...report,
      exportFormat: format,
      instructionOnly: true,
      movementExecuted: false
    };
    if (format === "json") return base;
    const header = [
      "shipmentId",
      "courierCode",
      "period",
      "codCollectedMinor",
      "freightDeductionMinor",
      "rtoDeductionMinor",
      "adjustmentMinor",
      "sellerNetReceivableMinor",
      "instructionType",
      "status"
    ];
    const rows = stored.items.map((item) => [
      item.shipmentId ?? "",
      item.courierCode,
      item.period,
      minorString(item.codCollectedMinor),
      minorString(item.freightDeductionMinor),
      minorString(item.rtoDeductionMinor),
      minorString(item.adjustmentMinor),
      minorString(item.sellerNetReceivableMinor),
      item.instructionType,
      item.status
    ].map((field) => JSON.stringify(field)).join(","));
    return {
      ...base,
      csv: [header.join(","), ...rows].join("\n")
    };
  }
}

export class CodNettingReadService {
  constructor(private readonly store: CodNettingStore = new PrismaCodNettingStore()) {}

  async getInstructionBatch(batchId: string) {
    const stored = await this.store.findBatchById(cleanText(batchId, "W2A_BATCH_ID_REQUIRED"));
    if (!stored) throw new HttpError(404, "W2A_BATCH_NOT_FOUND");
    return {
      ...serializeBatch(stored),
      policy: {
        mode: "instruction_only",
        movementExecuted: false,
        spendableBalanceCreated: false
      }
    };
  }
}

export class W2CodReadinessService {
  getReadiness() {
    return {
      ok: false,
      status: "blocked",
      phase: "W2A",
      instructionOnlyAvailable: true,
      blockingIssues: [
        "W2_LIVE_APPROVAL_REQUIRED",
        "W2_COD_CUSTODY_NOT_APPROVED",
        "W3_NOT_APPROVED"
      ],
      warnings: [
        "W2A_EXPORTS_REVIEW_INSTRUCTIONS_ONLY",
        "NO_MONEY_MOVEMENT_SUPPORTED"
      ]
    };
  }
}

export const codInstructionNettingService = new CodInstructionNettingService();
export const codNettingBatchService = new CodNettingBatchService();
export const codNettingReadService = new CodNettingReadService();
export const w2CodReadinessService = new W2CodReadinessService();
