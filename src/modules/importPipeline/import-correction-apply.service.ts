import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  computeCommandHash,
  ledgerService,
  type LedgerEntryType,
  type LedgerScope,
  type LedgerService,
  type PostLedgerEntryCommand,
  type PostingDirection
} from "../walletLedger/ledger.service.js";
import {
  mapStagingRowToShadowLedgerCommand,
  shortHash,
  type ShadowLedgerAccountSet,
  type ShadowLedgerStagingRow
} from "./shadow-ledger-mapper.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { ShadowAccountProvisioningService } from "./shadow-account-provisioning.service.js";
import type {
  ApplyImportCorrectionBatchInput,
  ApproveImportCorrectionBatchInput,
  CorrectionApplyResult,
  ImportCorrectionApplyItemStatus,
  ImportCorrectionApplyOperation,
  ImportCorrectionApprovalResult
} from "./import-correction-apply.types.js";
import type { ImportCorrectionAction, ImportCorrectionDiff } from "./import-correction.types.js";

type JsonRecord = Record<string, unknown>;

type CorrectionApplyImportFile = {
  id: string;
  brandOrgId: string | null;
  counterparty: string | null;
  formatPackVersionId: string | null;
};

type CorrectionApplyItem = {
  id: string;
  batchId: string;
  oldStagingRowId: bigint | string | null;
  proposedRowNo: number | null;
  oldPostedEntryRef: string | null;
  action: ImportCorrectionAction;
  status: ImportCorrectionApplyItemStatus | string;
  oldFingerprint: string | null;
  newFingerprint: string | null;
  diff: unknown;
  errorCode: string | null;
  errorDetail: unknown;
  reversalEntryRef: string | null;
  correctedEntryRef: string | null;
  createdAt: Date;
};

type CorrectionApplyBatch = {
  id: string;
  importFileId: string;
  oldFormatPackVersionId: string | null;
  newFormatPackVersionId: string;
  reason: string;
  status: string;
  createdBy: string;
  approvedBy: string | null;
  appliedBy: string | null;
  importFile: CorrectionApplyImportFile;
  items: CorrectionApplyItem[];
};

type ApplyPosting = {
  id?: string;
  entryId: string;
  accountId: string;
  direction: PostingDirection;
  amountPaise: bigint | string;
  currency: string;
};

type ApplyJournalEntry = {
  id: string;
  entryRef: string;
  commandHash: string;
  entryType: LedgerEntryType;
  ledgerScope: LedgerScope;
  currency: string;
  sourceType: string;
  sourceRef: string;
  reversalOf?: string | null;
  narrative?: string | null;
  createdBy?: string | null;
  postings: ApplyPosting[];
};

type CorrectionApplyClient = {
  importCorrectionBatch: {
    findUnique(input: Record<string, unknown>): Promise<CorrectionApplyBatch | null>;
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<CorrectionApplyBatch>;
  };
  importCorrectionItem: {
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<CorrectionApplyItem>;
  };
  journalEntry: {
    findUnique(input: Record<string, unknown>): Promise<ApplyJournalEntry | null>;
    findFirst(input: Record<string, unknown>): Promise<ApplyJournalEntry | null>;
  };
};

const defaultClient = prisma as unknown as CorrectionApplyClient;
const BLOCKING_ACTIONS = new Set<ImportCorrectionAction>(["ambiguous_match", "unmatched_old_row"]);
const NON_POSTING_ACTIONS = new Set<ImportCorrectionAction>(["no_change", "still_exception"]);
const APPLIED_STATUSES = new Set(["applied", "skipped"]);
const SKIPPABLE_STATUSES = new Set(["skipped", "cancelled"]);
const SHADOW_SCOPE = "shadow" as const;
const REVERSAL_NARRATIVE = "W0 shadow correction reversal";
const CORRECTED_NARRATIVE = "W0 shadow correction posting";
const APPLYABLE_BATCH_STATUSES = new Set(["approved", "failed"]);
const APPLYABLE_ITEM_STATUSES = new Set(["planned", "failed"]);
const OLD_EVENT_TO_ENTRY_TYPE: Record<string, LedgerEntryType> = {
  freight_charged: "shipment_charge",
  rto_freight_charged: "rto_freight_charge",
  return_freight_charged: "return_freight_charge",
  shipment_refund: "shipment_refund",
  weight_dispute_debit: "weight_dispute_hold",
  weight_dispute_credit: "weight_dispute_release",
  cod_collected: "cod_collected",
  cod_remitted: "cod_remittance_in"
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanRequiredText(value: unknown, code: string, max = 240) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ImportPipelineError(code, code);
  return text.slice(0, max);
}

