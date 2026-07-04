import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultAccountTypeConfigs, LedgerService, type LedgerAccountType, type LedgerOwnerType, type LedgerScope } from "../walletLedger/ledger.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { ShadowAccountProvisioningService } from "./shadow-account-provisioning.service.js";
import { ShadowLedgerPostingService } from "./shadow-ledger-posting.service.js";

const baseTime = new Date("2026-07-04T18:00:00.000Z");

type Owner = {
  id: string;
  ownerType: LedgerOwnerType;
  externalId: string | null;
  displayName: string | null;
};

type Account = {
  id: string;
  ownerId: string;
  ownerType: LedgerOwnerType;
  accountType: LedgerAccountType;
  accountClass: import("../walletLedger/ledger.service.js").LedgerAccountClass;
  status: string;
  ledgerScope: LedgerScope;
  currency: string;
};

type Posting = {
  id: string;
  entryId: string;
  accountId: string;
  direction: "debit" | "credit";
  amountPaise: bigint;
  currency: string;
};

function cloneState<T>(value: T): T {
  return structuredClone(value as any) as T;
}

function matchesWhere(record: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) {
      return (value.in as unknown[]).includes(record[key]);
    }
    return record[key] === value;
  });
}

function makeHarness() {
  const state = {
    files: [{
      id: "file_1",
      counterparty: "courier_alpha",
      brandOrgId: "seller_alpha",
      formatPackVersionId: "fpv_1"
    }] as any[],
    rows: [] as any[],
    owners: [] as Owner[],
    accounts: [] as Account[],
    entries: [] as any[],
    postings: [] as Posting[],
    balances: [] as Array<{ accountId: string; ledgerScope: LedgerScope; currency: string; balancePaise: bigint; lastJournalEntryId: string | null }>,
    outbox: [] as any[],
    failNextRowUpdate: false
  };

  function row(overrides: Record<string, unknown> = {}): any {
    const next = {
      id: BigInt(state.rows.length + 1),
      fileId: "file_1",
      rowNo: state.rows.length + 2,
      raw: { source_ref: "raw quarantine only" },
      parsed: { amount_minor: "11800", externalToken: "raw quarantine only" },
      eventClass: "freight_charged",
      shipmentId: `internal-shipment-${state.rows.length + 1}`,
      status: "validated",
      exceptionCode: null,
      exceptionDetail: null,
      postedEntryRef: null,
      ...overrides
    };
    state.rows.push(next);
    return next;
  }

  function tx() {
    return {
      $executeRaw: async () => ({ count: 0 }),
      $queryRaw: async () => [],
      accountTypeConfig: {
        findMany: async () => cloneState(defaultAccountTypeConfigs),
        findUnique: async ({ where }: any) => cloneState(defaultAccountTypeConfigs.find((config) => config.accountType === where.accountType) ?? null)
      },
      walletOwner: {
        findUnique: async ({ where }: any) => cloneState(state.owners.find((owner) => owner.ownerType === where.ownerType_externalId.ownerType && owner.externalId === where.ownerType_externalId.externalId) ?? null),
        create: async ({ data }: any) => {
          const existing = state.owners.find((owner) => owner.ownerType === data.ownerType && owner.externalId === (data.externalId ?? null));
          if (existing) return cloneState(existing);
          const owner = {
            id: `wo_${state.owners.length + 1}`,
            ownerType: data.ownerType,
            externalId: data.externalId ?? null,
            displayName: data.displayName ?? null
          };
          state.owners.push(owner);
          return cloneState(owner);
        }
      },
      walletAccount: {
        findFirst: async ({ where }: any) => cloneState(state.accounts.find((account) => matchesWhere(account, where)) ?? null),
        findMany: async ({ where }: any) => cloneState(state.accounts.filter((account) => matchesWhere(account, where))),
        create: async ({ data }: any) => {
          const existing = state.accounts.find((account) => account.ownerId === data.ownerId
            && account.accountType === data.accountType
            && account.ledgerScope === data.ledgerScope
            && account.currency === data.currency);
          if (existing) {
            const error = new Error("Unique constraint failed") as Error & { code: string };
            error.code = "P2002";
            throw error;
          }
          const account = {
            id: `wa_${state.accounts.length + 1}`,
            ownerId: data.ownerId,
            ownerType: data.ownerType,
            accountType: data.accountType,
            accountClass: data.accountClass,
            status: data.status,
            ledgerScope: data.ledgerScope,
            currency: data.currency
          };
          state.accounts.push(account);
          return cloneState(account);
        }
      },
      journalEntry: {
        findUnique: async ({ where, include }: any) => {
          const entry = state.entries.find((item) => item.entryRef === where.entryRef || item.id === where.id);
          if (!entry) return null;
          return cloneState({
            ...entry,
            ...(include?.postings ? { postings: state.postings.filter((posting) => posting.entryId === entry.id) } : {})
          });
        },
        create: async ({ data }: any) => {
          const entry = {
            id: `je_${state.entries.length + 1}`,
            createdAt: baseTime,
            ...data
          };
          state.entries.push(entry);
          return cloneState(entry);
        }
      },
      journalPosting: {
        createMany: async ({ data }: any) => {
          for (const posting of data) {
            state.postings.push({ id: `jp_${state.postings.length + 1}`, ...posting });
          }
          return { count: data.length };
        },
        findMany: async ({ where }: any) => cloneState(state.postings.filter((posting) => matchesWhere(posting, where)))
      },
      accountBalance: {
        findMany: async ({ where }: any) => cloneState(state.balances.filter((balance) => matchesWhere(balance, where))),
        upsert: async ({ where, create, update }: any) => {
          const existing = state.balances.find((balance) => balance.accountId === where.accountId);
          if (!existing) {
            const created = {
              accountId: create.accountId,
              ledgerScope: create.ledgerScope,
              currency: create.currency,
              balancePaise: BigInt(create.balancePaise),
              lastJournalEntryId: create.lastJournalEntryId
            };
            state.balances.push(created);
            return cloneState(created);
          }
          existing.balancePaise += BigInt(update.balancePaise.increment);
          existing.lastJournalEntryId = update.lastJournalEntryId;
          return cloneState(existing);
        }
      },
      walletEventsOutbox: {
        create: async ({ data }: any) => {
          const event = { id: `weo_${state.outbox.length + 1}`, createdAt: baseTime, ...data };
          state.outbox.push(event);
          return cloneState(event);
        }
      },
      importFile: {
        findUnique: async ({ where }: any) => {
          const file = state.files.find((item) => item.id === where.id);
          if (!file) return null;
          return cloneState({
            ...file,
            stagingRows: state.rows.filter((item) => item.fileId === file.id).sort((left, right) => left.rowNo - right.rowNo)
          });
        }
      },
      stagingRow: {
        update: async ({ where, data }: any) => {
          if (state.failNextRowUpdate) {
            state.failNextRowUpdate = false;
            throw new Error("row update failed");
          }
          const current = state.rows.find((item) => item.id === where.id);
          if (!current) throw new Error("ROW_NOT_FOUND");
          Object.assign(current, data);
          return cloneState(current);
        }
      }
    };
  }

  const api = tx();
  const client = {
    ...api,
    $transaction: async (callback: any) => callback(api)
  };
  const ledger = new LedgerService(client as any);
  const provisioning = new ShadowAccountProvisioningService(client as any, ledger);
  const service = new ShadowLedgerPostingService(client as any, ledger, provisioning);
  return { state, row, service, provisioning, ledger };
}

