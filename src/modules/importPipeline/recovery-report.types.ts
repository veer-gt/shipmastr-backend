import type { LedgerEntryType, LedgerScope } from "../walletLedger/ledger.service.js";

export type RecoveryReportInput = {
  brandOrgId: string;
  period?: string | undefined;
  fileIds?: string[] | undefined;
  courierCounterparty?: string | undefined;
  fromDate?: string | undefined;
  toDate?: string | undefined;
  includeRows?: boolean | undefined;
  format?: "json" | undefined;
};

export type RecoveryReportMoney = string;

export type RecoveryReportMetadata = {
  brandOrgId: string;
  period?: string | undefined;
  fromDate?: string | undefined;
  toDate?: string | undefined;
  fileIds: string[];
  generatedAt: string;
  ledgerScope: Extract<LedgerScope, "shadow">;
  reportVersion: "w0c2";
  warnings: string[];
};

export type RecoveryReportImportQuality = {
  fileCount: number;
  stagedRowCount: number;
  postedRowCount: number;
  unpostedRowCount: number;
  exceptionRowCount: number;
  autoPostRateBps: number | null;
  filesByStatus: Record<string, number>;
  rowsByStatus: Record<string, number>;
  rowsByExceptionCode: Record<string, number>;
  formatPackVersions: string[];
};

export type RecoveryReportFinancialSummary = {
  freightChargedMinor: RecoveryReportMoney;
  rtoFreightChargedMinor: RecoveryReportMoney;
  returnFreightChargedMinor: RecoveryReportMoney;
  shipmentRefundMinor: RecoveryReportMoney;
  weightDisputeDebitMinor: RecoveryReportMoney;
  weightDisputeCreditMinor: RecoveryReportMoney;
  netWeightDisputeExposureMinor: RecoveryReportMoney;
  codCollectedMinor: RecoveryReportMoney;
  codRemittedMinor: RecoveryReportMoney;
  netCodReceivableMinor: RecoveryReportMoney;
  totalCourierPayableImpactMinor: RecoveryReportMoney;
  totalSellerShippingImpactMinor: RecoveryReportMoney;
};

export type RecoveryReportRtoSummary = {
  rtoFreightChargedMinor: RecoveryReportMoney;
  rtoShipmentCount: number;
  rtoCostPerRtoShipmentMinor: RecoveryReportMoney | null;
  rtoCostShareBps: number | null;
  returnFreightChargedMinor: RecoveryReportMoney;
  refundMinor: RecoveryReportMoney;
  note: string;
};

export type RecoveryReportWeightDisputeSummary = {
  disputeDebitMinor: RecoveryReportMoney;
  disputeCreditMinor: RecoveryReportMoney;
  recoveredMinor: RecoveryReportMoney;
  netOpenDisputeMinor: RecoveryReportMoney;
  recoveryRateBps: number | null;
  disputeDebitCount: number;
  disputeCreditCount: number;
};

export type RecoveryReportCodSummary = {
  codCollectedMinor: RecoveryReportMoney;
  codRemittedMinor: RecoveryReportMoney;
  netCodReceivableMinor: RecoveryReportMoney;
  codCollectedCount: number;
  codRemittedCount: number;
};

export type RecoveryReportCourierSummary = {
  courierCounterparty: string;
  fileCount: number;
  stagedRowCount: number;
  postedRowCount: number;
  freightChargedMinor: RecoveryReportMoney;
  rtoFreightChargedMinor: RecoveryReportMoney;
  returnFreightChargedMinor: RecoveryReportMoney;
  shipmentRefundMinor: RecoveryReportMoney;
  weightDisputeDebitMinor: RecoveryReportMoney;
  weightDisputeCreditMinor: RecoveryReportMoney;
  codCollectedMinor: RecoveryReportMoney;
  codRemittedMinor: RecoveryReportMoney;
  unpostedExceptionCount: number;
  unattributedDeductionCount: number;
  unattributedDeductionMinor: RecoveryReportMoney;
};

export type RecoveryReportTieOut = {
  journalEntryCount: number;
  journalPostingCount: number;
  debitTotalMinor: RecoveryReportMoney;
  creditTotalMinor: RecoveryReportMoney;
  balanced: boolean;
  reportMappedTotalMinor: RecoveryReportMoney;
  stagingPostedRowCount: number;
  ledgerEntriesFromPostedRowsCount: number;
  rowsWithPostedEntryRefButMissingLedgerEntry: number;
  ledgerEntriesWithoutMatchingPostedStagingRow: number;
  warnings: string[];
};

export type RecoveryReportExceptions = {
  byExceptionCode: Record<string, { count: number; amountMinor: RecoveryReportMoney }>;
  deductionUnattributed: { count: number; amountMinor: RecoveryReportMoney };
  unknownEventClassRows: number;
  unresolvedShipmentRows: number;
  fileExceptionCount: number;
};

export type RecoveryReportRowDetail = {
  stagingRowId: string;
  fileId: string;
  rowNo: number;
  shipmentId: string | null;
  eventClass: string | null;
  entryType?: LedgerEntryType | undefined;
  amountMinor: RecoveryReportMoney;
  status: string;
  exceptionCode: string | null;
  postedEntryRef: string | null;
  sourceType?: string | undefined;
  sourceRef?: string | undefined;
};

export type RecoveryReport = {
  metadata: RecoveryReportMetadata;
  importQuality: RecoveryReportImportQuality;
  financialSummary: RecoveryReportFinancialSummary;
  rtoSummary: RecoveryReportRtoSummary;
  weightDisputeSummary: RecoveryReportWeightDisputeSummary;
  codSummary: RecoveryReportCodSummary;
  courierSummary: RecoveryReportCourierSummary[];
  tieOut: RecoveryReportTieOut;
  exceptions: RecoveryReportExceptions;
  rowDetails?: RecoveryReportRowDetail[] | undefined;
};