function cleanInternalPrincipal(value: unknown) {
  const text = cleanRequiredText(value, "IMPORT_CORRECTION_INTERNAL_PRINCIPAL_REQUIRED", 160);
  if (text.includes("@")) throw new ImportPipelineError("IMPORT_CORRECTION_INTERNAL_PRINCIPAL_INVALID", "IMPORT_CORRECTION_INTERNAL_PRINCIPAL_INVALID");
  if (text === "import_pipeline_w0" || text.startsWith("system:") || text.startsWith("usr_")) return text;
  throw new ImportPipelineError("IMPORT_CORRECTION_INTERNAL_PRINCIPAL_INVALID", "IMPORT_CORRECTION_INTERNAL_PRINCIPAL_INVALID");
}

function diffRecord(item: CorrectionApplyItem): ImportCorrectionDiff {
  if (!isRecord(item.diff)) throw new ImportPipelineError("IMPORT_CORRECTION_DIFF_INVALID", "IMPORT_CORRECTION_DIFF_INVALID", { itemId: item.id });
  return item.diff as ImportCorrectionDiff;
}

function requiredDiffText(value: unknown, code: string) {
  return cleanRequiredText(value, code, 160);
}

function requiredMinor(value: unknown) {
  const text = requiredDiffText(value, "IMPORT_CORRECTION_AMOUNT_REQUIRED");
  if (!/^[1-9][0-9]*$/.test(text)) throw new ImportPipelineError("IMPORT_CORRECTION_AMOUNT_INVALID", "IMPORT_CORRECTION_AMOUNT_INVALID");
  return text;
}

function entryRef(prefix: "REV" | "NEW" | "FIX", value: unknown) {
  return `W0COR-${prefix}-${shortHash(stableJson(value))}`;
}

function sourceSafeHash(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 24);
}

function inverseDirection(direction: PostingDirection): PostingDirection {
  return direction === "debit" ? "credit" : "debit";
}

function errorCode(error: unknown) {
  if (error instanceof ImportPipelineError) return error.code;
  if (error instanceof HttpError) return error.message;
  if (isUniqueConstraintError(error)) return "REVERSAL_UNIQUE_CONFLICT";
  if (error instanceof Error && error.name) return error.name;
  return "IMPORT_CORRECTION_APPLY_FAILED";
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function operationFor(item: CorrectionApplyItem, status: ImportCorrectionApplyItemStatus, error: string | null = null): ImportCorrectionApplyOperation {
  return {
    itemId: item.id,
    action: item.action,
    status,
    reversalEntryRef: item.reversalEntryRef,
    correctedEntryRef: item.correctedEntryRef,
    errorCode: error
  };
}

function isBatchComplete(operations: ImportCorrectionApplyOperation[]) {
  return operations.every((operation) => operation.status === "applied" || operation.status === "skipped");
}

function postingAmountText(value: bigint | string) {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function postingShape(postings: Array<{ accountId: string; direction: PostingDirection; amountPaise: bigint | string; currency: string }>) {
  return postings
    .map((posting) => ({
      accountId: posting.accountId,
      direction: posting.direction,
      amountPaise: postingAmountText(posting.amountPaise),
      currency: posting.currency
    }))
    .sort((left, right) => {
      const accountOrder = left.accountId.localeCompare(right.accountId);
      if (accountOrder !== 0) return accountOrder;
      const directionOrder = left.direction.localeCompare(right.direction);
      if (directionOrder !== 0) return directionOrder;
      return left.amountPaise.localeCompare(right.amountPaise);
    });
}

function expectedOldEntryType(diff: ImportCorrectionDiff) {
  const oldEventClass = typeof diff.oldEventClass === "string" ? diff.oldEventClass.trim() : "";
  return oldEventClass ? OLD_EVENT_TO_ENTRY_TYPE[oldEventClass] ?? null : null;
}

function summarizeResult(input: {
  batch: CorrectionApplyBatch;
  dryRun: boolean;
  appliedBy: string;
  operations: ImportCorrectionApplyOperation[];
  status?: string | undefined;
}): CorrectionApplyResult {
  return {
    batchId: input.batch.id,
    dryRun: input.dryRun,
    status: input.status ?? input.batch.status,
    appliedBy: input.appliedBy,
    itemCount: input.operations.length,
    postedReversalCount: input.operations.filter((operation) => operation.reversalEntryRef).length,
    postedCorrectedCount: input.operations.filter((operation) => operation.correctedEntryRef).length,
    skippedCount: input.operations.filter((operation) => operation.status === "skipped").length,
    failedCount: input.operations.filter((operation) => operation.status === "failed").length,
    operations: input.operations
  };
}

function batchInclude() {
  return {
    importFile: true,
    items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] }
  };
}

