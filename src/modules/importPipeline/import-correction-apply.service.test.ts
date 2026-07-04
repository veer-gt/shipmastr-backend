import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ImportCorrectionApplyService } from "./import-correction-apply.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import type { PostLedgerEntryCommand, PostingDirection } from "../walletLedger/ledger.service.js";
import type { ImportCorrectionAction, ImportCorrectionDiff } from "./import-correction.types.js";

type Item = {
  id: string;
  batchId: string;
  oldStagingRowId: bigint | null;
  proposedRowNo: number | null;
  oldPostedEntryRef: string | null;
  action: ImportCorrectionAction;
  status: string;
  oldFingerprint: string | null;
  newFingerprint: string | null;
  diff: ImportCorrectionDiff & Record<string, unknown>;
  errorCode: string | null;
  errorDetail: unknown;
  reversalEntryRef: string | null;
  correctedEntryRef: string | null;
  createdAt: Date;
};

type PostedEntry = {
  id: string;
  entryRef: string;
  commandHash: string;
  entryType: PostLedgerEntryCommand["entryType"];
  ledgerScope: "shadow" | "custodial";
  currency: string;
  sourceType: string;
  sourceRef: string;
  reversalOf?: string | null;
  narrative?: string | null;
  createdBy?: string | null;
  postings: Array<{
    id: string;
    entryId: string;
    accountId: string;
    direction: PostingDirection;
    amountPaise: bigint;
    currency: string;
  }>;
};

const baseTime = new Date("2026-07-04T16:00:00.000Z");

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function diff(overrides: Partial<ImportCorrectionDiff> = {}): ImportCorrectionDiff & Record<string, unknown> {
  return {
    oldAmountMinor: "1000",
    newAmountMinor: "1250",
    oldEventClass: "freight_charged",
    newEventClass: "freight_charged",
    oldShipmentId: "shp_old",
    newShipmentId: "shp_new",
    oldStatus: "resolved",
    newStatus: "resolved",
    oldPostedEntryRef: "ile_old",
    proposedEntryType: "shipment_charge",
    reasonCode: "amount_changed",
    ...overrides
  };
}

function item(overrides: Partial<Item> & { action?: ImportCorrectionAction } = {}): Item {
  const index = overrides.id ?? "item_1";
  return {
    id: index,
    batchId: "batch_1",
    oldStagingRowId: null,
    proposedRowNo: 2,
    oldPostedEntryRef: "ile_old",
    action: overrides.action ?? "post_new",
    status: "planned",
    oldFingerprint: "old_fp",
    newFingerprint: "new_fp",
    diff: diff(),
    errorCode: null,
    errorDetail: null,
    reversalEntryRef: null,
    correctedEntryRef: null,
    createdAt: baseTime,
    ...overrides
  };
}

function oldEntry(overrides: Partial<PostedEntry> = {}): PostedEntry {
  return {
    id: "je_old",
    entryRef: "ile_old",
    commandHash: "a".repeat(64),
    entryType: "shipment_charge",
    ledgerScope: "shadow",
    currency: "INR",
    sourceType: "shipment",
    sourceRef: "shp_a1b2c3d4e5f60718293a4b5c",
    reversalOf: null,
    narrative: "old shadow posting",
    createdBy: "system:old",
    postings: [
      { id: "jp_1", entryId: "je_old", accountId: "acct_seller_shipping", direction: "debit", amountPaise: 1000n, currency: "INR" },
      { id: "jp_2", entryId: "je_old", accountId: "acct_courier_payable", direction: "credit", amountPaise: 1000n, currency: "INR" }
    ],
    ...overrides
  };
}

function makeReversal(original: PostedEntry, overrides: Partial<PostedEntry> = {}): PostedEntry {
  return {
    id: "je_reversal",
    entryRef: "W0COR-REV-existing",
    commandHash: "c".repeat(64),
    entryType: original.entryType,
    ledgerScope: original.ledgerScope,
    currency: original.currency,
    sourceType: original.sourceType,
    sourceRef: original.sourceRef,
    reversalOf: original.id,
    narrative: "W0 shadow correction reversal",
    createdBy: "system:runner",
    postings: original.postings.map((posting, index) => ({
      id: `jp_rev_${index}`,
      entryId: "je_reversal",
      accountId: posting.accountId,
      direction: posting.direction === "debit" ? "credit" : "debit",
      amountPaise: posting.amountPaise,
      currency: posting.currency
    })),
    ...overrides
  };
}

