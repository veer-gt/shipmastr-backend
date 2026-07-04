import type { ImportCorrectionAction } from "./import-correction.types.js";

export type ImportCorrectionApplyItemStatus = "planned" | "applied" | "failed" | "skipped" | "cancelled";

export type ApproveImportCorrectionBatchInput = {
  batchId: string;
  approvedBy: string;
};

export type ApplyImportCorrectionBatchInput = {
  batchId: string;
  appliedBy: string;
  dryRun?: boolean | undefined;
};

export type ImportCorrectionApprovalResult = {
  batchId: string;
  status: "approved";
  approvedBy: string;
  approvedAt: Date;
};

export type ImportCorrectionApplyOperation = {
  itemId: string;
  action: ImportCorrectionAction;
  status: ImportCorrectionApplyItemStatus;
  reversalEntryRef: string | null;
  correctedEntryRef: string | null;
  errorCode: string | null;
};

export type CorrectionApplyResult = {
  batchId: string;
  dryRun: boolean;
  status: string;
  appliedBy: string;
  itemCount: number;
  postedReversalCount: number;
  postedCorrectedCount: number;
  skippedCount: number;
  failedCount: number;
  operations: ImportCorrectionApplyOperation[];
};