export class ImportCorrectionApplyService {
  constructor(
    private readonly client: CorrectionApplyClient = defaultClient,
    private readonly ledger: LedgerService = ledgerService,
    private readonly provisioning: ShadowAccountProvisioningService = new ShadowAccountProvisioningService(defaultClient as never, ledger)
  ) {}

  async approveCorrectionBatch(input: ApproveImportCorrectionBatchInput): Promise<ImportCorrectionApprovalResult> {
    const batchId = cleanRequiredText(input.batchId, "IMPORT_CORRECTION_BATCH_ID_REQUIRED");
    const approvedBy = cleanInternalPrincipal(input.approvedBy);
    const batch = await this.loadBatch(batchId);

    if (batch.status !== "planned") throw new ImportPipelineError("IMPORT_CORRECTION_BATCH_NOT_PLANNED", "IMPORT_CORRECTION_BATCH_NOT_PLANNED");
    if (batch.createdBy === approvedBy) throw new ImportPipelineError("IMPORT_CORRECTION_MAKER_CHECKER_REQUIRED", "IMPORT_CORRECTION_MAKER_CHECKER_REQUIRED");
    const blocker = batch.items.find((item) => BLOCKING_ACTIONS.has(item.action) && !SKIPPABLE_STATUSES.has(item.status));
    if (blocker) {
      throw new ImportPipelineError("IMPORT_CORRECTION_BATCH_HAS_BLOCKING_ITEMS", "IMPORT_CORRECTION_BATCH_HAS_BLOCKING_ITEMS", {
        itemId: blocker.id,
        action: blocker.action
      });
    }

    const approvedAt = new Date();
    await this.client.importCorrectionBatch.update({
      where: { id: batch.id },
      data: {
        status: "approved",
        approvedBy,
        approvedAt
      }
    });
    return { batchId: batch.id, status: "approved", approvedBy, approvedAt };
  }

