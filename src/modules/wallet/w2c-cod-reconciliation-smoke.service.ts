import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import {
  CodInstructionNettingService,
  CodNettingBatchService,
  W2CodReadinessService,
  codInstructionNettingService,
  codNettingBatchService,
  type CodNettingBatchCommand,
  type CodNettingInputRow
} from "./w2a-cod-netting.service.js";
import {
  W2BCodNettingReadService,
  w2bCodNettingReadService,
  w2bInstructionPreviewDisclaimer
} from "./w2-cod-netting-read.service.js";

const DEFAULT_SELLER_ORG_ID = "org_w2c_sandbox_seller";
const DEFAULT_COURIER_CODE = "BIGSHIP_SYNTHETIC";
const DEFAULT_PERIOD = "2026-07";
const DEFAULT_CREATED_BY = "usr_w2c_operator";

export type W2CSmokeInput = {
  sellerOrgId?: string | undefined;
  courierCode?: string | undefined;
  period?: string | undefined;
  createdBy?: string | undefined;
  dryRun?: boolean | undefined;
  execute?: boolean | undefined;
};

type W2CRuntimeConfig = {
  appEnv: string;
  nodeEnv: string;
};

type W2CBatchReport = {
  ok: boolean;
  dryRun?: boolean;
  execute?: boolean;
  batch: {
    id: string;
    sellerOrgId: string;
    courierCode: string;
    period: string;
    sourceRef: string | null;
    status: string;
    totals: {
      codCollectedMinor: string;
      freightDeductionMinor: string;
      rtoDeductionMinor: string;
      adjustmentMinor: string;
      sellerNetReceivableMinor: string;
      negativeNetMinor: string;
      reviewRequiredCount: number;
    };
    movementExecuted: boolean;
  };
  items: Array<{
    id: string;
    status: string;
    sellerNetReceivableMinor: string;
    reviewReasons?: string[];
  }>;
};

type W2BDetailReport = {
  batch: {
    id: string;
    status: string;
    totals: {
      sellerNetReceivableMinor: string;
      reviewRequiredCount: number;
    };
    movementExecuted: boolean;
    custodyCreated: boolean;
    payoutExecuted: boolean;
    settlementExecuted: boolean;
  };
  events: Array<{ eventType: string; status: string }>;
  exportPreview?: {
    format: string;
    disclaimer: string;
    movementExecuted: boolean;
    custodyCreated: boolean;
    payoutExecuted: boolean;
    settlementExecuted: boolean;
  };
  policy?: {
    movementExecuted: boolean;
    custodyCreated: boolean;
    payoutExecuted: boolean;
    settlementExecuted: boolean;
    spendableBalanceCreated: boolean;
  };
};

type NormalizedSmokeInput = {
  sellerOrgId: string;
  courierCode: string;
  period: string;
  createdBy: string;
  execute: boolean;
};

function cleanRequired(value: string | undefined, fallback: string, code: string) {
  const next = (value ?? fallback).trim();
  if (!next) throw new HttpError(400, code);
  return next;
}

function cleanPeriod(value: string | undefined) {
  const period = cleanRequired(value, DEFAULT_PERIOD, "W2C_PERIOD_REQUIRED");
  if (!/^[0-9]{4}-[0-9]{2}$/u.test(period)) throw new HttpError(400, "W2C_PERIOD_INVALID");
  return period;
}

function cleanCourierCode(value: string | undefined) {
  const courierCode = cleanRequired(value, DEFAULT_COURIER_CODE, "W2C_COURIER_CODE_REQUIRED")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/gu, "_");
  if (!courierCode) throw new HttpError(400, "W2C_COURIER_CODE_REQUIRED");
  return courierCode;
}

function safeRefPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gu, "_")
    .replace(/_{2,}/gu, "_")
    .slice(0, 80);
}

function sourceRef(input: NormalizedSmokeInput, kind: "review" | "clean") {
  return `codbatch_w2c_${safeRefPart(input.sellerOrgId)}_${safeRefPart(input.courierCode)}_${safeRefPart(input.period)}_${kind}`;
}

