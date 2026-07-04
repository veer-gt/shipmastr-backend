import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LedgerAccountType, LedgerEntryType, LedgerOwnerType, LedgerScope, PostingDirection } from "../walletLedger/ledger.service.js";
import { RecoveryReportExporter } from "./recovery-report.exporter.js";
import { RecoveryReportService } from "./recovery-report.service.js";

const baseTime = new Date("2026-07-04T12:00:00.000Z");

type FileRecord = {
  id: string;
  counterparty: string | null;
  brandOrgId: string | null;
  period: string | null;
  status: string;
  createdAt: Date;
  formatPackVersion?: { version: string; pack?: { packKey: string } | null } | null;
};

type RowRecord = {
  id: bigint;
  fileId: string;
  rowNo: number;
  parsed?: unknown;
  eventClass: string | null;
  shipmentId: string | null;
  status: string;
  exceptionCode: string | null;
  postedEntryRef: string | null;
};

type OwnerRecord = {
  id: string;
  ownerType: LedgerOwnerType;
  externalId: string | null;
  displayName: string | null;
};

type AccountRecord = {
  id: string;
  ownerId: string;
  ownerType: LedgerOwnerType;
  accountType: LedgerAccountType;
  ledgerScope: LedgerScope;
};

type EntryRecord = {
  id: string;
  entryRef: string;
  entryType: LedgerEntryType;
  ledgerScope: LedgerScope;
  sourceType: string;
  sourceRef: string;
  metadata?: unknown;
  createdAt: Date;
};

type PostingRecord = {
  id: string;
  entryId: string;
  accountId: string;
  direction: PostingDirection;
  amountPaise: bigint;
};

function cloneState<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function dayOffset(days: number) {
  return new Date(baseTime.getTime() + days * 24 * 60 * 60 * 1000);
}

function matchesWhere(record: Record<string, unknown>, where: Record<string, unknown>) {
  return Object.entries(where).every(([key, value]) => {
    const current = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const criteria = value as Record<string, unknown>;
      if (Array.isArray(criteria.in)) return criteria.in.includes(current);
      if (criteria.gte instanceof Date && current instanceof Date && current < criteria.gte) return false;
      if (criteria.lte instanceof Date && current instanceof Date && current > criteria.lte) return false;
      return true;
    }
    return current === value;
  });
}