function accountById(state: ReturnType<typeof makeHarness>["state"], id: string) {
  const account = state.accounts.find((item) => item.id === id);
  assert.ok(account);
  return account;
}

async function postSingle(eventClass: string, parsed: Record<string, unknown> = { amount_minor: "11800" }) {
  const harness = makeHarness();
  harness.row({ eventClass, parsed });
  const result = await harness.service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });
  assert.equal(result.postedCount, 1);
  return { ...harness, result };
}

describe("W0C-1 staging to shadow ledger posting", () => {
  it("provisions only required shadow seller and courier accounts idempotently", async () => {
    const { state, provisioning } = makeHarness();
    const first = await provisioning.ensureAccountsForImportFile(state.files[0]);
    const second = await provisioning.ensureAccountsForImportFile(state.files[0]);

    assert.deepEqual(first.accounts, second.accounts);
    assert.deepEqual(state.accounts.map((account) => [account.ownerType, account.accountType, account.ledgerScope]).sort(), [
      ["courier", "courier_cod_due", "shadow"],
      ["courier", "courier_payable", "shadow"],
      ["seller", "cod_receivable", "shadow"],
      ["seller", "dispute_hold", "shadow"],
      ["seller", "shipping_balance", "shadow"]
    ]);
    assert.equal(state.accounts.some((account) => account.ledgerScope !== "shadow"), false);

    await assert.rejects(
      () => provisioning.ensureShadowAccount(state.owners.find((owner) => owner.ownerType === "seller")!, "checkout_balance"),
      (error) => error instanceof ImportPipelineError && error.code === "SHADOW_ACCOUNT_TYPE_NOT_ALLOWED_FOR_W0C"
    );
  });

  it("posts freight charges through LedgerService and recovers idempotently when the row ref was not marked", async () => {
    const { state, row, service } = makeHarness();
    const stagingRow = row({ eventClass: "freight_charged" });

    const first = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });
    assert.equal(first.postedCount, 1);
    assert.equal(state.entries.length, 1);
    assert.equal(state.outbox.length, 1);
    assert.equal(stagingRow.postedEntryRef, state.entries[0].entryRef);
    assert.equal(state.entries[0].entryType, "shipment_charge");
    assert.equal(state.entries[0].ledgerScope, "shadow");
    assert.equal(state.entries[0].createdBy, "system:w0c1-test");
    assert.match(state.entries[0].entryRef, /^W0IMP-SHIP-[a-f0-9]{24}$/);
    assert.match(state.entries[0].sourceRef, /^shp_[a-f0-9]{24}$/);
    assert.equal(state.entries[0].entryRef.includes("raw quarantine only"), false);
    assert.equal(state.entries[0].sourceRef.includes("internal-shipment"), false);
    assert.equal(state.outbox[0].payload.entryRef, state.entries[0].entryRef);
    assert.equal(state.outbox[0].payload.sourceRef, state.entries[0].sourceRef);

    const debit = state.postings.find((posting) => posting.direction === "debit");
    const credit = state.postings.find((posting) => posting.direction === "credit");
    assert.equal(accountById(state, debit!.accountId).accountType, "shipping_balance");
    assert.equal(accountById(state, credit!.accountId).accountType, "courier_payable");

    const skipped = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });
    assert.equal(skipped.skippedCount, 1);
    assert.equal(state.entries.length, 1);

    stagingRow.postedEntryRef = null;
    const recovered = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });
    assert.equal(recovered.rows[0]?.idempotent, true);
    assert.equal(state.entries.length, 1);
    assert.equal(stagingRow.postedEntryRef, state.entries[0].entryRef);
  });

  it("maps RTO, return freight, refunds, and COD events to the expected shadow entry types", async () => {
    for (const [eventClass, entryType] of [
      ["rto_freight_charged", "rto_freight_charge"],
      ["return_freight_charged", "return_freight_charge"],
      ["shipment_refund", "shipment_refund"],
      ["cod_collected", "cod_collected"],
      ["cod_remitted", "cod_remittance_in"]
    ] as Array<[string, string]>) {
      const { state } = await postSingle(eventClass);
      assert.equal(state.entries[0].entryType, entryType);
      assert.equal(state.entries[0].ledgerScope, "shadow");
      assert.equal(state.accounts.every((account) => account.ledgerScope === "shadow"), true);
    }
  });

  it("holds and releases weight disputes only with sufficient existing hold balance", async () => {
    const harness = makeHarness();
    harness.row({ eventClass: "weight_dispute_credit" });
    const insufficient = await harness.service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });
    assert.equal(insufficient.failedCount, 1);
    assert.equal(insufficient.rows[0]?.code, "INSUFFICIENT_DISPUTE_HOLD");
    assert.equal(harness.state.entries.length, 0);
    assert.equal(harness.state.outbox.length, 0);

    const funded = makeHarness();
    const hold = funded.row({ eventClass: "weight_dispute_debit" });
    const release = funded.row({ eventClass: "weight_dispute_credit", parsed: { amount_minor: "5000" }, shipmentId: "internal-shipment-release" });
    const result = await funded.service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });

    assert.equal(result.postedCount, 2);
    assert.equal(hold.postedEntryRef?.startsWith("W0IMP-WD-"), true);
    assert.equal(release.postedEntryRef?.startsWith("W0IMP-WDR-"), true);
    assert.deepEqual(funded.state.entries.map((entry) => entry.entryType), ["weight_dispute_hold", "weight_dispute_release"]);
  });

  it("rejects unpostable, unresolved, exception, zero, malformed, and unsupported signed rows safely", async () => {
    const { state, row, service } = makeHarness();
    row({ eventClass: "deduction_unattributed" });
    row({ eventClass: "unknown" });
    row({ eventClass: "freight_charged", shipmentId: null });
    row({ eventClass: "freight_charged", status: "exception" });
    row({ eventClass: "freight_charged", status: "staged" });
    row({ eventClass: "freight_charged", postedEntryRef: "W0IMP-OLD-opaque" });
    row({ eventClass: "freight_charged", parsed: { amount_minor: "0" } });
    row({ eventClass: "freight_charged", parsed: { amount_minor: "abc" } });
    row({ eventClass: "freight_charged", parsed: { amount_minor: "-100" } });

    const result = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });

    assert.equal(result.postedCount, 0);
    assert.equal(result.skippedCount, 3);
    assert.equal(result.failedCount, 6);
    assert.deepEqual(result.rows.map((item) => item.code), [
      "UNATTRIBUTED_DEDUCTION_NOT_POSTED",
      "UNKNOWN_EVENT_CLASS",
      "MISSING_SHIPMENT_ID",
      "ROW_NOT_READY",
      "ROW_NOT_READY",
      "ALREADY_POSTED",
      "ZERO_AMOUNT",
      "BAD_AMOUNT",
      "NEGATIVE_AMOUNT_UNSUPPORTED"
    ]);
    assert.equal(state.entries.length, 0);
    assert.equal(state.outbox.length, 0);
  });

  it("dry-runs commands without provisioning accounts, calling LedgerService, or mutating staging rows", async () => {
    const { state, row, service, provisioning } = makeHarness();
    await provisioning.ensureAccountsForImportFile(state.files[0]);
    const ownerCount = state.owners.length;
    const accountCount = state.accounts.length;
    const stagingRow = row({ eventClass: "cod_collected" });

    const result = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test", dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.postedCount, 0);
    assert.equal(result.rows[0]?.status, "mapped");
    assert.equal(result.rows[0]?.command?.entryType, "cod_collected");
    assert.equal(stagingRow.postedEntryRef, null);
    assert.equal(state.owners.length, ownerCount);
    assert.equal(state.accounts.length, accountCount);
    assert.equal(state.entries.length, 0);
    assert.equal(state.postings.length, 0);
    assert.equal(state.outbox.length, 0);
  });

  it("dry-run fails read-only account validation without creating owners or accounts", async () => {
    const { state, row, service } = makeHarness();
    const stagingRow = row({ eventClass: "cod_collected" });

    const result = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test", dryRun: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.failedCount, 1);
    assert.equal(result.rows[0]?.code, "ACCOUNT_PROVISIONING_FAILED");
    assert.equal(stagingRow.status, "validated");
    assert.equal(stagingRow.postedEntryRef, null);
    assert.equal(state.owners.length, 0);
    assert.equal(state.accounts.length, 0);
    assert.equal(state.entries.length, 0);
    assert.equal(state.outbox.length, 0);
  });

  it("rejects human-readable created_by values before posting", async () => {
    const { row, service } = makeHarness();
    row({ eventClass: "cod_collected" });

    await assert.rejects(
      () => service.postReadyRowsForFile({
        fileId: "file_1",
        createdBy: ["ops", "example.com"].join(String.fromCharCode(64))
      }),
      (error) => error instanceof ImportPipelineError && error.code === "LEDGER_CREATED_BY_MUST_BE_INTERNAL"
    );
    await assert.rejects(
      () => service.postReadyRowsForFile({
        fileId: "file_1",
        createdBy: "ops-person"
      }),
      (error) => error instanceof ImportPipelineError && error.code === "LEDGER_CREATED_BY_MUST_BE_INTERNAL"
    );
  });

  it("surfaces command hash conflicts without marking rows posted", async () => {
    const { state, row, service } = makeHarness();
    const stagingRow = row({ eventClass: "freight_charged" });
    const first = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });
    assert.equal(first.postedCount, 1);

    stagingRow.postedEntryRef = null;
    stagingRow.parsed = { amount_minor: "11900" };
    const dryRun = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test", dryRun: true });
    state.entries[0].entryRef = dryRun.rows[0]?.entryRef;
    const conflict = await service.postReadyRowsForFile({ fileId: "file_1", createdBy: "system:w0c1-test" });

    assert.equal(conflict.failedCount, 1);
    assert.equal(conflict.rows[0]?.code, "LEDGER_POST_CONFLICT");
    assert.equal(stagingRow.postedEntryRef, null);
  });

  it("keeps direct ledger writes out of the import posting service source", () => {
    const moduleDir = new URL(".", import.meta.url).pathname;
    const contents = readFileSync(join(moduleDir, "shadow-ledger-posting.service.js"), "utf8");
    const forbidden = [
      ["journal", "Entry.create"].join(""),
      ["journal", "Posting.create"].join(""),
      ["account", "Balance.update"].join(""),
      ["wallet", "EventOutbox.create"].join("")
    ];

    for (const marker of forbidden) {
      assert.equal(contents.includes(marker), false, `source contains ${marker}`);
    }
  });
});
