import { prisma } from "../../lib/prisma.js";
import type { LedgerAccountType, LedgerEntryType, LedgerOwnerType, LedgerScope, PostingDirection } from "../walletLedger/ledger.service.js";
import type {
  RecoveryReport,
  RecoveryReportCodSummary,
  RecoveryReportCourierSummary,
  RecoveryReportExceptions,
  RecoveryReportFinancialSummary,
  RecoveryReportImportQuality,
  RecoveryReportInput,
  RecoveryReportRowDetail,
  RecoveryReportRtoSummary,
  RecoveryReportTieOut,
  RecoveryReportWeightDisputeSummary
} from "./recovery-report.types.js";

type JsonRecord = Record<string, unknown>;

type ReportImportFile = {
  id: string;
  counterparty: string | null;
  brandOrgId: string | null;
  period: string | null;
  status: string;
  createdAt: Date;
  formatPackVersion?: { version: string; pack?: { packKey: string } | null } | null;
  stagingRows: ReportStagingRow[];
};

type ReportAccountTypeConfig = {
  accountType: LedgerAccountType;
  allowedLedgerScopes: LedgerScope[];
};

type ReportStagingRow = {
  id: bigint | string;
  fileId: string;
  rowNo: number;
  parsed?: unknown;
  eventClass: string | null;
  shipmentId: string | null;
  status: string;
  exceptionCode: string | null;
  postedEntryRef: string | null;
};

type ReportWalletOwner = {
  id: string;
  ownerType: LedgerOwnerType;
  externalId: string | null;
  displayName: string | null;
};

type ReportWalletAccount = {
  id: string;
  ownerId: string;
  ownerType: LedgerOwnerType;
  accountType: LedgerAccountType;
  ledgerScope: LedgerScope;
  owner?: ReportWalletOwner | null;
};

type ReportPosting = {
  id: string;
  entryId: string;
  accountId: string;
  direction: PostingDirection;
  amountPaise: bigint | string;
  account: ReportWalletAccount;
};

type ReportJournalEntry = {
  id: string;
  entryRef: string;
  entryType: LedgerEntryType;
  ledgerScope: LedgerScope;
  sourceType: string;
  sourceRef: string;
  metadata?: unknown;
  createdAt: Date;
  postings: ReportPosting[];
};

type RecoveryReportClient = {
  accountTypeConfig: {
    findMany(): Promise<ReportAccountTypeConfig[]>;
  };
  importFile: {
    findMany(input: Record<string, unknown>): Promise<ReportImportFile[]>;
  };
  journalEntry: {
    findMany(input: Record<string, unknown>): Promise<ReportJournalEntry[]>;
  };
};

type MoneyBuckets = {
  freight: bigint;
  rto: bigint;
  returnFreight: bigint;
  refund: bigint;
  disputeDebit: bigint;
  disputeCredit: bigint;
  codCollected: bigint;
  codRemitted: bigint;
};

type CountBuckets = {
  rtoShipmentCount: number;
  disputeDebitCount: number;
  disputeCreditCount: number;
  codCollectedCount: number;
  codRemittedCount: number;
};

type CourierAccumulator = MoneyBuckets & CountBuckets & {
  courierCounterparty: string;
  fileIds: Set<string>;
  stagedRowCount: number;
  postedRowCount: number;
  unpostedExceptionCount: number;
  unattributedDeductionCount: number;
  unattributedDeductionMinor: bigint;
};

type EntryContext = {
  entry: ReportJournalEntry;
  row: ReportStagingRow | null;
  file: ReportImportFile | null;
  counterparty: string;
};

const defaultClient = prisma as unknown as RecoveryReportClient;
const REPORT_VERSION = "w0c2" as const;
const SHADOW_SCOPE = "shadow" as const;
const UNKNOWN_COUNTERPARTY = "unattributed";

const RECOVERY_ENTRY_TYPES: LedgerEntryType[] = [
  "shipment_charge",
  "shipment_refund",
  "rto_freight_charge",
  "return_freight_charge",
  "weight_dispute_hold",
  "weight_dispute_release",
  "cod_collected",
  "cod_remittance_in"
];

