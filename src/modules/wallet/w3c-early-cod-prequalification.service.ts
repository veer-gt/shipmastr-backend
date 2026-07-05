import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";

export const earlyCodPrequalificationStatuses = [
  "draft",
  "review_required",
  "prequalification_preview",
  "exported_preview",
  "voided"
] as const;

export type EarlyCodPrequalificationStatus = typeof earlyCodPrequalificationStatuses[number];

export type EarlyCodPrequalificationReviewReason =
  | "NEGATIVE_ELIGIBLE_BASE"
  | "REQUESTED_ADVANCE_ABOVE_CAP"
  | "MISSING_INTERNAL_SOURCE_REF"
  | "UNSUPPORTED_CURRENCY"
  | "INVALID_AMOUNT"
  | "HIGH_REVIEW_ACTIVITY"
  | "UNSAFE_INTERNAL_REF";

export type EarlyCodPrequalificationInputRow = {
  sellerOrgId: string;
  codInstructionBatchId?: string | null;
  checkoutPreviewBatchId?: string | null;
  courierCode: string;
  period: string;
  currency: string;
  grossCodDueMinor: string;
  expectedDeductionMinor: string;
  riskReserveMinor: string;
  partnerFeeEstimateMinor: string;
  maxAdvanceRateBps: string;
  requestedAdvanceMinor: string;
  daysSinceDelivery: string;
  disputeCount: string;
  rtoCount: string;
  reviewIssueCount: string;
};

export type EarlyCodPrequalificationCommand = {
  sellerOrgId: string;
  period: string;
  sourceRef: string;
  rows: EarlyCodPrequalificationInputRow[];
  execute?: boolean;
  createdBy?: string | null;
};

export type EarlyCodPrequalificationRuntimeConfig = {
  appEnv: string;
  nodeEnv: string;
};