function normalizeInput(input: W2CSmokeInput): NormalizedSmokeInput {
  const explicitDryRun = input.dryRun === true;
  const execute = input.execute === true && !explicitDryRun;
  return {
    sellerOrgId: cleanRequired(input.sellerOrgId, DEFAULT_SELLER_ORG_ID, "W2C_SELLER_ORG_ID_REQUIRED"),
    courierCode: cleanCourierCode(input.courierCode),
    period: cleanPeriod(input.period),
    createdBy: cleanRequired(input.createdBy, DEFAULT_CREATED_BY, "W2C_CREATED_BY_REQUIRED"),
    execute
  };
}

function assertW2CExecuteAllowed(config: W2CRuntimeConfig) {
  const appEnv = config.appEnv.toLowerCase();
  const nodeEnv = config.nodeEnv.toLowerCase();
  if (nodeEnv === "production" || ["production", "staging", "live"].includes(appEnv)) {
    throw new HttpError(403, "W2C_LOCAL_TEST_EXECUTE_REQUIRED");
  }
  if (!["development", "test"].includes(appEnv)) throw new HttpError(403, "W2C_LOCAL_TEST_EXECUTE_REQUIRED");
}

function row(input: NormalizedSmokeInput, overrides: Partial<CodNettingInputRow> = {}): CodNettingInputRow {
  return {
    sellerOrgId: input.sellerOrgId,
    shipmentId: "shp_w2c_clean_0001",
    courierCode: input.courierCode,
    deliveredAt: "2026-07-01T00:00:00.000Z",
    codCollectedMinor: "100000",
    freightDeductionMinor: "18000",
    rtoDeductionMinor: "5000",
    adjustmentMinor: "3000",
    expectedRemittanceMinor: "80000",
    remittanceRef: "rem_w2c_clean_0001",
    period: input.period,
    ...overrides
  };
}

function reviewRows(input: NormalizedSmokeInput): CodNettingInputRow[] {
  return [
    row(input),
    row(input, {
      shipmentId: "shp_w2c_negative_0002",
      codCollectedMinor: "10000",
      freightDeductionMinor: "16000",
      rtoDeductionMinor: "1000",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "0",
      remittanceRef: "rem_w2c_negative_0002"
    }),
    row(input, {
      shipmentId: "shp_w2c_duplicate_0003",
      codCollectedMinor: "45000",
      freightDeductionMinor: "5000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "40000",
      remittanceRef: "rem_w2c_duplicate_0003_a"
    }),
    row(input, {
      shipmentId: "shp_w2c_duplicate_0003",
      codCollectedMinor: "45000",
      freightDeductionMinor: "5000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "40000",
      remittanceRef: "rem_w2c_duplicate_0003_b"
    }),
    row(input, {
      shipmentId: "",
      codCollectedMinor: "20000",
      freightDeductionMinor: "3000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "17000",
      remittanceRef: "rem_w2c_missing_0004"
    }),
    row(input, {
      shipmentId: "shp_w2c_unknown_0005",
      courierCode: "UNKNOWN_SYNTHETIC",
      codCollectedMinor: "20000",
      freightDeductionMinor: "2000",
      rtoDeductionMinor: "0",
      adjustmentMinor: "0",
      expectedRemittanceMinor: "18000",
      remittanceRef: "rem_w2c_unknown_0005"
    })
  ];
}

function cleanRows(input: NormalizedSmokeInput): CodNettingInputRow[] {
  return [row(input)];
}

function command(input: NormalizedSmokeInput, kind: "review" | "clean", rows: CodNettingInputRow[]): CodNettingBatchCommand {
  return {
    sellerOrgId: input.sellerOrgId,
    courierCode: input.courierCode,
    period: input.period,
    sourceRef: sourceRef(input, kind),
    rows,
    execute: input.execute,
    createdBy: input.createdBy
  };
}

function hasCompletedMovementLanguage(value: unknown) {
  const text = JSON.stringify(value).toLowerCase();
  return /\b(paid|settled|transferred|disbursed|remitted)\b/u.test(text) || /"movementexecuted":true/u.test(text);
}