  async applyCorrectionBatch(input: ApplyImportCorrectionBatchInput): Promise<CorrectionApplyResult> {
    const batchId = cleanRequiredText(input.batchId, "IMPORT_CORRECTION_BATCH_ID_REQUIRED");
    const appliedBy = cleanInternalPrincipal(input.appliedBy);
    const dryRun = input.dryRun === true;
    const batch = await this.loadBatch(batchId);

    if (batch.status === "applied") {
      return summarizeResult({
        batch,
        dryRun,
        appliedBy,
        status: "applied",
        operations: batch.items.map((item) => operationFor(item, APPLIED_STATUSES.has(item.status) ? item.status as ImportCorrectionApplyItemStatus : "applied", item.errorCode))
      });
    }
    if (!APPLYABLE_BATCH_STATUSES.has(batch.status)) {
      throw new ImportPipelineError("STALE_CORRECTION_PLAN", "STALE_CORRECTION_PLAN", { status: batch.status });
    }
    const blockingItem = batch.items.find((item) => BLOCKING_ACTIONS.has(item.action) && !SKIPPABLE_STATUSES.has(item.status));
    if (blockingItem) {
      throw new ImportPipelineError("STALE_CORRECTION_PLAN", "STALE_CORRECTION_PLAN", {
        itemId: blockingItem.id,
        action: blockingItem.action
      });
    }

    if (dryRun) {
      return summarizeResult({
        batch,
        dryRun,
        appliedBy,
        operations: batch.items.map((item) => this.previewOperation(item))
      });
    }

    const provisioned = await this.provisioning.ensureAccountsForImportFile(batch.importFile);
    const operations: ImportCorrectionApplyOperation[] = [];
    for (const item of batch.items) {
      const operation = await this.applyItem(batch, item, appliedBy, provisioned.accounts);
      operations.push(operation);
    }

    const appliedAt = new Date();
    const nextStatus = isBatchComplete(operations) ? "applied" : "failed";
    await this.client.importCorrectionBatch.update({
      where: { id: batch.id },
      data: {
        status: nextStatus,
        appliedBy,
        appliedAt
      }
    });

    return summarizeResult({ batch, dryRun, appliedBy, operations, status: nextStatus });
  }

  private async loadBatch(batchId: string) {
    const batch = await this.client.importCorrectionBatch.findUnique({
      where: { id: batchId },
      include: batchInclude()
    });
    if (!batch) throw new ImportPipelineError("IMPORT_CORRECTION_BATCH_NOT_FOUND", "IMPORT_CORRECTION_BATCH_NOT_FOUND");
    return batch;
  }

  private previewOperation(item: CorrectionApplyItem): ImportCorrectionApplyOperation {
    if (NON_POSTING_ACTIONS.has(item.action)) return operationFor(item, "skipped");
    if (APPLIED_STATUSES.has(item.status)) return operationFor(item, item.status as ImportCorrectionApplyItemStatus, item.errorCode);
    if (BLOCKING_ACTIONS.has(item.action)) return operationFor(item, "failed", "IMPORT_CORRECTION_BLOCKING_ITEM_NOT_APPLIED");
    return operationFor(item, "planned", item.errorCode);
  }

  private async applyItem(
    batch: CorrectionApplyBatch,
    item: CorrectionApplyItem,
    appliedBy: string,
    accounts: ShadowLedgerAccountSet
  ): Promise<ImportCorrectionApplyOperation> {
    const freshItem = await this.assertItemApplyable(batch, item);
    if (freshItem.status === "applied" || freshItem.status === "skipped") return operationFor(freshItem, freshItem.status as ImportCorrectionApplyItemStatus, freshItem.errorCode);

    try {
      if (NON_POSTING_ACTIONS.has(freshItem.action)) {
        const updated = await this.updateItem(freshItem, {
          status: "skipped",
          errorCode: null,
          errorDetail: Prisma.JsonNull
        });
        return operationFor(updated, "skipped");
      }
      if (freshItem.action === "post_new") {
        const updated = await this.ensureCorrectedPosting(batch, freshItem, appliedBy, accounts, "NEW");
        return operationFor(updated, "applied");
      }
      if (freshItem.action === "reverse_only") {
        const updated = await this.ensureReversal(batch, freshItem, appliedBy);
        return operationFor(updated, "applied");
      }
      if (freshItem.action === "reverse_and_repost") {
        const reversed = await this.ensureReversal(batch, freshItem, appliedBy);
        const corrected = await this.ensureCorrectedPosting(batch, reversed, appliedBy, accounts, "FIX");
        return operationFor(corrected, "applied");
      }

      const failed = await this.failItem(freshItem, "STALE_CORRECTION_PLAN");
      return operationFor(failed, "failed", failed.errorCode);
    } catch (error) {
      const failed = await this.failItem(freshItem, errorCode(error));
      return operationFor(failed, "failed", failed.errorCode);
    }
  }