function makeHarness(
  items: Item[],
  options: {
    status?: string;
    createdBy?: string;
    oldEntries?: PostedEntry[];
    failRefs?: string[];
    uniqueConflictRefs?: string[];
    hideFirstReversalLookup?: boolean;
  } = {}
) {
  const state = {
    batch: {
      id: "batch_1",
      importFileId: "file_1",
      oldFormatPackVersionId: "fmt_old",
      newFormatPackVersionId: "fmt_new",
      reason: "apply correction",
      status: options.status ?? "approved",
      createdBy: options.createdBy ?? "system:maker",
      approvedBy: "system:checker",
      appliedBy: null as string | null,
      importFile: {
        id: "file_1",
        brandOrgId: "seller_alpha",
        counterparty: "courier_alpha",
        formatPackVersionId: "fmt_old"
      },
      items: items.map((next, index) => ({ ...next, createdAt: new Date(baseTime.getTime() + index) }))
    },
    oldEntries: options.oldEntries ?? [oldEntry()],
    batchUpdates: [] as Array<Record<string, unknown>>,
    itemUpdates: [] as Array<{ id: string; data: Record<string, unknown> }>,
    ledgerCalls: [] as PostLedgerEntryCommand[],
    provisionCalls: 0,
    failRefs: new Set(options.failRefs ?? []),
    uniqueConflictRefs: new Set(options.uniqueConflictRefs ?? []),
    findFirstCalls: 0
  };

  const client = {
    importCorrectionBatch: {
      findUnique: async () => clone(state.batch),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.batchUpdates.push(data);
        Object.assign(state.batch, data);
        return clone(state.batch);
      }
    },
    importCorrectionItem: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        state.itemUpdates.push({ id: where.id, data });
        const found = state.batch.items.find((candidate) => candidate.id === where.id);
        if (!found) throw new Error("item missing");
        Object.assign(found, data);
        return clone(found);
      }
    },
    journalEntry: {
      findUnique: async ({ where }: { where: { entryRef?: string; id?: string } }) => {
        const found = state.oldEntries.find((entry) => entry.entryRef === where.entryRef || entry.id === where.id);
        return found ? clone(found) : null;
      },
      findFirst: async ({ where }: { where: { reversalOf?: string } }) => {
        state.findFirstCalls += 1;
        if (options.hideFirstReversalLookup && state.findFirstCalls === 1) return null;
        const found = state.oldEntries.find((entry) => entry.reversalOf === where.reversalOf);
        return found ? clone(found) : null;
      }
    }
  };
  const ledger = {
    postEntry: async (command: PostLedgerEntryCommand) => {
      state.ledgerCalls.push(command);
      if (state.failRefs.has(command.entryRef)) throw new ImportPipelineError("LEDGER_POST_FAILED", "LEDGER_POST_FAILED");
      if (state.uniqueConflictRefs.has(command.entryRef)) {
        const error = new Error("unique conflict") as Error & { code: string };
        error.code = "P2002";
        throw error;
      }
      const entryId = `je_${state.ledgerCalls.length}`;
      const entry: PostedEntry = {
        id: entryId,
        entryRef: command.entryRef,
        commandHash: command.commandHash ?? "b".repeat(64),
        entryType: command.entryType,
        ledgerScope: command.ledgerScope ?? "shadow",
        currency: command.currency ?? "INR",
        sourceType: command.sourceType,
        sourceRef: command.sourceRef,
        reversalOf: command.reversalOf ?? null,
        narrative: command.narrative ?? null,
        createdBy: command.createdBy ?? null,
        postings: command.postings.map((posting, index) => ({
          id: `jp_new_${index}`,
          entryId,
          accountId: posting.accountId,
          direction: posting.direction,
          amountPaise: BigInt(String(posting.amountPaise)),
          currency: posting.currency ?? "INR"
        }))
      };
      state.oldEntries.push(entry);
      return {
        entry: {
          id: entry.id,
          entryRef: entry.entryRef,
          commandHash: entry.commandHash,
          entryType: entry.entryType,
          ledgerScope: entry.ledgerScope,
          currency: entry.currency,
          sourceType: entry.sourceType,
          sourceRef: entry.sourceRef,
          reversalOf: entry.reversalOf,
          narrative: entry.narrative,
          createdBy: entry.createdBy
        },
        postings: entry.postings,
        idempotent: false
      };
    }
  };
  const provisioning = {
    ensureAccountsForImportFile: async () => {
      state.provisionCalls += 1;
      return {
        accounts: {
          seller: {
            shippingBalance: "acct_seller_shipping",
            codReceivable: "acct_seller_cod",
            disputeHold: "acct_seller_dispute"
          },
          courier: {
            courierPayable: "acct_courier_payable",
            courierCodDue: "acct_courier_cod"
          }
        }
      };
    }
  };

  return {
    state,
    service: new ImportCorrectionApplyService(client as never, ledger as never, provisioning as never)
  };
}