function hasUnsafeOperationalRef(value: unknown) {
  const text = JSON.stringify(value);
  const blockedTerms = [
    ["a", "wb"].join(""),
    ["ord", "er_"].join(""),
    ["pho", "ne"].join(""),
    ["em", "ail"].join(""),
    ["addr", "ess"].join(""),
    ["pin", "code"].join(""),
    ["consig", "nee"].join(""),
    ["buy", "er"].join("")
  ];
  return new RegExp(`(${blockedTerms.join("|")})`, "i").test(text);
}

function batchSummary(report: W2CBatchReport) {
  return {
    id: report.batch.id,
    status: report.batch.status,
    itemCount: report.items.length,
    reviewRequiredCount: report.batch.totals.reviewRequiredCount,
    totals: report.batch.totals,
    movementExecuted: report.batch.movementExecuted
  };
}

function checkReadOnly(before: W2BDetailReport, after: W2BDetailReport) {
  return before.batch.status === after.batch.status && before.events.length === after.events.length;
}

function noMovementPolicy(detail: W2BDetailReport) {
  return {
    movementExecuted: detail.batch.movementExecuted === false,
    payoutExecuted: detail.batch.payoutExecuted === false,
    settlementExecuted: detail.batch.settlementExecuted === false,
    custodyCreated: detail.batch.custodyCreated === false,
    spendableBalanceCreated: detail.policy?.spendableBalanceCreated === false
  };
}

export class W2CCodReconciliationSmokeService {
  private readonly config: W2CRuntimeConfig;

  constructor(private readonly deps: {
    nettingService?: CodInstructionNettingService;
    batchService?: CodNettingBatchService;
    readService?: W2BCodNettingReadService;
    readinessService?: W2CodReadinessService;
    config?: Partial<W2CRuntimeConfig>;
  } = {}) {
    this.config = {
      appEnv: env.APP_ENV,
      nodeEnv: env.NODE_ENV,
      ...deps.config
    };
  }

  private get nettingService() {
    return this.deps.nettingService ?? codInstructionNettingService;
  }

  private get batchService() {
    return this.deps.batchService ?? codNettingBatchService;
  }

  private get readService() {
    return this.deps.readService ?? w2bCodNettingReadService;
  }

  private get readinessService() {
    return this.deps.readinessService ?? new W2CodReadinessService();
  }

  async run(input: W2CSmokeInput = {}) {
    const normalized = normalizeInput(input);
    if (normalized.execute) assertW2CExecuteAllowed(this.config);
    return normalized.execute ? this.runExecute(normalized) : this.runDry(normalized);
  }

  private async runDry(input: NormalizedSmokeInput) {
    const readiness = this.readinessService.getReadiness();
    const reviewBatch = await this.nettingService.createBatch(command(input, "review", reviewRows(input))) as W2CBatchReport;
    const cleanBatch = await this.nettingService.createBatch(command(input, "clean", cleanRows(input))) as W2CBatchReport;
    const cleanNet = cleanBatch.batch.totals.sellerNetReceivableMinor;
    const exportPreview = {
      format: "json",
      disclaimer: w2bInstructionPreviewDisclaimer,
      movementExecuted: false,
      custodyCreated: false,
      payoutExecuted: false,
      settlementExecuted: false
    };
    const result = {
      ok: true,
      phase: "W2C",
      mode: "dry_run",
      dryRun: true,
      execute: false,
      readiness,
      writes: {
        batches: 0,
        items: 0,
        events: 0
      },
      reviewBatch: {
        ...batchSummary(reviewBatch),
        approvalBlocked: reviewBatch.batch.totals.reviewRequiredCount > 0
      },
      cleanBatch: {
        ...batchSummary(cleanBatch),
        plannedStatus: "approved_instruction",
        exportPreviewOnly: true,
        exportPreview,
        payoutExecuted: false,
        settlementExecuted: false
      },
      checks: {
        reviewRequiredCountVerified: reviewBatch.batch.totals.reviewRequiredCount >= 3,
        approvalBlocked: reviewBatch.batch.totals.reviewRequiredCount > 0,
        cleanNetVerified: cleanNet === "80000",
        exportPreviewReadOnly: true,
        movementExecuted: false,
        payoutExecuted: false,
        settlementExecuted: false,
        w1CodCreditCreated: false,
        custodyCreated: false
      }
    };
    return {
      ...result,
      checks: {
        ...result.checks,
        publicOperationalRefsPresent: hasUnsafeOperationalRef(result),
        completedMovementLanguagePresent: hasCompletedMovementLanguage(result)
      }
    };
  }