  private async ensureReversal(batch: CorrectionApplyBatch, item: CorrectionApplyItem, appliedBy: string) {
    const oldEntryRef = cleanRequiredText(item.oldPostedEntryRef, "IMPORT_CORRECTION_OLD_ENTRY_REF_REQUIRED", 120);
    const oldEntry = await this.client.journalEntry.findUnique({
      where: { entryRef: oldEntryRef },
      include: { postings: { orderBy: { id: "asc" } } }
    });
    this.assertTargetEntryCurrent(item, oldEntry);

    const command = this.reversalCommand(batch, item, oldEntry as ApplyJournalEntry, appliedBy);
    if (item.reversalEntryRef) {
      const existing = await this.client.journalEntry.findUnique({
        where: { entryRef: item.reversalEntryRef },
        include: { postings: { orderBy: { id: "asc" } } }
      });
      if (!existing || !this.isMatchingReversal(existing, oldEntry as ApplyJournalEntry, command)) {
        throw new ImportPipelineError("TARGET_ENTRY_CHANGED", "TARGET_ENTRY_CHANGED", { itemId: item.id });
      }
      return this.updateItem(item, {
        status: item.action === "reverse_only" ? "applied" : item.status,
        errorCode: null,
        errorDetail: Prisma.JsonNull
      });
    }

    const existingReversal = await this.findExistingReversal(oldEntry.id);
    if (existingReversal) {
      throw new ImportPipelineError("TARGET_ALREADY_REVERSED", "TARGET_ALREADY_REVERSED", { itemId: item.id });
    }

    const posted = await this.postReversalOrRecover(item, oldEntry as ApplyJournalEntry, command);
    return this.updateItem(item, {
      reversalEntryRef: posted.entry.entryRef,
      status: item.action === "reverse_only" ? "applied" : item.status,
      errorCode: null,
      errorDetail: Prisma.JsonNull
    });
  }

  private async assertItemApplyable(batch: CorrectionApplyBatch, item: CorrectionApplyItem) {
    const freshBatch = await this.loadBatch(batch.id);
    if (!APPLYABLE_BATCH_STATUSES.has(freshBatch.status)) {
      throw new ImportPipelineError("STALE_CORRECTION_PLAN", "STALE_CORRECTION_PLAN", {
        batchId: batch.id,
        status: freshBatch.status
      });
    }
    const freshItem = freshBatch.items.find((candidate) => candidate.id === item.id);
    if (!freshItem) {
      throw new ImportPipelineError("STALE_CORRECTION_PLAN", "STALE_CORRECTION_PLAN", { itemId: item.id });
    }
    if (freshItem.status === "applied" || freshItem.status === "skipped") return freshItem;
    if (!APPLYABLE_ITEM_STATUSES.has(freshItem.status)) {
      throw new ImportPipelineError("STALE_CORRECTION_PLAN", "STALE_CORRECTION_PLAN", {
        itemId: freshItem.id,
        status: freshItem.status
      });
    }
    if (BLOCKING_ACTIONS.has(freshItem.action)) {
      throw new ImportPipelineError("STALE_CORRECTION_PLAN", "STALE_CORRECTION_PLAN", {
        itemId: freshItem.id,
        action: freshItem.action
      });
    }
    return freshItem;
  }