function makeHarness() {
  const state = {
    files: [] as FileRecord[],
    rows: [] as RowRecord[],
    owners: [] as OwnerRecord[],
    accounts: [] as AccountRecord[],
    entries: [] as EntryRecord[],
    postings: [] as PostingRecord[],
    mutations: [] as string[],
    configReads: 0
  };

  function owner(ownerType: LedgerOwnerType, externalId: string) {
    const item = {
      id: `own_${state.owners.length + 1}`,
      ownerType,
      externalId,
      displayName: externalId
    };
    state.owners.push(item);
    return item;
  }

  const seller = owner("seller", "brand_alpha");
  const courier = owner("courier", "courier_alpha");
  const sellerShipping = account(seller, "shipping_balance");
  const sellerCod = account(seller, "cod_receivable");
  const sellerDispute = account(seller, "dispute_hold");
  const sellerShortfall = account(seller, "seller_shortfall");
  const courierPayable = account(courier, "courier_payable");
  const courierCodDue = account(courier, "courier_cod_due");

  function account(ownerRecord: OwnerRecord, accountType: LedgerAccountType, ledgerScope: LedgerScope = "shadow") {
    const item = {
      id: `acct_${state.accounts.length + 1}`,
      ownerId: ownerRecord.id,
      ownerType: ownerRecord.ownerType,
      accountType,
      ledgerScope
    };
    state.accounts.push(item);
    return item;
  }

  function file(overrides: Partial<FileRecord> = {}) {
    const item = {
      id: `file_${state.files.length + 1}`,
      counterparty: "courier_alpha",
      brandOrgId: "brand_alpha",
      period: "2026-07",
      status: "imported",
      createdAt: dayOffset(state.files.length),
      formatPackVersion: { version: "1.0.0", pack: { packKey: "alpha_pack" } },
      ...overrides
    };
    state.files.push(item);
    return item;
  }

  function row(fileRecord: FileRecord, overrides: Partial<RowRecord> = {}) {
    const item = {
      id: BigInt(state.rows.length + 1),
      fileId: fileRecord.id,
      rowNo: state.rows.length + 1,
      parsed: { amount_minor: "0", heldValue: "safe source payload stays quarantined" },
      eventClass: "shipment_charge",
      shipmentId: `shp_${state.rows.length + 1}`,
      status: "posted",
      exceptionCode: null,
      postedEntryRef: null,
      ...overrides
    };
    state.rows.push(item);
    return item;
  }

  function addPosting(entryId: string, accountRecord: AccountRecord, direction: PostingDirection, amount: bigint) {
    state.postings.push({
      id: `post_${state.postings.length + 1}`,
      entryId,
      accountId: accountRecord.id,
      direction,
      amountPaise: amount
    });
  }

  function entry(input: {
    entryRef: string;
    entryType: LedgerEntryType;
    amount: bigint;
    debit: AccountRecord;
    credit: AccountRecord;
    rowRecord?: RowRecord | null;
    fileRecord?: FileRecord | null;
    ledgerScope?: LedgerScope;
    sourceRef?: string;
    oneSided?: boolean;
  }) {
    const item = {
      id: `entry_${state.entries.length + 1}`,
      entryRef: input.entryRef,
      entryType: input.entryType,
      ledgerScope: input.ledgerScope ?? "shadow",
      sourceType: "shipment",
      sourceRef: input.sourceRef ?? `src_${state.entries.length + 1}`,
      metadata: {
        importFileId: input.fileRecord?.id ?? input.rowRecord?.fileId,
        stagingRowId: input.rowRecord ? String(input.rowRecord.id) : undefined
      },
      createdAt: baseTime
    };
    state.entries.push(item);
    addPosting(item.id, input.debit, "debit", input.amount);
    if (input.oneSided !== true) addPosting(item.id, input.credit, "credit", input.amount);
    if (input.rowRecord) input.rowRecord.postedEntryRef = input.entryRef;
    return item;
  }

  function client() {
    return {
      accountTypeConfig: {
        findMany: async () => {
          state.configReads += 1;
          return [
            { accountType: "checkout_balance", allowedLedgerScopes: ["shadow"] }
          ];
        }
      },
      importFile: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => cloneState(state.files
          .filter((item) => matchesWhere(item as unknown as Record<string, unknown>, where))
          .map((item) => ({
            ...item,
            stagingRows: state.rows.filter((candidate) => candidate.fileId === item.id).sort((left, right) => left.rowNo - right.rowNo)
          })))
      },
      stagingRow: {
        update: async () => {
          state.mutations.push("stagingRow.update");
          throw new Error("mutation not allowed");
        }
      },
      journalEntry: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => cloneState(state.entries
          .filter((item) => matchesWhere(item as unknown as Record<string, unknown>, where))
          .map((item) => ({
            ...item,
            postings: state.postings
              .filter((posting) => posting.entryId === item.id)
              .map((posting) => {
                const accountRecord = state.accounts.find((candidate) => candidate.id === posting.accountId);
                if (!accountRecord) throw new Error("account missing");
                return {
                  ...posting,
                  account: {
                    ...accountRecord,
                    owner: state.owners.find((ownerRecord) => ownerRecord.id === accountRecord.ownerId) ?? null
                  }
                };
              })
          })))
      }
    };
  }

  return {
    state,
    accounts: { sellerShipping, sellerCod, sellerDispute, sellerShortfall, courierPayable, courierCodDue },
    file,
    row,
    entry,
    service: () => new RecoveryReportService(client() as never)
  };
}

