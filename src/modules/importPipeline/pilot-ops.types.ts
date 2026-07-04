import type { ImportCorrectionActionCounts } from "./import-correction.types.js";
import type { RecoveryReportFinancialSummary, RecoveryReportTieOut } from "./recovery-report.types.js";

export type PilotOpsCheckStatus = "pass" | "warn" | "fail";

export type PilotOpsCheck = {
  name: string;
  status: PilotOpsCheckStatus;
  message: string;
};

export type PilotOpsWarning = {
  code: string;
  message: string;
};

export type PilotOpsMetrics = {
  autoPostRateBps: number | null;
  humanTouchPerThousandRows: number | null;
};

export type PilotOpsReadinessInput = {
  source?: string | undefined;
  counterparty?: string | null | undefined;
  brandOrgId?: string | null | undefined;
  includeActivePackCheck?: boolean | undefined;
};

export type PilotOpsReadinessResult = {
  ok: boolean;
  checks: PilotOpsCheck[];
  warnings: PilotOpsWarning[];
  blockingIssues: PilotOpsCheck[];
};

export type PilotOpsFormatPackValidationInput = {
  packVersionId: string;
  requestedBy: string;
  approvedBy?: string | undefined;
  activate?: boolean | undefined;
  dryRun?: boolean | undefined;
};

export type PilotOpsFormatPackValidationResult = {
  dryRun: boolean;
  packVersionId: string;
  fixtureStatus: string;
  fixtureRunExecuted: boolean;
  fixtureRunRecorded: boolean;
  fixtureRunSkipped: boolean;
  statusMutationPerformed: boolean;
  intendedTransitions: string[];
  executedTransitions: string[];
  warnings: PilotOpsWarning[];
};

export type PilotOpsImportDryRunInput = {
  csvContent?: string | undefined;
  ordersCsvContent?: string | undefined;
  storagePath?: string | undefined;
  fileHash?: string | undefined;
  expectedFileHash?: string | undefined;
  source: string;
  counterparty?: string | null | undefined;
  brandOrgId?: string | null | undefined;
  period?: string | null | undefined;
  formatPackVersionId?: string | undefined;
  statedTotalMinor?: string | bigint | null | undefined;
  createdBy: string;
};

export type PilotOpsSeedSyntheticPackInput = {
  misContent: string;
  ordersContent?: string | undefined;
  manifestContent?: string | undefined;
  misStoragePath: string;
  requestedBy?: string | undefined;
  approvedBy?: string | undefined;
  execute?: boolean | undefined;
};

export type PilotOpsImportSummary = {
  fileHash: string;
  rowCount: number;
  parsedCount: number;
  parsedRowCount: number;
  resolvedCount: number;
  exceptionCount: number;
  exceptionRowCount: number;
  fileExceptionCount: number;
  skippedCount: number;
  skippedRowCount: number;
  postableRowCount: number;
  statusCounts: Record<string, number>;
  parsedTotalMinor: string;
  postableTotalMinor: string;
  rawFileTotalMinor: string;
  allRowsTotalMinor: string;
  statedTotalMinor?: string | undefined;
  fileTies: boolean | null;
  fileStatus: string;
  fileExceptionCode?: string | null | undefined;
  rowExceptionCodes: string[];
  exceptionCodes: string[];
  eventClassCounts: Record<string, number>;
  shippable: boolean;
  blockingIssues: string[];
  metrics: PilotOpsMetrics;
  warnings: PilotOpsWarning[];
};

export type PilotOpsImportStageInput = PilotOpsImportDryRunInput & {
  execute?: boolean | undefined;
};

export type PilotOpsImportStageResult = {
  execute: boolean;
  importFileId?: string | undefined;
  fileHash?: string | undefined;
  formatPackVersionId: string;
  intendedOperations: string[];
  summary?: PilotOpsImportSummary | undefined;
  shippable: boolean;
  blockingIssues: string[];
  metrics: PilotOpsMetrics;
  warnings: PilotOpsWarning[];
};