  private assertTargetEntryCurrent(item: CorrectionApplyItem, oldEntry: ApplyJournalEntry | null): asserts oldEntry is ApplyJournalEntry {
    if (!oldEntry) {
      throw new ImportPipelineError("TARGET_ENTRY_NOT_FOUND", "TARGET_ENTRY_NOT_FOUND", { itemId: item.id });
    }
    if (oldEntry.ledgerScope !== SHADOW_SCOPE) {
      throw new ImportPipelineError("TARGET_ENTRY_SCOPE_MISMATCH", "TARGET_ENTRY_SCOPE_MISMATCH", { itemId: item.id });
    }
    if (oldEntry.reversalOf) {
      throw new ImportPipelineError("TARGET_ENTRY_CHANGED", "TARGET_ENTRY_CHANGED", { itemId: item.id });
    }

    const diff = diffRecord(item);
    const expectedType = expectedOldEntryType(diff);
    if (expectedType && oldEntry.entryType !== expectedType) {
      throw new ImportPipelineError("TARGET_ENTRY_CHANGED", "TARGET_ENTRY_CHANGED", { itemId: item.id });
    }
    if (diff.oldPostedEntryRef && diff.oldPostedEntryRef !== oldEntry.entryRef) {
      throw new ImportPipelineError("TARGET_ENTRY_CHANGED", "TARGET_ENTRY_CHANGED", { itemId: item.id });
    }
    if (diff.oldAmountMinor) {
      const expectedAmount = requiredMinor(diff.oldAmountMinor);
      const postings = oldEntry.postings;
      const hasDebit = postings.some((posting) => posting.direction === "debit");
      const hasCredit = postings.some((posting) => posting.direction === "credit");
      const amountsMatch = postings.length >= 2 && postings.every((posting) => postingAmountText(posting.amountPaise) === expectedAmount);
      const currenciesMatch = postings.every((posting) => posting.currency === oldEntry.currency);
      if (!hasDebit || !hasCredit || !amountsMatch || !currenciesMatch) {
        throw new ImportPipelineError("TARGET_ENTRY_CHANGED", "TARGET_ENTRY_CHANGED", { itemId: item.id });
      }
    }
  }

  private async findExistingReversal(reversalOf: string) {
    return this.client.journalEntry.findFirst({
      where: { reversalOf },
      include: { postings: { orderBy: { id: "asc" } } }
    });
  }

  private isMatchingReversal(existing: ApplyJournalEntry, oldEntry: ApplyJournalEntry, command: PostLedgerEntryCommand) {
    if (existing.reversalOf !== oldEntry.id) return false;
    if (existing.commandHash !== command.commandHash) return false;
    if (existing.entryType !== oldEntry.entryType) return false;
    if (existing.ledgerScope !== SHADOW_SCOPE) return false;
    if (existing.currency !== oldEntry.currency) return false;
    return stableJson(postingShape(existing.postings)) === stableJson(postingShape(command.postings.map((posting) => ({
      accountId: posting.accountId,
      direction: posting.direction,
      amountPaise: posting.amountPaise,
      currency: posting.currency ?? oldEntry.currency
    }))));
  }

  private async postReversalOrRecover(item: CorrectionApplyItem, oldEntry: ApplyJournalEntry, command: PostLedgerEntryCommand) {
    try {
      return await this.ledger.postEntry(command);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.findExistingReversal(oldEntry.id);
      if (existing && this.isMatchingReversal(existing, oldEntry, command)) {
        return { entry: existing, postings: existing.postings, idempotent: true };
      }
      throw new ImportPipelineError("REVERSAL_UNIQUE_CONFLICT", "REVERSAL_UNIQUE_CONFLICT", { itemId: item.id });
    }
  }

  private async ensureCorrectedPosting(
    batch: CorrectionApplyBatch,
    item: CorrectionApplyItem,
    appliedBy: string,
    accounts: ShadowLedgerAccountSet,
    refPrefix: "NEW" | "FIX"
  ) {
    if (item.correctedEntryRef) {
      return this.updateItem(item, {
        status: "applied",
        errorCode: null,
        errorDetail: Prisma.JsonNull
      });
    }

    const command = this.correctedCommand(batch, item, appliedBy, accounts, refPrefix);
    const posted = await this.ledger.postEntry(command);
    return this.updateItem(item, {
      correctedEntryRef: posted.entry.entryRef,
      status: "applied",
      errorCode: null,
      errorDetail: Prisma.JsonNull
    });
  }

