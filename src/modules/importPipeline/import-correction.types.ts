import type { ShipmentReferenceResolver } from "./shipment-reference-resolver.js";

export type ImportCorrectionAction =
  | "no_change"
  | "post_new"
  | "reverse_only"
  | "reverse_and_repost"
  | "still_exception"
  | "unmatched_old_row"
  | "ambiguous_match";

export type ImportCorrectionItemStatus = "planned" | "applied" | "failed" | "skipped";

export type ImportCorrectionPlanInput = {
  importFileId: string;
  newFormatPackVersionId: string;
  reason: string;
  createdBy: string;
  resolver?: ShipmentReferenceResolver | undefined;
  persistPlan?: boolean | undefined;
};

export type ImportCorrectionRowStatus = "parsed" | "resolved" | "validated" | "exception" | "skipped" | "ready_for_posting" | string;

export type ImportCorrectionDiff = {
  oldAmountMinor?: string | null | undefined;
  newAmountMinor?: string | null | undefined;
  oldEventClass?: string | null | undefined;
  newEventClass?: string | null | undefined;
  oldShipmentId?: string | null | undefined;
  newShipmentId?: string | null | undefined;
  oldStatus?: string | null | undefined;
  newStatus?: string | null | undefined;
  oldPostedEntryRef?: string | null | undefined;
  proposedEntryType?: string | null | undefined;
  reasonCode: string;
};

export type ImportCorrectionItem = {
  oldStagingRowId: string | null;
  proposedRowNo: number | null;
  oldPostedEntryRef: string | null;
  action: ImportCorrectionAction;
  status: ImportCorrectionItemStatus;
  oldFingerprint: string | null;
  newFingerprint: string | null;
  diff: ImportCorrectionDiff;
  errorCode: string | null;
  errorDetail: Record<string, unknown> | null;
  reversalEntryRef: null;
  correctedEntryRef: null;
};

export type ImportCorrectionActionCounts = Record<ImportCorrectionAction, number>;

export type ImportCorrectionPlan = {
  batchId?: string | undefined;
  importFileId: string;
  oldFormatPackVersionId: string | null;
  newFormatPackVersionId: string;
  reason: string;
  createdBy: string;
  actionCounts: ImportCorrectionActionCounts;
  oldRowCount: number;
  newRowCount: number;
  postedOldRowCount: number;
  unchangedCount: number;
  postNewCount: number;
  reverseOnlyCount: number;
  reverseAndRepostCount: number;
  stillExceptionCount: number;
  ambiguousCount: number;
  warnings: string[];
  items: ImportCorrectionItem[];
};

export type ImportCorrectionParsedRow = {
  rowNo: number;
  status: ImportCorrectionRowStatus;
  parsed?: Record<string, unknown> | undefined;
  eventClass?: string | null | undefined;
  shipmentId?: string | null | undefined;
  exceptionCode?: string | null | undefined;
  exceptionDetail?: Record<string, unknown> | undefined;
};