const ZERO_BUCKETS: MoneyBuckets = {
  freight: 0n,
  rto: 0n,
  returnFreight: 0n,
  refund: 0n,
  disputeDebit: 0n,
  disputeCredit: 0n,
  codCollected: 0n,
  codRemitted: 0n
};

const ZERO_COUNTS: CountBuckets = {
  rtoShipmentCount: 0,
  disputeDebitCount: 0,
  disputeCreditCount: 0,
  codCollectedCount: 0,
  codRemittedCount: 0
};

function cleanRequiredText(value: unknown, code: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(code);
  return text;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function minorToString(value: bigint) {
  return value.toString();
}

function parseMinor(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^-?[0-9]+$/.test(text)) return null;
  return BigInt(text);
}

function postingMinor(posting: ReportPosting) {
  const value = parseMinor(posting.amountPaise);
  return value ?? 0n;
}

function parsedMinor(row: ReportStagingRow) {
  if (!isRecord(row.parsed)) return 0n;
  const value = parseMinor(row.parsed.amount_minor);
  return value ?? 0n;
}

function integerBps(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) return null;
  return parseInt(((numerator * 10_000n) / denominator).toString(), 10);
}

function integerAverage(numerator: bigint, denominator: number) {
  if (denominator <= 0) return null;
  return (numerator / BigInt(denominator)).toString();
}

function addCount(map: Record<string, number>, key: string | null | undefined) {
  const next = key?.trim() || "unknown";
  map[next] = (map[next] ?? 0) + 1;
}

function createMoneyBuckets(): MoneyBuckets {
  return { ...ZERO_BUCKETS };
}

function createCountBuckets(): CountBuckets {
  return { ...ZERO_COUNTS };
}

function createCourierAccumulator(counterparty: string): CourierAccumulator {
  return {
    courierCounterparty: counterparty,
    fileIds: new Set<string>(),
    stagedRowCount: 0,
    postedRowCount: 0,
    unpostedExceptionCount: 0,
    unattributedDeductionCount: 0,
    unattributedDeductionMinor: 0n,
    ...createMoneyBuckets(),
    ...createCountBuckets()
  };
}

function formatPackVersionLabel(file: ReportImportFile) {
  const version = file.formatPackVersion?.version;
  if (!version) return null;
  const packKey = file.formatPackVersion?.pack?.packKey;
  return packKey ? `${packKey}@${version}` : version;
}

function metadataRecord(entry: ReportJournalEntry) {
  return isRecord(entry.metadata) ? entry.metadata : {};
}