describe("ImportCorrectionApplyService", () => {
  it("ships the single-reversal partial unique index migration", () => {
    const migration = readFileSync(new URL("../../../prisma/migrations/20260704170000_w0c3b_single_reversal_guard/migration.sql", import.meta.url), "utf8");
    const table = ["journal", "_entries"].join("");
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS je_single_reversal_idx/);
    assert.equal(migration.includes(`ON ${table} (reversal_of)`), true);
    assert.match(migration, /WHERE reversal_of IS NOT NULL/);
  });

  it("approves planned batches with maker-checker and rejects unsafe approvals", async () => {
    const ok = makeHarness([item()], { status: "planned", createdBy: "system:maker" });
    const approved = await ok.service.approveCorrectionBatch({ batchId: "batch_1", approvedBy: "usr_checker" });
    assert.equal(approved.status, "approved");
    assert.equal(ok.state.batch.status, "approved");
    assert.equal(ok.state.ledgerCalls.length, 0);

    await assert.rejects(
      makeHarness([item()], { status: "planned", createdBy: "usr_same" }).service.approveCorrectionBatch({ batchId: "batch_1", approvedBy: "usr_same" }),
      /IMPORT_CORRECTION_MAKER_CHECKER_REQUIRED/
    );
    await assert.rejects(
      makeHarness([item()], { status: "planned" }).service.approveCorrectionBatch({ batchId: "batch_1", approvedBy: ["lead", "@", "example.test"].join("") }),
      /IMPORT_CORRECTION_INTERNAL_PRINCIPAL_INVALID/
    );
    await assert.rejects(
      makeHarness([item()], { status: "approved" }).service.approveCorrectionBatch({ batchId: "batch_1", approvedBy: "usr_checker" }),
      /IMPORT_CORRECTION_BATCH_NOT_PLANNED/
    );
    await assert.rejects(
      makeHarness([item({ action: "ambiguous_match" })], { status: "planned" }).service.approveCorrectionBatch({ batchId: "batch_1", approvedBy: "usr_checker" }),
      /IMPORT_CORRECTION_BATCH_HAS_BLOCKING_ITEMS/
    );
    await assert.rejects(
      makeHarness([item({ action: "unmatched_old_row" })], { status: "planned" }).service.approveCorrectionBatch({ batchId: "batch_1", approvedBy: "usr_checker" }),
      /IMPORT_CORRECTION_BATCH_HAS_BLOCKING_ITEMS/
    );
  });

  it("dry run returns planned operations without mutations or ledger calls", async () => {
    const { service, state } = makeHarness([
      item({ id: "item_new", action: "post_new" }),
      item({ id: "item_rev", action: "reverse_only" })
    ]);
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner", dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.itemCount, 2);
    assert.equal(state.ledgerCalls.length, 0);
    assert.equal(state.batchUpdates.length, 0);
    assert.equal(state.itemUpdates.length, 0);
    assert.equal(state.provisionCalls, 0);
  });

  it("reverse_only posts exact inverse shadow reversal through the ledger", async () => {
    const { service, state } = makeHarness([item({ action: "reverse_only", correctedEntryRef: null })]);
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    const command = state.ledgerCalls[0]!;

    assert.equal(result.status, "applied");
    assert.equal(command.entryRef.startsWith("W0COR-REV-"), true);
    assert.equal(command.ledgerScope, "shadow");
    assert.equal(command.reversalOf, "je_old");
    assert.equal(command.narrative, "W0 shadow correction reversal");
    assert.equal(command.sourceRef, "shp_a1b2c3d4e5f60718293a4b5c");
    assert.deepEqual(command.postings.map((posting) => [posting.accountId, posting.direction, posting.amountPaise]), [
      ["acct_seller_shipping", "credit", "1000"],
      ["acct_courier_payable", "debit", "1000"]
    ]);
    assert.equal(state.batch.status, "applied");
    assert.equal(state.batch.items[0]?.status, "applied");
    assert.equal(state.batch.items[0]?.reversalEntryRef?.startsWith("W0COR-REV-"), true);
  });

  it("rejects non-shadow reversal targets without calling the ledger", async () => {
    const { service, state } = makeHarness(
      [item({ action: "reverse_only" })],
      { oldEntries: [oldEntry({ ledgerScope: "custodial" })] }
    );
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(result.status, "failed");
    assert.equal(result.failedCount, 1);
    assert.equal(state.ledgerCalls.length, 0);
    assert.equal(state.batch.items[0]?.status, "failed");
    assert.equal(state.batch.items[0]?.errorCode, "TARGET_ENTRY_SCOPE_MISMATCH");
  });

  it("fails stale reversal targets already reversed without calling the ledger", async () => {
    const original = oldEntry();
    const { service, state } = makeHarness(
      [item({ action: "reverse_only" })],
      { oldEntries: [original, makeReversal(original)] }
    );
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(result.status, "failed");
    assert.equal(result.failedCount, 1);
    assert.equal(state.ledgerCalls.length, 0);
    assert.equal(state.batch.items[0]?.errorCode, "TARGET_ALREADY_REVERSED");
  });

  it("fails stale reversal targets whose planned old posting shape changed", async () => {
    const { service, state } = makeHarness(
      [item({ action: "reverse_only" })],
      { oldEntries: [oldEntry({ postings: [
        { id: "jp_1", entryId: "je_old", accountId: "acct_seller_shipping", direction: "debit", amountPaise: 900n, currency: "INR" },
        { id: "jp_2", entryId: "je_old", accountId: "acct_courier_payable", direction: "credit", amountPaise: 900n, currency: "INR" }
      ] })] }
    );
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(result.status, "failed");
    assert.equal(state.ledgerCalls.length, 0);
    assert.equal(state.batch.items[0]?.errorCode, "TARGET_ENTRY_CHANGED");
  });

  it("fails stale reversal targets whose planned old entry type changed", async () => {
    const { service, state } = makeHarness(
      [item({ action: "reverse_only" })],
      { oldEntries: [oldEntry({ entryType: "shipment_refund" })] }
    );
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(result.status, "failed");
    assert.equal(state.ledgerCalls.length, 0);
    assert.equal(state.batch.items[0]?.errorCode, "TARGET_ENTRY_CHANGED");
  });

  it("reuses a stored reversal ref on retry after validating the existing reversal", async () => {
    const first = makeHarness([item({ action: "reverse_only" })]);
    await first.service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    const existing = first.state.oldEntries.find((entry) => entry.reversalOf === "je_old");
    assert.ok(existing);

    const retryItem = item({
      action: "reverse_only",
      status: "failed",
      reversalEntryRef: existing.entryRef
    });
    const { service, state } = makeHarness([retryItem], { oldEntries: [oldEntry(), existing] });
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(result.status, "applied");
    assert.equal(state.ledgerCalls.length, 0);
    assert.equal(state.batch.items[0]?.status, "applied");
    assert.equal(state.batch.items[0]?.reversalEntryRef, existing.entryRef);
  });

  it("recovers from a single-reversal unique conflict when the existing reversal matches", async () => {
    const probe = makeHarness([item({ action: "reverse_only" })]);
    await probe.service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    const existing = probe.state.oldEntries.find((entry) => entry.reversalOf === "je_old");
    assert.ok(existing);

    const { service, state } = makeHarness(
      [item({ action: "reverse_only" })],
      {
        oldEntries: [oldEntry(), existing],
        uniqueConflictRefs: [existing.entryRef],
        hideFirstReversalLookup: true
      }
    );
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(result.status, "applied");
    assert.equal(state.ledgerCalls.length, 1);
    assert.equal(state.batch.items[0]?.reversalEntryRef, existing.entryRef);
    assert.equal(state.batch.items[0]?.errorCode, null);
  });

  it("fails with a stable unique-conflict code when the duplicate reversal mismatches", async () => {
    const probe = makeHarness([item({ action: "reverse_only" })]);
    await probe.service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    const existing = probe.state.oldEntries.find((entry) => entry.reversalOf === "je_old");
    assert.ok(existing);
    const mismatched = { ...existing, commandHash: "d".repeat(64) };

    const { service, state } = makeHarness(
      [item({ action: "reverse_only" })],
      {
        oldEntries: [oldEntry(), mismatched],
        uniqueConflictRefs: [existing.entryRef],
        hideFirstReversalLookup: true
      }
    );
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(result.status, "failed");
    assert.equal(state.batch.items[0]?.errorCode, "REVERSAL_UNIQUE_CONFLICT");
  });

  it("post_new posts corrected shadow command with W0C1 accounts only", async () => {
    const { service, state } = makeHarness([item({ action: "post_new", oldPostedEntryRef: null })]);
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "usr_runner" });
    const command = state.ledgerCalls[0]!;

    assert.equal(result.status, "applied");
    assert.equal(command.entryRef.startsWith("W0COR-NEW-"), true);
    assert.equal(command.ledgerScope, "shadow");
    assert.equal(command.narrative, "W0 shadow correction posting");
    assert.equal(command.sourceRef.startsWith("shp_"), true);
    assert.deepEqual(command.postings.map((posting) => posting.accountId).sort(), ["acct_courier_payable", "acct_seller_shipping"]);
    assert.equal(state.batch.items[0]?.correctedEntryRef?.startsWith("W0COR-NEW-"), true);
  });

  it("reverse_and_repost recovers from partial retry without duplicating reversal", async () => {
    const first = makeHarness([item({ action: "reverse_and_repost" })]);
    const previewFix = await first.service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner", dryRun: true });
    assert.equal(previewFix.operations[0]?.status, "planned");

    const fixRefProbe = makeHarness([item({ action: "reverse_and_repost" })]);
    await fixRefProbe.service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    const fixRef = fixRefProbe.state.ledgerCalls.find((command) => command.entryRef.startsWith("W0COR-FIX-"))?.entryRef;
    assert.ok(fixRef);

    const { service, state } = makeHarness([item({ action: "reverse_and_repost" })], { failRefs: [fixRef] });
    const failed = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(failed.status, "failed");
    assert.equal(state.batch.items[0]?.reversalEntryRef?.startsWith("W0COR-REV-"), true);
    assert.equal(state.batch.items[0]?.correctedEntryRef, null);

    state.failRefs.clear();
    const recovered = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(recovered.status, "applied");
    assert.equal(state.ledgerCalls.filter((command) => command.entryRef.startsWith("W0COR-REV-")).length, 1);
    assert.equal(state.ledgerCalls.filter((command) => command.entryRef.startsWith("W0COR-FIX-")).length, 2);
    const recoveredItem = state.batch.items[0] as Item | undefined;
    assert.equal(typeof recoveredItem?.correctedEntryRef === "string" && recoveredItem.correctedEntryRef.startsWith("W0COR-FIX-"), true);
  });

  it("already applied entries do not post again and skip actions do not post", async () => {
    const { service, state } = makeHarness([
      item({ id: "item_done", action: "post_new", status: "applied", correctedEntryRef: "W0COR-NEW-a1b2c3d4e5f60718293a4b5c" }),
      item({ id: "item_same", action: "no_change" }),
      item({ id: "item_exception", action: "still_exception" })
    ]);
    const result = await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    assert.equal(result.status, "applied");
    assert.equal(state.ledgerCalls.length, 0);
    assert.equal(state.batch.items.find((next) => next.id === "item_same")?.status, "skipped");
    assert.equal(state.batch.items.find((next) => next.id === "item_exception")?.status, "skipped");
  });

  it("blocking actions cannot apply", async () => {
    const { service } = makeHarness([item({ action: "ambiguous_match" })]);
    await assert.rejects(
      service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" }),
      /STALE_CORRECTION_PLAN/
    );
  });

  it("keeps sensitive source tokens out of generated commands", async () => {
    const transportToken = ["A", "W", "B"].join("") + "-777";
    const contactToken = ["person", "@", "example.test"].join("");
    const { service, state } = makeHarness([
      item({
        action: "post_new",
        oldPostedEntryRef: null,
        diff: diff({
          newAmountMinor: "1000",
          newEventClass: "freight_charged",
          newShipmentId: "shp_safe",
          newStatus: "resolved",
          reasonCode: "safe",
          hidden_source_token: transportToken,
          contact_token: contactToken
        } as ImportCorrectionDiff & Record<string, unknown>)
      })
    ]);
    await service.applyCorrectionBatch({ batchId: "batch_1", appliedBy: "system:runner" });
    const output = JSON.stringify(state.ledgerCalls);
    assert.equal(output.includes(transportToken), false);
    assert.equal(output.includes(contactToken), false);
  });
});