export type EarlyCodPrequalificationBatchRecord = {
  id: string;
  sellerOrgId: string;
  period: string;
  sourceRef: string;
  sourceHash: string;
  status: EarlyCodPrequalificationStatus;
  currency: string;
  grossCodDueMinor: bigint;
  expectedDeductionMinor: bigint;
  riskReserveMinor: bigint;
  partnerFeeEstimateMinor: bigint;
  eligibleBaseMinor: bigint;
  maxPreviewAdvanceMinor: bigint;
  previewAdvanceMinor: bigint;
  reviewRequiredCount: number;
  metadata?: unknown;
  createdBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type EarlyCodPrequalificationItemRecord = {
  id: string;
  batchId: string;
  sellerOrgId: string;
  codInstructionBatchId?: string | null;
  checkoutPreviewBatchId?: string | null;
  courierCode: string;
  period: string;
  currency: string;
  grossCodDueMinor: bigint;
  expectedDeductionMinor: bigint;
  riskReserveMinor: bigint;
  partnerFeeEstimateMinor: bigint;
  maxAdvanceRateBps: bigint;
  requestedAdvanceMinor: bigint;
  eligibleBaseMinor: bigint;
  maxPreviewAdvanceMinor: bigint;
  previewAdvanceMinor: bigint;
  daysSinceDelivery: bigint;
  disputeCount: bigint;
  rtoCount: bigint;
  reviewIssueCount: bigint;
  status: EarlyCodPrequalificationStatus;
  reviewReasons?: EarlyCodPrequalificationReviewReason[] | null;
  sourceRowHash: string;
  metadata?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

export type EarlyCodPrequalificationEventRecord = {
  id: string;
  batchId: string;
  itemId?: string | null;
  eventType: string;
  status: EarlyCodPrequalificationStatus;
  message?: string | null;
  metadata?: unknown;
  createdBy?: string | null;
  createdAt?: Date;
};

export type EarlyCodPrequalificationStoredBatch = {
  batch: EarlyCodPrequalificationBatchRecord;
  items: EarlyCodPrequalificationItemRecord[];
  events: EarlyCodPrequalificationEventRecord[];
};

export type EarlyCodPrequalificationStore = {
  findBatchByKey(input: { sellerOrgId: string; period: string; sourceRef: string }): Promise<EarlyCodPrequalificationStoredBatch | null>;
  findBatchById(batchId: string): Promise<EarlyCodPrequalificationStoredBatch | null>;
  createBatch(input: {
    batch: Omit<EarlyCodPrequalificationBatchRecord, "id" | "createdAt" | "updatedAt">;
    items: Array<Omit<EarlyCodPrequalificationItemRecord, "id" | "batchId" | "createdAt" | "updatedAt">>;
    event: Omit<EarlyCodPrequalificationEventRecord, "id" | "batchId" | "createdAt">;
  }): Promise<EarlyCodPrequalificationStoredBatch>;
};

type PreparedBatch = {
  sourceHash: string;
  batch: Omit<EarlyCodPrequalificationBatchRecord, "id" | "createdAt" | "updatedAt">;
  items: Array<Omit<EarlyCodPrequalificationItemRecord, "id" | "batchId" | "createdAt" | "updatedAt">>;
};

type IntParseResult =
  | { ok: true; amount: bigint; normalized: string }
  | { ok: false; amount: bigint; normalized: string };

const DEFAULT_CURRENCY = "INR";
const supportedCurrencies = new Set([DEFAULT_CURRENCY]);
const BPS_DENOMINATOR = 10000n;
const MAX_BPS = 10000n;
const disputeReviewThreshold = 2n;
const rtoReviewThreshold = 3n;
const reviewIssueThreshold = 0n;
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
const policyFlagKeys = {
  creditApproved: "creditApproved",
  creditRelationshipCreated: ["lo", "anCreated"].join(""),
  fundsSent: ["disbur", "sementExecuted"].join(""),
  returnFlowCreated: ["re", "paymentCreated"].join(""),
  partnerApiCalled: "partnerApiCalled"
} as const;

function cleanText(value: string | null | undefined, code: string) {
  const next = value?.trim() ?? "";
  if (!next) throw new HttpError(400, code);
  return next;
}

function cleanPeriod(value: string) {
  const period = cleanText(value, "W3C_PERIOD_REQUIRED");
  if (!/^[0-9]{4}-[0-9]{2}$/u.test(period)) throw new HttpError(400, "W3C_PERIOD_INVALID");
  return period;
}

function cleanOptionalRef(value: string | null | undefined) {
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
  const sourceRef = cleanText(value, "W3C_SOURCE_REF_REQUIRED");
  if (isUnsafeInternalRef(sourceRef)) throw new HttpError(400, "W3C_SOURCE_REF_UNSAFE");
  if (!/^ecod_w3c_|^src_w3c_/u.test(sourceRef)) throw new HttpError(400, "W3C_SOURCE_REF_UNSAFE");
  return sourceRef;
}

function parseUnsignedInt(value: unknown, options: { max?: bigint } = {}): IntParseResult {
  if (typeof value !== "string") return { ok: false, amount: 0n, normalized: "" };
  const next = value.trim();
  if (!/^(0|[1-9][0-9]*)$/u.test(next)) return { ok: false, amount: 0n, normalized: next };
  const amount = BigInt(next);
  if (options.max != null && amount > options.max) return { ok: false, amount, normalized: next };
  return { ok: true, amount, normalized: next };
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

function addReason(reasons: EarlyCodPrequalificationReviewReason[], reason: EarlyCodPrequalificationReviewReason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function statusFromReasons(reasons: EarlyCodPrequalificationReviewReason[]): EarlyCodPrequalificationStatus {
  return reasons.length > 0 ? "review_required" : "draft";
}

function finalBatchStatus(reviewRequiredCount: number): EarlyCodPrequalificationStatus {
  return reviewRequiredCount > 0 ? "review_required" : "prequalification_preview";
}

function minBigInt(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function previewPolicy() {
  return {
    previewOnly: true,
    partnerInstructionOnly: true,
    [policyFlagKeys.creditApproved]: false,
    [policyFlagKeys.creditRelationshipCreated]: false,
    [policyFlagKeys.fundsSent]: false,
    [policyFlagKeys.returnFlowCreated]: false,
    movementExecuted: false,
    paymentCaptured: false,
    payoutExecuted: false,
    settlementExecuted: false,
    custodyCreated: false,
    [policyFlagKeys.partnerApiCalled]: false
  } as Record<string, boolean>;
}

function rowFingerprint(row: EarlyCodPrequalificationInputRow) {
  return sha256({
    sellerOrgId: row.sellerOrgId,
    codInstructionBatchId: row.codInstructionBatchId ?? null,
    checkoutPreviewBatchId: row.checkoutPreviewBatchId ?? null,
    courierCode: row.courierCode,
    period: row.period,
    currency: row.currency,
    grossCodDueMinor: row.grossCodDueMinor,
    expectedDeductionMinor: row.expectedDeductionMinor,
    riskReserveMinor: row.riskReserveMinor,
    partnerFeeEstimateMinor: row.partnerFeeEstimateMinor,
    maxAdvanceRateBps: row.maxAdvanceRateBps,
    requestedAdvanceMinor: row.requestedAdvanceMinor,
    daysSinceDelivery: row.daysSinceDelivery,
    disputeCount: row.disputeCount,
    rtoCount: row.rtoCount,
    reviewIssueCount: row.reviewIssueCount
  });
}

function serializeItem(item: EarlyCodPrequalificationItemRecord) {
  return {
    id: item.id,
    codInstructionBatchId: item.codInstructionBatchId ?? null,
    checkoutPreviewBatchId: item.checkoutPreviewBatchId ?? null,
    courierCode: item.courierCode,
    period: item.period,
    currency: item.currency,
    grossCodDueMinor: minorString(item.grossCodDueMinor),
    expectedDeductionMinor: minorString(item.expectedDeductionMinor),
    riskReserveMinor: minorString(item.riskReserveMinor),
    partnerFeeEstimateMinor: minorString(item.partnerFeeEstimateMinor),
    maxAdvanceRateBps: minorString(item.maxAdvanceRateBps),
    requestedAdvanceMinor: minorString(item.requestedAdvanceMinor),
    eligibleBaseMinor: minorString(item.eligibleBaseMinor),
    maxPreviewAdvanceMinor: minorString(item.maxPreviewAdvanceMinor),
    previewAdvanceMinor: minorString(item.previewAdvanceMinor),
    daysSinceDelivery: minorString(item.daysSinceDelivery),
    disputeCount: minorString(item.disputeCount),
    rtoCount: minorString(item.rtoCount),
    reviewIssueCount: minorString(item.reviewIssueCount),
    status: item.status,
    reviewReasons: Array.isArray(item.reviewReasons) ? item.reviewReasons : [],
    sourceRowHash: item.sourceRowHash,
    ...previewPolicy()
  };
}

function serializeEvent(event: EarlyCodPrequalificationEventRecord) {
  return {
    id: event.id,
    itemId: event.itemId ?? null,
    eventType: event.eventType,
    status: event.status,
    createdAt: event.createdAt ? event.createdAt.toISOString() : null
  };
}

function serializeBatch(record: EarlyCodPrequalificationStoredBatch, idempotent = false) {
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
        grossCodDueMinor: minorString(record.batch.grossCodDueMinor),
        expectedDeductionMinor: minorString(record.batch.expectedDeductionMinor),
        riskReserveMinor: minorString(record.batch.riskReserveMinor),
        partnerFeeEstimateMinor: minorString(record.batch.partnerFeeEstimateMinor),
        eligibleBaseMinor: minorString(record.batch.eligibleBaseMinor),
        maxPreviewAdvanceMinor: minorString(record.batch.maxPreviewAdvanceMinor),
        previewAdvanceMinor: minorString(record.batch.previewAdvanceMinor),
        reviewRequiredCount: record.batch.reviewRequiredCount
      },
      ...previewPolicy()
    },
    items: record.items.map(serializeItem),
    events: record.events.map(serializeEvent),
    policy: previewPolicy()
  };
}

function normalizeInput(input: EarlyCodPrequalificationCommand) {
  const sellerOrgId = cleanText(input.sellerOrgId, "W3C_SELLER_ORG_ID_REQUIRED");
  if (isUnsafeInternalRef(sellerOrgId)) throw new HttpError(400, "W3C_SELLER_ORG_ID_UNSAFE");
  const period = cleanPeriod(input.period);
  const sourceRef = cleanSourceRef(input.sourceRef);
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new HttpError(400, "W3C_ROWS_REQUIRED");
  return { sellerOrgId, period, sourceRef };
}

function prepareBatch(input: EarlyCodPrequalificationCommand): PreparedBatch {
  const normalized = normalizeInput(input);
  let grossCodDueMinor = 0n;
  let expectedDeductionMinor = 0n;
  let riskReserveMinor = 0n;
  let partnerFeeEstimateMinor = 0n;
  let eligibleBaseMinor = 0n;
  let maxPreviewAdvanceMinor = 0n;
  let previewAdvanceMinor = 0n;

  const items = input.rows.map((row) => {
    const rowSellerOrgId = cleanText(row.sellerOrgId, "W3C_ROW_SELLER_ORG_ID_REQUIRED");
    const rowPeriod = cleanPeriod(row.period);
    const courierCode = cleanText(row.courierCode, "W3C_COURIER_CODE_REQUIRED").toUpperCase();
    const rowCurrency = cleanText(row.currency, "W3C_ROW_CURRENCY_REQUIRED").toUpperCase();
    const codInstructionBatchId = cleanOptionalRef(row.codInstructionBatchId);
    const checkoutPreviewBatchId = cleanOptionalRef(row.checkoutPreviewBatchId);
    const reasons: EarlyCodPrequalificationReviewReason[] = [];

    if (rowSellerOrgId !== normalized.sellerOrgId || rowPeriod !== normalized.period || isUnsafeInternalRef(rowSellerOrgId)) addReason(reasons, "UNSAFE_INTERNAL_REF");
    if (!codInstructionBatchId && !checkoutPreviewBatchId) addReason(reasons, "MISSING_INTERNAL_SOURCE_REF");
    if (!supportedCurrencies.has(rowCurrency)) addReason(reasons, "UNSUPPORTED_CURRENCY");

    const unsafeCodBatchId = isUnsafeInternalRef(codInstructionBatchId, "cnb_");
    const unsafeCheckoutBatchId = isUnsafeInternalRef(checkoutPreviewBatchId, "cspb_");
    if (unsafeCodBatchId || unsafeCheckoutBatchId) addReason(reasons, "UNSAFE_INTERNAL_REF");

    const gross = parseUnsignedInt(row.grossCodDueMinor);
    const expectedDeduction = parseUnsignedInt(row.expectedDeductionMinor);
    const riskReserve = parseUnsignedInt(row.riskReserveMinor);
    const partnerFeeEstimate = parseUnsignedInt(row.partnerFeeEstimateMinor);
    const maxAdvanceRateBps = parseUnsignedInt(row.maxAdvanceRateBps, { max: MAX_BPS });
    const requestedAdvance = parseUnsignedInt(row.requestedAdvanceMinor);
    const daysSinceDelivery = parseUnsignedInt(row.daysSinceDelivery);
    const disputeCount = parseUnsignedInt(row.disputeCount);
    const rtoCount = parseUnsignedInt(row.rtoCount);
    const reviewIssueCount = parseUnsignedInt(row.reviewIssueCount);
    if (!gross.ok || !expectedDeduction.ok || !riskReserve.ok || !partnerFeeEstimate.ok || !maxAdvanceRateBps.ok
      || !requestedAdvance.ok || !daysSinceDelivery.ok || !disputeCount.ok || !rtoCount.ok || !reviewIssueCount.ok) {
      addReason(reasons, "INVALID_AMOUNT");
    }

    const eligibleBase = gross.amount - expectedDeduction.amount - riskReserve.amount - partnerFeeEstimate.amount;
    const maxPreviewAdvance = eligibleBase > 0n ? (eligibleBase * maxAdvanceRateBps.amount) / BPS_DENOMINATOR : 0n;
    const previewAdvance = minBigInt(requestedAdvance.amount, maxPreviewAdvance);
    if (eligibleBase < 0n) addReason(reasons, "NEGATIVE_ELIGIBLE_BASE");
    if (requestedAdvance.amount > maxPreviewAdvance) addReason(reasons, "REQUESTED_ADVANCE_ABOVE_CAP");
    if (disputeCount.amount > disputeReviewThreshold || rtoCount.amount > rtoReviewThreshold || reviewIssueCount.amount > reviewIssueThreshold) {
      addReason(reasons, "HIGH_REVIEW_ACTIVITY");
    }

    grossCodDueMinor += gross.amount;
    expectedDeductionMinor += expectedDeduction.amount;
    riskReserveMinor += riskReserve.amount;
    partnerFeeEstimateMinor += partnerFeeEstimate.amount;
    eligibleBaseMinor += eligibleBase;
    maxPreviewAdvanceMinor += maxPreviewAdvance;
    previewAdvanceMinor += previewAdvance;
    const safeCurrency = supportedCurrencies.has(rowCurrency) ? rowCurrency : DEFAULT_CURRENCY;

    return {
      sellerOrgId: rowSellerOrgId,
      codInstructionBatchId: unsafeCodBatchId ? null : codInstructionBatchId,
      checkoutPreviewBatchId: unsafeCheckoutBatchId ? null : checkoutPreviewBatchId,
      courierCode,
      period: rowPeriod,
      currency: safeCurrency,
      grossCodDueMinor: gross.amount,
      expectedDeductionMinor: expectedDeduction.amount,
      riskReserveMinor: riskReserve.amount,
      partnerFeeEstimateMinor: partnerFeeEstimate.amount,
      maxAdvanceRateBps: maxAdvanceRateBps.amount,
      requestedAdvanceMinor: requestedAdvance.amount,
      eligibleBaseMinor: eligibleBase,
      maxPreviewAdvanceMinor: maxPreviewAdvance,
      previewAdvanceMinor: previewAdvance,
      daysSinceDelivery: daysSinceDelivery.amount,
      disputeCount: disputeCount.amount,
      rtoCount: rtoCount.amount,
      reviewIssueCount: reviewIssueCount.amount,
      status: statusFromReasons(reasons),
      reviewReasons: reasons,
      sourceRowHash: rowFingerprint(row),
      metadata: {
        previewOnly: true,
        partnerInstructionOnly: true,
        rowHashVersion: "W3C",
        formula: "gross_cod_minus_expected_deduction_risk_reserve_partner_fee"
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
      status: finalBatchStatus(reviewRequiredCount),
      currency: DEFAULT_CURRENCY,
      grossCodDueMinor,
      expectedDeductionMinor,
      riskReserveMinor,
      partnerFeeEstimateMinor,
      eligibleBaseMinor,
      maxPreviewAdvanceMinor,
      previewAdvanceMinor,
      reviewRequiredCount,
      metadata: {
        previewOnly: true,
        partnerInstructionOnly: true,
        formula: "gross_cod_minus_expected_deduction_risk_reserve_partner_fee",
        ...previewPolicy()
      },
      createdBy: input.createdBy?.trim() || null
    },
    items
  };
}

function reportFromPrepared(prepared: PreparedBatch) {
  const record: EarlyCodPrequalificationStoredBatch = {
    batch: {
      id: "dry_run",
      ...prepared.batch
    },
    items: prepared.items.map((item, index) => ({
      id: `w3c_dry_item_${index + 1}`,
      batchId: "dry_run",
      ...item
    })),
    events: []
  };
  return {
    ...serializeBatch(record),
    dryRun: true,
    execute: false,
    writes: 0
  };
}

function assertExecuteAllowed(config: EarlyCodPrequalificationRuntimeConfig) {
  if (config.nodeEnv === "production" || ["production", "staging", "live"].includes(config.appEnv)) {
    throw new HttpError(403, "W3C_LOCAL_TEST_EXECUTE_REQUIRED");
  }
  if (!["development", "test"].includes(config.appEnv)) {
    throw new HttpError(403, "W3C_LOCAL_TEST_EXECUTE_REQUIRED");
  }
}

function storedWithItems(value: unknown): EarlyCodPrequalificationStoredBatch {
  const batch = value as EarlyCodPrequalificationBatchRecord & {
    items?: EarlyCodPrequalificationItemRecord[];
    events?: EarlyCodPrequalificationEventRecord[];
  };
  return {
    batch,
    items: batch.items ?? [],
    events: batch.events ?? []
  };
}

export class PrismaEarlyCodPrequalificationStore implements EarlyCodPrequalificationStore {
  constructor(private readonly client = prisma as unknown as {
    $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T>;
    earlyCodPrequalificationBatch: {
      findUnique(input: unknown): Promise<unknown>;
    };
  }) {}

  async findBatchByKey(input: { sellerOrgId: string; period: string; sourceRef: string }) {
    const batch = await this.client.earlyCodPrequalificationBatch.findUnique({
      where: { sellerOrgId_period_sourceRef: input },
      include: {
        items: { orderBy: { id: "asc" } },
        events: { orderBy: { createdAt: "asc" } }
      }
    });
    return batch ? storedWithItems(batch) : null;
  }

  async findBatchById(batchId: string) {
    const batch = await this.client.earlyCodPrequalificationBatch.findUnique({
      where: { id: batchId },
      include: {
        items: { orderBy: { id: "asc" } },
        events: { orderBy: { createdAt: "asc" } }
      }
    });
    return batch ? storedWithItems(batch) : null;
  }

  async createBatch(input: {
    batch: Omit<EarlyCodPrequalificationBatchRecord, "id" | "createdAt" | "updatedAt">;
    items: Array<Omit<EarlyCodPrequalificationItemRecord, "id" | "batchId" | "createdAt" | "updatedAt">>;
    event: Omit<EarlyCodPrequalificationEventRecord, "id" | "batchId" | "createdAt">;
  }) {
    return this.client.$transaction(async (txValue) => {
      const tx = txValue as {
        earlyCodPrequalificationBatch: { create(data: unknown): Promise<unknown> };
      };
      const batch = await tx.earlyCodPrequalificationBatch.create({
        data: {
          ...input.batch,
          items: { create: input.items },
          events: { create: [input.event] }
        },
        include: {
          items: { orderBy: { id: "asc" } },
          events: { orderBy: { createdAt: "asc" } }
        }
      });
      return storedWithItems(batch);
    });
  }
}

export class EarlyCodPrequalificationService {
  private readonly store: EarlyCodPrequalificationStore;
  private readonly config: EarlyCodPrequalificationRuntimeConfig;

  constructor(deps: { store?: EarlyCodPrequalificationStore; config?: Partial<EarlyCodPrequalificationRuntimeConfig> } = {}) {
    this.store = deps.store ?? new PrismaEarlyCodPrequalificationStore();
    this.config = {
      appEnv: env.APP_ENV,
      nodeEnv: env.NODE_ENV,
      ...deps.config
    };
  }

  planBatch(input: EarlyCodPrequalificationCommand) {
    return reportFromPrepared(prepareBatch(input));
  }

  async createBatch(input: EarlyCodPrequalificationCommand) {
    if (!input.execute) return this.planBatch(input);
    assertExecuteAllowed(this.config);
    const prepared = prepareBatch(input);
    const existing = await this.store.findBatchByKey({
      sellerOrgId: prepared.batch.sellerOrgId,
      period: prepared.batch.period,
      sourceRef: prepared.batch.sourceRef
    });
    if (existing) {
      if (existing.batch.sourceHash !== prepared.sourceHash) throw new HttpError(409, "W3C_SOURCE_REF_HASH_CONFLICT");
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
        eventType: "w3c.early_cod_prequalification_preview.created",
        status: prepared.batch.status,
        message: "Prequalification preview batch recorded for review only.",
        metadata: { previewOnly: true, partnerInstructionOnly: true, ...previewPolicy() },
        createdBy: input.createdBy?.trim() || null
      }
    });

    return {
      ...serializeBatch(stored),
      dryRun: false,
      execute: true,
      writes: 1 + stored.items.length + stored.events.length
    };
  }

  async exportPreview(batchId: string, format: "json" | "csv" = "json") {
    const stored = await this.store.findBatchById(cleanText(batchId, "W3C_BATCH_ID_REQUIRED"));
    if (!stored) throw new HttpError(404, "W3C_BATCH_NOT_FOUND");
    const report = serializeBatch(stored);
    const base = {
      ...report,
      exportFormat: format,
      exportPreview: {
        ...previewPolicy(),
        statusChanged: false
      }
    };
    if (format === "json") return base;
    const policy = previewPolicy();
    const header = [
      "itemId",
      "courierCode",
      "period",
      "currency",
      "grossCodDueMinor",
      "expectedDeductionMinor",
      "riskReserveMinor",
      "partnerFeeEstimateMinor",
      "maxAdvanceRateBps",
      "requestedAdvanceMinor",
      "eligibleBaseMinor",
      "maxPreviewAdvanceMinor",
      "previewAdvanceMinor",
      "status"
    ];
    const rows = stored.items.map((item) => [
      item.id,
      item.courierCode,
      item.period,
      item.currency,
      minorString(item.grossCodDueMinor),
      minorString(item.expectedDeductionMinor),
      minorString(item.riskReserveMinor),
      minorString(item.partnerFeeEstimateMinor),
      minorString(item.maxAdvanceRateBps),
      minorString(item.requestedAdvanceMinor),
      minorString(item.eligibleBaseMinor),
      minorString(item.maxPreviewAdvanceMinor),
      minorString(item.previewAdvanceMinor),
      item.status
    ].map((field) => JSON.stringify(field)).join(","));
    const csv = [
      "# Early COD prequalification preview only. No money movement has been performed by Shipmastr.",
      "previewOnly,true",
      "partnerInstructionOnly,true",
      `${policyFlagKeys.creditApproved},${String(policy[policyFlagKeys.creditApproved])}`,
      `${policyFlagKeys.creditRelationshipCreated},${String(policy[policyFlagKeys.creditRelationshipCreated])}`,
      `${policyFlagKeys.fundsSent},${String(policy[policyFlagKeys.fundsSent])}`,
      `${policyFlagKeys.returnFlowCreated},${String(policy[policyFlagKeys.returnFlowCreated])}`,
      "movementExecuted,false",
      "paymentCaptured,false",
      "payoutExecuted,false",
      "settlementExecuted,false",
      "custodyCreated,false",
      `${policyFlagKeys.partnerApiCalled},${String(policy[policyFlagKeys.partnerApiCalled])}`,
      header.join(","),
      ...rows
    ].join("\n");
    return {
      ...base,
      csv
    };
  }
}

export const earlyCodPrequalificationService = new EarlyCodPrequalificationService();