function metadataFileId(entry: ReportJournalEntry) {
  const value = metadataRecord(entry).importFileId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataStagingRowId(entry: ReportJournalEntry) {
  const value = metadataRecord(entry).stagingRowId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rowKey(row: ReportStagingRow) {
  return String(row.id);
}

function fileCounterparty(file: ReportImportFile | null) {
  return file?.counterparty?.trim() || UNKNOWN_COUNTERPARTY;
}

function courierCounterpartyFromEntry(entry: ReportJournalEntry) {
  for (const posting of entry.postings) {
    if (posting.account.ownerType !== "courier") continue;
    const owner = posting.account.owner;
    return owner?.externalId?.trim() || owner?.displayName?.trim() || UNKNOWN_COUNTERPARTY;
  }
  return UNKNOWN_COUNTERPARTY;
}

function entryHasOnlyShadowAccounts(entry: ReportJournalEntry) {
  return entry.ledgerScope === SHADOW_SCOPE && entry.postings.every((posting) => posting.account.ledgerScope === SHADOW_SCOPE);
}

function matchingPostingMinor(
  entry: ReportJournalEntry,
  accountType: LedgerAccountType,
  direction: PostingDirection,
  ownerType?: LedgerOwnerType
) {
  let total = 0n;
  for (const posting of entry.postings) {
    const account = posting.account;
    if (account.accountType !== accountType || posting.direction !== direction) continue;
    if (ownerType && account.ownerType !== ownerType) continue;
    total += postingMinor(posting);
  }
  return total;
}

function amountForEconomicEvent(entry: ReportJournalEntry) {
  switch (entry.entryType) {
    case "shipment_charge":
      return matchingPostingMinor(entry, "shipping_balance", "debit", "seller")
        || matchingPostingMinor(entry, "courier_payable", "credit", "courier");
    case "rto_freight_charge":
      return matchingPostingMinor(entry, "shipping_balance", "debit", "seller");
    case "return_freight_charge":
      return matchingPostingMinor(entry, "shipping_balance", "debit", "seller");
    case "shipment_refund":
      return matchingPostingMinor(entry, "shipping_balance", "credit", "seller");
    case "weight_dispute_hold":
      return matchingPostingMinor(entry, "shipping_balance", "debit", "seller")
        || matchingPostingMinor(entry, "dispute_hold", "credit", "seller");
    case "weight_dispute_release":
      return matchingPostingMinor(entry, "dispute_hold", "debit", "seller")
        || matchingPostingMinor(entry, "shipping_balance", "credit", "seller");
    case "cod_collected":
      return matchingPostingMinor(entry, "cod_receivable", "credit", "seller");
    case "cod_remittance_in":
      return matchingPostingMinor(entry, "cod_receivable", "debit", "seller");
    default:
      return 0n;
  }
}

function applyEconomicEvent(entry: ReportJournalEntry, buckets: MoneyBuckets, counts: CountBuckets) {
  const amount = amountForEconomicEvent(entry);
  switch (entry.entryType) {
    case "shipment_charge":
      buckets.freight += amount;
      break;
    case "rto_freight_charge":
      buckets.rto += amount;
      counts.rtoShipmentCount += 1;
      break;
    case "return_freight_charge":
      buckets.returnFreight += amount;
      break;
    case "shipment_refund":
      buckets.refund += amount;
      break;
    case "weight_dispute_hold":
      buckets.disputeDebit += amount;
      counts.disputeDebitCount += 1;
      break;
    case "weight_dispute_release":
      buckets.disputeCredit += amount;
      counts.disputeCreditCount += 1;
      break;
    case "cod_collected":
      buckets.codCollected += amount;
      counts.codCollectedCount += 1;
      break;
    case "cod_remittance_in":
      buckets.codRemitted += amount;
      counts.codRemittedCount += 1;
      break;
  }
}

function toFinancialSummary(buckets: MoneyBuckets): RecoveryReportFinancialSummary {
  return {
    freightChargedMinor: minorToString(buckets.freight),
    rtoFreightChargedMinor: minorToString(buckets.rto),
    returnFreightChargedMinor: minorToString(buckets.returnFreight),
    shipmentRefundMinor: minorToString(buckets.refund),
    weightDisputeDebitMinor: minorToString(buckets.disputeDebit),
    weightDisputeCreditMinor: minorToString(buckets.disputeCredit),
    netWeightDisputeExposureMinor: minorToString(buckets.disputeDebit - buckets.disputeCredit),
    codCollectedMinor: minorToString(buckets.codCollected),
    codRemittedMinor: minorToString(buckets.codRemitted),
    netCodReceivableMinor: minorToString(buckets.codCollected - buckets.codRemitted),
    totalCourierPayableImpactMinor: minorToString(buckets.freight + buckets.rto + buckets.returnFreight - buckets.refund),
    totalSellerShippingImpactMinor: minorToString(buckets.freight + buckets.rto + buckets.returnFreight + buckets.disputeDebit - buckets.refund - buckets.disputeCredit)
  };
}

function toRtoSummary(buckets: MoneyBuckets, counts: CountBuckets): RecoveryReportRtoSummary {
  return {
    rtoFreightChargedMinor: minorToString(buckets.rto),
    rtoShipmentCount: counts.rtoShipmentCount,
    rtoCostPerRtoShipmentMinor: integerAverage(buckets.rto, counts.rtoShipmentCount),
    rtoCostShareBps: integerBps(buckets.rto, buckets.freight),
    returnFreightChargedMinor: minorToString(buckets.returnFreight),
    refundMinor: minorToString(buckets.refund),
    note: "RTO and return values are shadow ledger analysis only; they are not wallet availability."
  };
}

function toWeightDisputeSummary(buckets: MoneyBuckets, counts: CountBuckets): RecoveryReportWeightDisputeSummary {
  return {
    disputeDebitMinor: minorToString(buckets.disputeDebit),
    disputeCreditMinor: minorToString(buckets.disputeCredit),
    recoveredMinor: minorToString(buckets.disputeCredit),
    netOpenDisputeMinor: minorToString(buckets.disputeDebit - buckets.disputeCredit),
    recoveryRateBps: integerBps(buckets.disputeCredit, buckets.disputeDebit),
    disputeDebitCount: counts.disputeDebitCount,
    disputeCreditCount: counts.disputeCreditCount
  };
}

function toCodSummary(buckets: MoneyBuckets, counts: CountBuckets): RecoveryReportCodSummary {
  return {
    codCollectedMinor: minorToString(buckets.codCollected),
    codRemittedMinor: minorToString(buckets.codRemitted),
    netCodReceivableMinor: minorToString(buckets.codCollected - buckets.codRemitted),
    codCollectedCount: counts.codCollectedCount,
    codRemittedCount: counts.codRemittedCount
  };
}

function toCourierSummary(accumulator: CourierAccumulator): RecoveryReportCourierSummary {
  return {
    courierCounterparty: accumulator.courierCounterparty,
    fileCount: accumulator.fileIds.size,
    stagedRowCount: accumulator.stagedRowCount,
    postedRowCount: accumulator.postedRowCount,
    freightChargedMinor: minorToString(accumulator.freight),
    rtoFreightChargedMinor: minorToString(accumulator.rto),
    returnFreightChargedMinor: minorToString(accumulator.returnFreight),
    shipmentRefundMinor: minorToString(accumulator.refund),
    weightDisputeDebitMinor: minorToString(accumulator.disputeDebit),
    weightDisputeCreditMinor: minorToString(accumulator.disputeCredit),
    codCollectedMinor: minorToString(accumulator.codCollected),
    codRemittedMinor: minorToString(accumulator.codRemitted),
    unpostedExceptionCount: accumulator.unpostedExceptionCount,
    unattributedDeductionCount: accumulator.unattributedDeductionCount,
    unattributedDeductionMinor: minorToString(accumulator.unattributedDeductionMinor)
  };
}

function reportMappedTotal(buckets: MoneyBuckets) {
  return buckets.freight
    + buckets.rto
    + buckets.returnFreight
    + buckets.refund
    + buckets.disputeDebit
    + buckets.disputeCredit
    + buckets.codCollected
    + buckets.codRemitted;
}

function isKnownRecoveryEvent(value: string | null) {
  return RECOVERY_ENTRY_TYPES.includes(value as LedgerEntryType);
}

function importFileWhere(input: RecoveryReportInput) {
  const where: JsonRecord = { brandOrgId: cleanRequiredText(input.brandOrgId, "BRAND_ORG_ID_REQUIRED") };
  if (input.fileIds && input.fileIds.length > 0) where.id = { in: input.fileIds };
  if (input.period) where.period = input.period;
  if (input.courierCounterparty) where.counterparty = input.courierCounterparty;
  const createdAt: JsonRecord = {};
  if (input.fromDate) createdAt.gte = new Date(input.fromDate);
  if (input.toDate) createdAt.lte = new Date(input.toDate);
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  return where;
}

function journalEntryWhere(entryRefs: string[]) {
  const where: JsonRecord = {};
  if (entryRefs.length > 0) where.entryRef = { in: entryRefs };
  return where;
}

function candidateEntryWhere(input: RecoveryReportInput) {
  const where: JsonRecord = { ledgerScope: SHADOW_SCOPE, entryType: { in: RECOVERY_ENTRY_TYPES } };
  const createdAt: JsonRecord = {};
  if (input.fromDate) createdAt.gte = new Date(input.fromDate);
  if (input.toDate) createdAt.lte = new Date(input.toDate);
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  return where;
}

function accountTypeConfigWarnings(configs: ReportAccountTypeConfig[]) {
  const warnings: string[] = [];
  const byType = new Map(configs.map((config) => [config.accountType, config]));
  const checkoutBalance = byType.get("checkout_balance");
  if (checkoutBalance?.allowedLedgerScopes.includes("custodial")) {
    warnings.push("checkout_balance is configured with custodial scope; report output remains shadow scoped.");
  }
  return warnings;
}

export class RecoveryReportService {
  constructor(private readonly client: RecoveryReportClient = defaultClient) {}

  async generateRecoveryReport(input: RecoveryReportInput): Promise<RecoveryReport> {
    const brandOrgId = cleanRequiredText(input.brandOrgId, "BRAND_ORG_ID_REQUIRED");
    const accountTypeConfigs = await this.client.accountTypeConfig.findMany();
    const files = await this.client.importFile.findMany({
      where: importFileWhere(input),
      include: {
        formatPackVersion: { include: { pack: true } },
        stagingRows: { orderBy: { rowNo: "asc" } }
      },
      orderBy: { createdAt: "asc" }
    });

    const fileById = new Map(files.map((file) => [file.id, file]));
    const rows = files.flatMap((file) => file.stagingRows);
    const rowById = new Map(rows.map((row) => [rowKey(row), row]));
    const rowByPostedRef = new Map(rows.filter((row) => row.postedEntryRef).map((row) => [row.postedEntryRef as string, row]));
    const postedEntryRefs = [...rowByPostedRef.keys()].sort();

    const linkedEntries = postedEntryRefs.length > 0
      ? await this.client.journalEntry.findMany({
        where: journalEntryWhere(postedEntryRefs),
        include: { postings: { include: { account: { include: { owner: true } } } } },
        orderBy: { createdAt: "asc" }
      })
      : [];
    const candidateEntries = await this.client.journalEntry.findMany({
      where: candidateEntryWhere(input),
      include: { postings: { include: { account: { include: { owner: true } } } } },
      orderBy: { createdAt: "asc" }
    });

    const warnings: string[] = [];
    const tieOutWarnings: string[] = [];
    const includedByRef = new Map<string, ReportJournalEntry>();
    const ignoredCustodialRefs: string[] = [];

    for (const entry of linkedEntries) {
      if (!entryHasOnlyShadowAccounts(entry)) {
        ignoredCustodialRefs.push(entry.entryRef);
        continue;
      }
      includedByRef.set(entry.entryRef, entry);
    }

    if (ignoredCustodialRefs.length > 0) {
      warnings.push("Custodial-linked ledger entries were ignored; this report is shadow scoped only.");
      tieOutWarnings.push("Some posted rows referenced non-shadow ledger entries and were excluded.");
    }

    const extraEntries = candidateEntries.filter((entry) => {
      if (includedByRef.has(entry.entryRef) || !entryHasOnlyShadowAccounts(entry)) return false;
      const importFileId = metadataFileId(entry);
      return importFileId !== null && fileById.has(importFileId);
    });

    const includedEntries = [...includedByRef.values()];
    const contexts = this.contextsForEntries(includedEntries, rowByPostedRef, rowById, fileById);
    const aggregateBuckets = createMoneyBuckets();
    const aggregateCounts = createCountBuckets();
    const courierAccumulators = this.courierAccumulatorsForFiles(files);

    for (const context of contexts) {
      applyEconomicEvent(context.entry, aggregateBuckets, aggregateCounts);
      const courier = this.ensureCourierAccumulator(courierAccumulators, context.counterparty);
      applyEconomicEvent(context.entry, courier, courier);
    }

    for (const file of files) {
      const courier = this.ensureCourierAccumulator(courierAccumulators, fileCounterparty(file));
      for (const row of file.stagingRows) {
        courier.fileIds.add(file.id);
        courier.stagedRowCount += 1;
        if (row.postedEntryRef) courier.postedRowCount += 1;
        if (row.status === "exception") courier.unpostedExceptionCount += 1;
        if (row.exceptionCode === "deduction_unattributed") {
          courier.unattributedDeductionCount += 1;
          courier.unattributedDeductionMinor += parsedMinor(row);
        }
      }
    }

    const importQuality = this.importQuality(files, rows);
    const exceptions = this.exceptions(files, rows);
    const tieOut = this.tieOut({
      rows,
      includedEntries,
      extraEntries,
      rowByPostedRef,
      buckets: aggregateBuckets,
      warnings: tieOutWarnings
    });
    const metadataWarnings = [...accountTypeConfigWarnings(accountTypeConfigs), ...warnings];
    if (extraEntries.length > 0) {
      metadataWarnings.push("Shadow ledger entries exist for selected files without matching posted staging rows.");
    }

    const report: RecoveryReport = {
      metadata: {
        brandOrgId,
        period: input.period,
        fromDate: input.fromDate,
        toDate: input.toDate,
        fileIds: files.map((file) => file.id).sort(),
        generatedAt: new Date().toISOString(),
        ledgerScope: SHADOW_SCOPE,
        reportVersion: REPORT_VERSION,
        warnings: metadataWarnings
      },
      importQuality,
      financialSummary: toFinancialSummary(aggregateBuckets),
      rtoSummary: toRtoSummary(aggregateBuckets, aggregateCounts),
      weightDisputeSummary: toWeightDisputeSummary(aggregateBuckets, aggregateCounts),
      codSummary: toCodSummary(aggregateBuckets, aggregateCounts),
      courierSummary: [...courierAccumulators.values()]
        .map((accumulator) => toCourierSummary(accumulator))
        .sort((left, right) => left.courierCounterparty.localeCompare(right.courierCounterparty)),
      tieOut,
      exceptions
    };

    if (input.includeRows === true) {
      report.rowDetails = this.rowDetails(rows, includedByRef);
    }

    return report;
  }

  private contextsForEntries(
    entries: ReportJournalEntry[],
    rowByPostedRef: Map<string, ReportStagingRow>,
    rowById: Map<string, ReportStagingRow>,
    fileById: Map<string, ReportImportFile>
  ): EntryContext[] {
    return entries.map((entry) => {
      const row = rowByPostedRef.get(entry.entryRef) ?? (metadataStagingRowId(entry) ? rowById.get(metadataStagingRowId(entry) as string) : null) ?? null;
      const file = row ? fileById.get(row.fileId) ?? null : metadataFileId(entry) ? fileById.get(metadataFileId(entry) as string) ?? null : null;
      return {
        entry,
        row,
        file,
        counterparty: fileCounterparty(file) || courierCounterpartyFromEntry(entry)
      };
    });
  }

  private courierAccumulatorsForFiles(files: ReportImportFile[]) {
    const accumulators = new Map<string, CourierAccumulator>();
    for (const file of files) {
      const counterparty = fileCounterparty(file);
      const accumulator = this.ensureCourierAccumulator(accumulators, counterparty);
      accumulator.fileIds.add(file.id);
    }
    return accumulators;
  }

  private ensureCourierAccumulator(accumulators: Map<string, CourierAccumulator>, counterparty: string) {
    const key = counterparty.trim() || UNKNOWN_COUNTERPARTY;
    const existing = accumulators.get(key);
    if (existing) return existing;
    const created = createCourierAccumulator(key);
    accumulators.set(key, created);
    return created;
  }

  private importQuality(files: ReportImportFile[], rows: ReportStagingRow[]): RecoveryReportImportQuality {
    const filesByStatus: Record<string, number> = {};
    const rowsByStatus: Record<string, number> = {};
    const rowsByExceptionCode: Record<string, number> = {};
    const formatPackVersions = new Set<string>();

    for (const file of files) {
      addCount(filesByStatus, file.status);
      const label = formatPackVersionLabel(file);
      if (label) formatPackVersions.add(label);
    }
    for (const row of rows) {
      addCount(rowsByStatus, row.status);
      if (row.exceptionCode) addCount(rowsByExceptionCode, row.exceptionCode);
    }

    const postedRowCount = rows.filter((row) => row.postedEntryRef).length;
    const exceptionRowCount = rows.filter((row) => row.status === "exception").length;
    return {
      fileCount: files.length,
      stagedRowCount: rows.length,
      postedRowCount,
      unpostedRowCount: rows.length - postedRowCount,
      exceptionRowCount,
      autoPostRateBps: integerBps(BigInt(postedRowCount), BigInt(rows.length)),
      filesByStatus,
      rowsByStatus,
      rowsByExceptionCode,
      formatPackVersions: [...formatPackVersions].sort()
    };
  }

  private exceptions(files: ReportImportFile[], rows: ReportStagingRow[]): RecoveryReportExceptions {
    const byExceptionCode: Record<string, { count: number; amountMinor: string }> = {};
    let deductionUnattributedCount = 0;
    let deductionUnattributedMinor = 0n;
    let unknownEventClassRows = 0;
    let unresolvedShipmentRows = 0;

    for (const row of rows) {
      if (row.exceptionCode) {
        const amount = parsedMinor(row);
        const existing = byExceptionCode[row.exceptionCode] ?? { count: 0, amountMinor: "0" };
        existing.count += 1;
        existing.amountMinor = minorToString(BigInt(existing.amountMinor) + amount);
        byExceptionCode[row.exceptionCode] = existing;
      }
      if (row.exceptionCode === "deduction_unattributed") {
        deductionUnattributedCount += 1;
        deductionUnattributedMinor += parsedMinor(row);
      }
      if (row.eventClass && !isKnownRecoveryEvent(row.eventClass)) unknownEventClassRows += 1;
      if (!row.shipmentId && row.status === "exception") unresolvedShipmentRows += 1;
    }

    return {
      byExceptionCode,
      deductionUnattributed: {
        count: deductionUnattributedCount,
        amountMinor: minorToString(deductionUnattributedMinor)
      },
      unknownEventClassRows,
      unresolvedShipmentRows,
      fileExceptionCount: files.filter((file) => file.status === "failed" || file.status === "exception").length
    };
  }

  private tieOut(input: {
    rows: ReportStagingRow[];
    includedEntries: ReportJournalEntry[];
    extraEntries: ReportJournalEntry[];
    rowByPostedRef: Map<string, ReportStagingRow>;
    buckets: MoneyBuckets;
    warnings: string[];
  }): RecoveryReportTieOut {
    let debitTotal = 0n;
    let creditTotal = 0n;
    let journalPostingCount = 0;
    const rowRefs = new Set(input.rowByPostedRef.keys());

    for (const entry of input.includedEntries) {
      for (const posting of entry.postings) {
        journalPostingCount += 1;
        if (posting.direction === "debit") debitTotal += postingMinor(posting);
        if (posting.direction === "credit") creditTotal += postingMinor(posting);
      }
    }

    const rowsWithPostedEntryRefButMissingLedgerEntry = input.rows.filter((row) => row.postedEntryRef && !input.includedEntries.some((entry) => entry.entryRef === row.postedEntryRef)).length;
    const ledgerEntriesWithoutMatchingPostedStagingRow = input.extraEntries
      .filter((entry) => !rowRefs.has(entry.entryRef))
      .length;
    const warnings = [...input.warnings];
    if (debitTotal !== creditTotal) warnings.push("Included shadow ledger postings are not balanced.");
    if (rowsWithPostedEntryRefButMissingLedgerEntry > 0) warnings.push("Some posted staging rows could not be matched to shadow ledger entries.");
    if (ledgerEntriesWithoutMatchingPostedStagingRow > 0) warnings.push("Some shadow ledger entries for selected files did not match posted staging rows.");

    return {
      journalEntryCount: input.includedEntries.length,
      journalPostingCount,
      debitTotalMinor: minorToString(debitTotal),
      creditTotalMinor: minorToString(creditTotal),
      balanced: debitTotal === creditTotal,
      reportMappedTotalMinor: minorToString(reportMappedTotal(input.buckets)),
      stagingPostedRowCount: input.rows.filter((row) => row.postedEntryRef).length,
      ledgerEntriesFromPostedRowsCount: input.includedEntries.length,
      rowsWithPostedEntryRefButMissingLedgerEntry,
      ledgerEntriesWithoutMatchingPostedStagingRow,
      warnings
    };
  }

  private rowDetails(rows: ReportStagingRow[], entriesByRef: Map<string, ReportJournalEntry>): RecoveryReportRowDetail[] {
    return rows.map((row) => {
      const entry = row.postedEntryRef ? entriesByRef.get(row.postedEntryRef) : null;
      return {
        stagingRowId: rowKey(row),
        fileId: row.fileId,
        rowNo: row.rowNo,
        shipmentId: row.shipmentId,
        eventClass: row.eventClass,
        entryType: entry?.entryType,
        amountMinor: entry ? minorToString(amountForEconomicEvent(entry)) : minorToString(parsedMinor(row)),
        status: row.status,
        exceptionCode: row.exceptionCode,
        postedEntryRef: row.postedEntryRef,
        sourceType: entry?.sourceType,
        sourceRef: entry?.sourceRef
      };
    });
  }
}

export const recoveryReportService = new RecoveryReportService();