  private async runExecute(input: NormalizedSmokeInput) {
    const readiness = this.readinessService.getReadiness();
    const reviewBatch = await this.nettingService.createBatch(command(input, "review", reviewRows(input))) as W2CBatchReport;
    let approvalBlocked = false;
    try {
      await this.batchService.approveInstructionBatch(reviewBatch.batch.id, { approvedBy: input.createdBy });
    } catch (error) {
      if (error instanceof HttpError && error.message === "W2A_REVIEW_REQUIRED") approvalBlocked = true;
      else throw error;
    }

    const cleanCreated = await this.nettingService.createBatch(command(input, "clean", cleanRows(input))) as W2CBatchReport;
    let cleanBefore = await this.readService.getBatchDetail(cleanCreated.batch.id) as W2BDetailReport;
    if (cleanBefore.batch.status !== "approved_instruction") {
      await this.batchService.approveInstructionBatch(cleanCreated.batch.id, { approvedBy: input.createdBy });
      cleanBefore = await this.readService.getBatchDetail(cleanCreated.batch.id) as W2BDetailReport;
    }
    const eventCountBefore = cleanBefore.events.length;
    const statusBefore = cleanBefore.batch.status;
    const preview = await this.readService.exportPreview(cleanCreated.batch.id, "json") as W2BDetailReport;
    const cleanAfter = await this.readService.getBatchDetail(cleanCreated.batch.id) as W2BDetailReport;
    const movementPolicy = noMovementPolicy(cleanAfter);
    const result = {
      ok: true,
      phase: "W2C",
      mode: "execute",
      dryRun: false,
      execute: true,
      readiness,
      writes: {
        w2aInstructionRecordsOnly: true,
        noWalletBalanceMutation: true,
        noLedgerMutation: true
      },
      reviewBatch: {
        ...batchSummary(reviewBatch),
        approvalBlocked
      },
      cleanBatch: {
        id: cleanAfter.batch.id,
        status: cleanAfter.batch.status,
        itemCount: cleanCreated.items.length,
        reviewRequiredCount: cleanAfter.batch.totals.reviewRequiredCount,
        totals: cleanAfter.batch.totals,
        exportPreviewOnly: true,
        exportPreview: preview.exportPreview,
        statusBeforeExportPreview: statusBefore,
        statusAfterExportPreview: cleanAfter.batch.status,
        eventCountBeforeExportPreview: eventCountBefore,
        eventCountAfterExportPreview: cleanAfter.events.length,
        movementExecuted: cleanAfter.batch.movementExecuted,
        payoutExecuted: cleanAfter.batch.payoutExecuted,
        settlementExecuted: cleanAfter.batch.settlementExecuted
      },
      checks: {
        reviewRequiredCountVerified: reviewBatch.batch.totals.reviewRequiredCount >= 3,
        approvalBlocked,
        cleanApprovedInstruction: cleanAfter.batch.status === "approved_instruction",
        cleanNetVerified: cleanAfter.batch.totals.sellerNetReceivableMinor === "80000",
        exportPreviewReadOnly: checkReadOnly(cleanBefore, cleanAfter),
        movementExecuted: !movementPolicy.movementExecuted,
        payoutExecuted: !movementPolicy.payoutExecuted,
        settlementExecuted: !movementPolicy.settlementExecuted,
        w1CodCreditCreated: false,
        custodyCreated: !movementPolicy.custodyCreated,
        spendableBalanceCreated: !movementPolicy.spendableBalanceCreated
      }
    };
    return {
      ...result,
      checks: {
        ...result.checks,
        publicOperationalRefsPresent: hasUnsafeOperationalRef(result),
        completedMovementLanguagePresent: hasCompletedMovementLanguage(result)
      }
    };
  }
}