  private reversalCommand(
    batch: CorrectionApplyBatch,
    item: CorrectionApplyItem,
    oldEntry: ApplyJournalEntry,
    appliedBy: string
  ): PostLedgerEntryCommand {
    const commandWithoutHash: Omit<PostLedgerEntryCommand, "commandHash"> = {
      entryRef: entryRef("REV", {
        batchId: batch.id,
        itemId: item.id,
        oldEntryRef: oldEntry.entryRef,
        oldEntryId: oldEntry.id
      }),
      entryType: oldEntry.entryType,
      ledgerScope: SHADOW_SCOPE,
      currency: oldEntry.currency,
      sourceType: oldEntry.sourceType,
      sourceRef: oldEntry.sourceRef,
      reversalOf: oldEntry.id,
      narrative: REVERSAL_NARRATIVE,
      createdBy: appliedBy,
      postings: oldEntry.postings.map((posting) => ({
        accountId: posting.accountId,
        direction: inverseDirection(posting.direction),
        amountPaise: typeof posting.amountPaise === "bigint" ? posting.amountPaise.toString() : String(posting.amountPaise),
        currency: posting.currency
      })),
      metadata: {
        importCorrectionBatchId: batch.id,
        importCorrectionItemId: item.id,
        reversedEntryRef: oldEntry.entryRef
      }
    };
    return { ...commandWithoutHash, commandHash: computeCommandHash(commandWithoutHash) };
  }

  private correctedCommand(
    batch: CorrectionApplyBatch,
    item: CorrectionApplyItem,
    appliedBy: string,
    accounts: ShadowLedgerAccountSet,
    refPrefix: "NEW" | "FIX"
  ): PostLedgerEntryCommand {
    const diff = diffRecord(item);
    const amountMinor = requiredMinor(diff.newAmountMinor);
    const eventClass = requiredDiffText(diff.newEventClass, "IMPORT_CORRECTION_EVENT_CLASS_REQUIRED");
    const shipmentId = requiredDiffText(diff.newShipmentId, "IMPORT_CORRECTION_SHIPMENT_ID_REQUIRED");
    const status = requiredDiffText(diff.newStatus ?? "resolved", "IMPORT_CORRECTION_ROW_STATUS_REQUIRED");
    const row: ShadowLedgerStagingRow = {
      id: `cor_${sourceSafeHash({ batchId: batch.id, itemId: item.id, rowNo: item.proposedRowNo })}`,
      fileId: batch.importFileId,
      rowNo: item.proposedRowNo ?? 0,
      parsed: { amount_minor: amountMinor },
      eventClass,
      shipmentId,
      status,
      postedEntryRef: null
    };
    const mapped = mapStagingRowToShadowLedgerCommand({
      importFile: {
        id: batch.importFileId,
        formatPackVersionId: batch.newFormatPackVersionId
      },
      row,
      accounts,
      createdBy: appliedBy
    });
    const commandWithoutHash: Omit<PostLedgerEntryCommand, "commandHash"> = {
      entryRef: entryRef(refPrefix, {
        batchId: batch.id,
        itemId: item.id,
        proposedRowNo: item.proposedRowNo,
        newFingerprint: item.newFingerprint,
        eventClass,
        shipmentId,
        amountMinor
      }),
      entryType: mapped.entryType,
      ledgerScope: SHADOW_SCOPE,
      currency: "INR",
      sourceType: mapped.command.sourceType,
      sourceRef: mapped.command.sourceRef,
      narrative: CORRECTED_NARRATIVE,
      createdBy: appliedBy,
      postings: mapped.command.postings,
      metadata: {
        importCorrectionBatchId: batch.id,
        importCorrectionItemId: item.id,
        plannedAction: item.action,
        newFingerprint: item.newFingerprint ?? null
      }
    };
    return { ...commandWithoutHash, commandHash: computeCommandHash(commandWithoutHash) };
  }

  private async updateItem(item: CorrectionApplyItem, data: Record<string, unknown>) {
    return this.client.importCorrectionItem.update({
      where: { id: item.id },
      data
    });
  }

  private async failItem(item: CorrectionApplyItem, code: string) {
    return this.updateItem(item, {
      status: "failed",
      errorCode: code,
      errorDetail: json({
        code,
        action: item.action
      })
    });
  }
}

export const importCorrectionApplyService = new ImportCorrectionApplyService();