export type PilotOpsPostShadowInput = {
  fileId: string;
  createdBy: string;
  dryRun?: boolean | undefined;
};

export type PilotOpsPostShadowResult = {
  dryRun: boolean;
  fileId: string;
  attemptedCount: number;
  postedCount: number;
  skippedCount: number;
  failedCount: number;
  metrics: PilotOpsMetrics;
  rows: Array<{
    rowNo: number;
    status: string;
    code?: string | undefined;
    entryRef?: string | undefined;
    entryType?: string | undefined;
    amountMinor?: string | undefined;
  }>;
};

export type PilotOpsRecoveryReportInput = {
  brandOrgId: string;
  period?: string | undefined;
  fileIds?: string[] | undefined;
  courierCounterparty?: string | undefined;
  includeRows?: boolean | undefined;
};

export type PilotOpsRecoveryReportResult = {
  metadata: {
    brandOrgId: string;
    period?: string | undefined;
    fileIds: string[];
    ledgerScope: "shadow";
    warnings: string[];
  };
  importQuality: {
    fileCount: number;
    stagedRowCount: number;
    postedRowCount: number;
    exceptionRowCount: number;
  };
  financialSummary: RecoveryReportFinancialSummary;
  tieOut: RecoveryReportTieOut;
  shippable: boolean;
  blockingIssues: string[];
  metrics: PilotOpsMetrics;
  warnings: PilotOpsWarning[];
};

export type PilotOpsPlanCorrectionInput = {
  importFileId: string;
  newFormatPackVersionId: string;
  reason: string;
  createdBy: string;
  persistPlan?: boolean | undefined;
};

export type PilotOpsPlanCorrectionResult = {
  persistPlan: boolean;
  batchId?: string | undefined;
  importFileId: string;
  oldFormatPackVersionId: string | null;
  newFormatPackVersionId: string;
  itemCount: number;
  actionCounts: ImportCorrectionActionCounts;
  warnings: string[];
};

export type PilotOpsApplyCorrectionInput = {
  batchId: string;
  approvedBy?: string | undefined;
  appliedBy?: string | undefined;
  dryRun?: boolean | undefined;
  execute?: boolean | undefined;
};

export type PilotOpsApplyCorrectionResult = {
  execute: boolean;
  dryRun: boolean;
  batchId: string;
  intendedOperations: string[];
  approval?: { status: string; approvedBy: string } | undefined;
  apply?: {
    status: string;
    itemCount: number;
    postedReversalCount: number;
    postedCorrectedCount: number;
    failedCount: number;
  } | undefined;
};

export type PilotOpsEndToEndDryRunInput = PilotOpsImportDryRunInput & {
  packVersionId?: string | undefined;
  fileId?: string | undefined;
};

export type PilotOpsEndToEndDryRunResult = {
  dryRun: true;
  readiness: PilotOpsReadinessResult;
  fixtureFlow?: PilotOpsFormatPackValidationResult | undefined;
  importDryRun: PilotOpsImportSummary;
  shadowPostDryRun?: PilotOpsPostShadowResult | undefined;
  reportPreview?: PilotOpsRecoveryReportResult | undefined;
  checklist: PilotOpsCheck[];
  shippable: boolean;
  blockingIssues: string[];
  metrics: PilotOpsMetrics;
  warnings: PilotOpsWarning[];
};

export type PilotOpsEndToEndLocalInput = PilotOpsImportStageInput & {
  execute?: boolean | undefined;
};

export type PilotOpsEndToEndLocalResult = {
  execute: boolean;
  importFileId?: string | undefined;
  stagedRowCount: number;
  postedCount: number;
  failedCount: number;
  financialSummary?: RecoveryReportFinancialSummary | undefined;
  tieOut?: RecoveryReportTieOut | undefined;
  shippable: boolean;
  blockingIssues: string[];
  metrics: PilotOpsMetrics;
  warnings: PilotOpsWarning[];
};