describe("RecoveryReportService", () => {
  it("returns an empty shadow-scoped report without writing anything", async () => {
    const harness = makeHarness();
    const report = await harness.service().generateRecoveryReport({ brandOrgId: "brand_alpha" });

    assert.equal(report.metadata.ledgerScope, "shadow");
    assert.equal(harness.state.configReads, 1);
    assert.equal(report.importQuality.fileCount, 0);
    assert.equal(report.financialSummary.freightChargedMinor, "0");
    assert.equal(report.tieOut.balanced, true);
    assert.deepEqual(harness.state.mutations, []);
  });

  it("maps recovery economics once and exports stable JSON", async () => {
    const harness = makeHarness();
    const file = harness.file();
    const secretToken = ["A", "W", "B"].join("") + "-hidden-" + ["buyer", "contact"].join("-");
    const rows = {
      freight: harness.row(file, { eventClass: "shipment_charge", parsed: { amount_minor: "1000", secretToken } }),
      rto: harness.row(file, { eventClass: "rto_freight_charge", parsed: { amount_minor: "300" } }),
      returnFreight: harness.row(file, { eventClass: "return_freight_charge", parsed: { amount_minor: "200" } }),
      refund: harness.row(file, { eventClass: "shipment_refund", parsed: { amount_minor: "100" } }),
      disputeDebit: harness.row(file, { eventClass: "weight_dispute_hold", parsed: { amount_minor: "80" } }),
      disputeCredit: harness.row(file, { eventClass: "weight_dispute_release", parsed: { amount_minor: "30" } }),
      codCollected: harness.row(file, { eventClass: "cod_collected", parsed: { amount_minor: "500" } }),
      codRemitted: harness.row(file, { eventClass: "cod_remittance_in", parsed: { amount_minor: "450" } })
    };

    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000001", entryType: "shipment_charge", amount: 1000n, debit: harness.accounts.sellerShipping, credit: harness.accounts.courierPayable, rowRecord: rows.freight });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000002", entryType: "rto_freight_charge", amount: 300n, debit: harness.accounts.sellerShipping, credit: harness.accounts.courierPayable, rowRecord: rows.rto });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000003", entryType: "return_freight_charge", amount: 200n, debit: harness.accounts.sellerShipping, credit: harness.accounts.courierPayable, rowRecord: rows.returnFreight });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000004", entryType: "shipment_refund", amount: 100n, debit: harness.accounts.courierPayable, credit: harness.accounts.sellerShipping, rowRecord: rows.refund });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000005", entryType: "weight_dispute_hold", amount: 80n, debit: harness.accounts.sellerShipping, credit: harness.accounts.sellerDispute, rowRecord: rows.disputeDebit });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000006", entryType: "weight_dispute_release", amount: 30n, debit: harness.accounts.sellerDispute, credit: harness.accounts.sellerShipping, rowRecord: rows.disputeCredit });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000007", entryType: "cod_collected", amount: 500n, debit: harness.accounts.courierCodDue, credit: harness.accounts.sellerCod, rowRecord: rows.codCollected });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000008", entryType: "cod_remittance_in", amount: 450n, debit: harness.accounts.sellerCod, credit: harness.accounts.courierCodDue, rowRecord: rows.codRemitted });

    const report = await harness.service().generateRecoveryReport({ brandOrgId: "brand_alpha", includeRows: true });

    assert.equal(report.importQuality.postedRowCount, 8);
    assert.equal(report.importQuality.autoPostRateBps, 10000);
    assert.equal(report.importQuality.formatPackVersions[0], "alpha_pack@1.0.0");
    assert.deepEqual(report.financialSummary, {
      freightChargedMinor: "1000",
      rtoFreightChargedMinor: "300",
      returnFreightChargedMinor: "200",
      shipmentRefundMinor: "100",
      weightDisputeDebitMinor: "80",
      weightDisputeCreditMinor: "30",
      netWeightDisputeExposureMinor: "50",
      codCollectedMinor: "500",
      codRemittedMinor: "450",
      netCodReceivableMinor: "50",
      totalCourierPayableImpactMinor: "1400",
      totalSellerShippingImpactMinor: "1450"
    });
    assert.equal(report.rtoSummary.rtoCostPerRtoShipmentMinor, "300");
    assert.equal(report.rtoSummary.rtoCostShareBps, 3000);
    assert.equal(report.weightDisputeSummary.recoveryRateBps, 3750);
    assert.equal(report.codSummary.netCodReceivableMinor, "50");
    assert.equal(report.tieOut.debitTotalMinor, "2660");
    assert.equal(report.tieOut.creditTotalMinor, "2660");
    assert.equal(report.tieOut.reportMappedTotalMinor, "2660");
    assert.equal(report.tieOut.journalPostingCount, 16);
    assert.equal(report.courierSummary[0]?.freightChargedMinor, "1000");
    assert.equal(report.rowDetails?.length, 8);
    const exported = new RecoveryReportExporter().toJson(report);
    assert.equal(JSON.parse(exported).metadata.reportVersion, "w0c2");
    assert.equal(exported.includes(secretToken), false);
  });

  it("groups exceptions, missing ledger links, and extra ledger entries", async () => {
    const harness = makeHarness();
    const file = harness.file();
    const missing = harness.row(file, {
      eventClass: "shipment_charge",
      status: "posted",
      postedEntryRef: "W0IMP-alpha-000000000000000000000099",
      parsed: { amount_minor: "700" }
    });
    harness.row(file, {
      eventClass: "deduction_unattributed",
      shipmentId: null,
      status: "exception",
      exceptionCode: "deduction_unattributed",
      parsed: { amount_minor: "75" }
    });
    harness.row(file, {
      eventClass: "unknown_adjustment",
      shipmentId: null,
      status: "exception",
      exceptionCode: "unresolved_shipment",
      parsed: { amount_minor: "25" }
    });
    harness.entry({
      entryRef: "W0IMP-alpha-000000000000000000000100",
      entryType: "shipment_charge",
      amount: 900n,
      debit: harness.accounts.sellerShipping,
      credit: harness.accounts.courierPayable,
      fileRecord: file
    });

    const report = await harness.service().generateRecoveryReport({ brandOrgId: "brand_alpha" });

    assert.equal(missing.postedEntryRef, "W0IMP-alpha-000000000000000000000099");
    assert.equal(report.exceptions.deductionUnattributed.count, 1);
    assert.equal(report.exceptions.deductionUnattributed.amountMinor, "75");
    assert.equal(report.exceptions.unknownEventClassRows, 2);
    assert.equal(report.exceptions.unresolvedShipmentRows, 2);
    assert.equal(report.tieOut.rowsWithPostedEntryRefButMissingLedgerEntry, 1);
    assert.equal(report.tieOut.ledgerEntriesWithoutMatchingPostedStagingRow, 1);
    assert.equal(report.metadata.warnings.length, 1);
    assert.equal(report.courierSummary[0]?.unattributedDeductionMinor, "75");
  });

  it("ignores custodial-linked entries and warns", async () => {
    const harness = makeHarness();
    const file = harness.file();
    const row = harness.row(file, { eventClass: "shipment_charge", parsed: { amount_minor: "600" } });
    harness.entry({
      entryRef: "W0IMP-alpha-000000000000000000000200",
      entryType: "shipment_charge",
      amount: 600n,
      debit: harness.accounts.sellerShipping,
      credit: harness.accounts.courierPayable,
      rowRecord: row,
      ledgerScope: "custodial"
    });

    const report = await harness.service().generateRecoveryReport({ brandOrgId: "brand_alpha" });

    assert.equal(report.financialSummary.freightChargedMinor, "0");
    assert.equal(report.tieOut.rowsWithPostedEntryRefButMissingLedgerEntry, 1);
    assert.equal(report.metadata.warnings.some((warning) => warning.includes("shadow scoped only")), true);
  });

  it("applies file, period, courier, and date filters before ledger analysis", async () => {
    const harness = makeHarness();
    const included = harness.file({ id: "file_included", period: "2026-07", counterparty: "courier_alpha", createdAt: dayOffset(2) });
    const excludedBrand = harness.file({ id: "file_other_brand", brandOrgId: "brand_beta", period: "2026-07", counterparty: "courier_alpha", createdAt: dayOffset(2) });
    const includedRow = harness.row(included, { parsed: { amount_minor: "111" } });
    const excludedRow = harness.row(excludedBrand, { parsed: { amount_minor: "999" } });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000301", entryType: "shipment_charge", amount: 111n, debit: harness.accounts.sellerShipping, credit: harness.accounts.courierPayable, rowRecord: includedRow });
    harness.entry({ entryRef: "W0IMP-alpha-000000000000000000000302", entryType: "shipment_charge", amount: 999n, debit: harness.accounts.sellerShipping, credit: harness.accounts.courierPayable, rowRecord: excludedRow });

    const report = await harness.service().generateRecoveryReport({
      brandOrgId: "brand_alpha",
      period: "2026-07",
      courierCounterparty: "courier_alpha",
      fromDate: dayOffset(1).toISOString(),
      toDate: dayOffset(3).toISOString(),
      fileIds: ["file_included"]
    });

    assert.deepEqual(report.metadata.fileIds, ["file_included"]);
    assert.equal(report.financialSummary.freightChargedMinor, "111");
    assert.equal(report.tieOut.journalEntryCount, 1);
  });
});
