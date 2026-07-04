import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import type { FixtureContentProvider } from "./fixture-content-provider.js";
import {
  correctionRowFingerprint,
  correctionSemanticKey,
  correctionShipmentKey,
  normalizeCorrectionAmountMinor
} from "./import-correction-fingerprint.js";
import type {
  ImportCorrectionAction,
  ImportCorrectionActionCounts,
  ImportCorrectionDiff,
  ImportCorrectionItem,
  ImportCorrectionParsedRow,
  ImportCorrectionPlan,
  ImportCorrectionPlanInput
} from "./import-correction.types.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { formatPackParserService, type FormatPackParserService } from "./format-pack-parser.service.js";

type JsonRecord = Record<string, unknown>;

type CorrectionStagingRow = {
  id: bigint | string;
  rowNo: number;
  parsed?: unknown;
  eventClass: string | null;
  shipmentId: string | null;
  status: string;
  exceptionCode: string | null;
  exceptionDetail?: unknown;
  postedEntryRef: string | null;
};

type CorrectionImportFile = {
  id: string;
  source: string;
  counterparty: string | null;
  brandOrgId: string | null;
  storagePath: string;
  formatPackVersionId: string | null;
  statedTotalMinor?: bigint | string | null;
  stagingRows: CorrectionStagingRow[];
};

type CorrectionClient = {
  importFile: {
    findUnique(input: {
      where: { id: string };
      include: { stagingRows: { orderBy: { rowNo: "asc" } } };
    }): Promise<CorrectionImportFile | null>;
  };
  importCorrectionBatch: {
    create(input: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  importCorrectionItem: {
    createMany(input: { data: Array<Record<string, unknown>> }): Promise<unknown>;
  };
};

type DryRunParser = Pick<FormatPackParserService, "dryRunParseCsv">;

type ComparableRow = {
  origin: "old" | "new";
  oldStagingRowId: string | null;
  proposedRowNo: number | null;
  oldPostedEntryRef: string | null;
  status: string;
  parsed: JsonRecord | null;
  eventClass: string | null;
  shipmentId: string | null;
  exceptionCode: string | null;
  exceptionDetail: JsonRecord | null;
  amountMinor: string | null;
  fingerprint: string;
  semanticKey: string | null;
  shipmentKey: string | null;
  postable: boolean;
  proposedEntryType: string | null;
};

class MissingImportCorrectionContentProvider implements FixtureContentProvider {
  async readText(): Promise<string> {
    throw new ImportPipelineError("IMPORT_CORRECTION_CONTENT_PROVIDER_REQUIRED");
  }
}

const defaultClient = prisma as unknown as CorrectionClient;
const defaultContentProvider = new MissingImportCorrectionContentProvider();

const PLANNER_VERSION = "w0c3a" as const;
const MAX_REASON_LENGTH = 500;

const ZERO_ACTION_COUNTS: ImportCorrectionActionCounts = {
  no_change: 0,
  post_new: 0,
  reverse_only: 0,
  reverse_and_repost: 0,
  still_exception: 0,
  unmatched_old_row: 0,
  ambiguous_match: 0
};

const EVENT_TO_ENTRY_TYPE: Record<string, string> = {
  freight_charged: "shipment_charge",
  rto_freight_charged: "rto_freight_charge",
  return_freight_charged: "return_freight_charge",
  shipment_refund: "shipment_refund",
  weight_dispute_debit: "weight_dispute_hold",
  weight_dispute_credit: "weight_dispute_release",
  cod_collected: "cod_collected",
  cod_remitted: "cod_remittance_in"
};

const POSTABLE_STATUSES = new Set(["parsed", "resolved", "validated", "ready_for_posting", "posted"]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanRequiredText(value: unknown, code: string, max = 240) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ImportPipelineError(code);
  return text.slice(0, max);
}

function cleanOptionalText(value: unknown, max = 240) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : null;
}

function cleanInternalPrincipal(value: unknown) {
  const text = cleanRequiredText(value, "IMPORT_CORRECTION_CREATED_BY_REQUIRED", 160);
  if (text.includes("@")) throw new ImportPipelineError("IMPORT_CORRECTION_CREATED_BY_INVALID");
  if (text === "import_pipeline_w0" || text.startsWith("system:") || text.startsWith("usr_")) return text;
  throw new ImportPipelineError("IMPORT_CORRECTION_CREATED_BY_INVALID");
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parsedRecord(value: unknown) {
  return isRecord(value) ? value : null;
}

function exceptionRecord(value: unknown) {
  return isRecord(value) ? value : null;
}

function stagedAmountMinor(parsed: JsonRecord | null) {
  return parsed ? normalizeCorrectionAmountMinor(parsed.amount_minor) : null;
}

function isPostableRow(row: Pick<ComparableRow, "amountMinor" | "eventClass" | "shipmentId" | "status">) {
  if (!POSTABLE_STATUSES.has(row.status)) return false;
  if (!row.shipmentId) return false;
  if (!row.eventClass || !EVENT_TO_ENTRY_TYPE[row.eventClass]) return false;
  if (!row.amountMinor) return false;
  return true;
}

function toParsedRow(row: CorrectionStagingRow): ImportCorrectionParsedRow {
  return {
    rowNo: row.rowNo,
    status: row.status,
    ...(parsedRecord(row.parsed) ? { parsed: parsedRecord(row.parsed)! } : {}),
    eventClass: row.eventClass,
    shipmentId: row.shipmentId,
    exceptionCode: row.exceptionCode,
    ...(exceptionRecord(row.exceptionDetail) ? { exceptionDetail: exceptionRecord(row.exceptionDetail)! } : {})
  };
}

function toOldComparable(row: CorrectionStagingRow): ComparableRow {
  const parsed = parsedRecord(row.parsed);
  const base = toParsedRow(row);
  const amountMinor = stagedAmountMinor(parsed);
  const comparable: ComparableRow = {
    origin: "old",
    oldStagingRowId: String(row.id),
    proposedRowNo: null,
    oldPostedEntryRef: row.postedEntryRef,
    status: row.status,
    parsed,
    eventClass: cleanOptionalText(row.eventClass),
    shipmentId: cleanOptionalText(row.shipmentId),
    exceptionCode: cleanOptionalText(row.exceptionCode),
    exceptionDetail: exceptionRecord(row.exceptionDetail),
    amountMinor,
    fingerprint: correctionRowFingerprint(base),
    semanticKey: correctionSemanticKey(base),
    shipmentKey: correctionShipmentKey(base),
    postable: false,
    proposedEntryType: null
  };
  comparable.postable = isPostableRow(comparable);
  comparable.proposedEntryType = comparable.eventClass ? EVENT_TO_ENTRY_TYPE[comparable.eventClass] ?? null : null;
  return comparable;
}

function toNewComparable(row: ImportCorrectionParsedRow): ComparableRow {
  const parsed = parsedRecord(row.parsed);
  const amountMinor = stagedAmountMinor(parsed);
  const comparable: ComparableRow = {
    origin: "new",
    oldStagingRowId: null,
    proposedRowNo: row.rowNo,
    oldPostedEntryRef: null,
    status: row.status,
    parsed,
    eventClass: cleanOptionalText(row.eventClass),
    shipmentId: cleanOptionalText(row.shipmentId),
    exceptionCode: cleanOptionalText(row.exceptionCode),
    exceptionDetail: exceptionRecord(row.exceptionDetail),
    amountMinor,
    fingerprint: correctionRowFingerprint(row),
    semanticKey: correctionSemanticKey(row),
    shipmentKey: correctionShipmentKey(row),
    postable: false,
    proposedEntryType: null
  };
  comparable.postable = isPostableRow(comparable);
  comparable.proposedEntryType = comparable.eventClass ? EVENT_TO_ENTRY_TYPE[comparable.eventClass] ?? null : null;
  return comparable;
}

function actionCounts() {
  return { ...ZERO_ACTION_COUNTS };
}

function addActionCount(counts: ImportCorrectionActionCounts, action: ImportCorrectionAction) {
  counts[action] += 1;
}

function createDiff(
  action: ImportCorrectionAction,
  oldRow: ComparableRow | null,
  newRow: ComparableRow | null,
  reasonCode: string
): ImportCorrectionDiff {
  return {
    oldAmountMinor: oldRow?.amountMinor ?? null,
    newAmountMinor: newRow?.amountMinor ?? null,
    oldEventClass: oldRow?.eventClass ?? null,
    newEventClass: newRow?.eventClass ?? null,
    oldShipmentId: oldRow?.shipmentId ?? null,
    newShipmentId: newRow?.shipmentId ?? null,
    oldStatus: oldRow?.status ?? null,
    newStatus: newRow?.status ?? null,
    oldPostedEntryRef: oldRow?.oldPostedEntryRef ?? null,
    proposedEntryType: newRow?.proposedEntryType ?? oldRow?.proposedEntryType ?? null,
    reasonCode: reasonCode || action
  };
}

function createItem(
  action: ImportCorrectionAction,
  oldRow: ComparableRow | null,
  newRow: ComparableRow | null,
  reasonCode: string,
  errorCode: string | null = null
): ImportCorrectionItem {
  return {
    oldStagingRowId: oldRow?.oldStagingRowId ?? null,
    proposedRowNo: newRow?.proposedRowNo ?? null,
    oldPostedEntryRef: oldRow?.oldPostedEntryRef ?? null,
    action,
    status: "planned",
    oldFingerprint: oldRow?.fingerprint ?? null,
    newFingerprint: newRow?.fingerprint ?? null,
    diff: createDiff(action, oldRow, newRow, reasonCode),
    errorCode,
    errorDetail: errorCode ? { reasonCode } : null,
    reversalEntryRef: null,
    correctedEntryRef: null
  };
}

function indexesByKey(rows: ComparableRow[], keySelector: (row: ComparableRow) => string | null) {
  const map = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = keySelector(row);
    if (!key) return;
    map.set(key, [...(map.get(key) ?? []), index]);
  });
  return map;
}

function unmatchedIndexes(indexes: number[], matched: Set<number>) {
  return indexes.filter((index) => !matched.has(index));
}

function uniqueUnmatched(indexes: number[] | undefined, matched: Set<number>) {
  const candidates = unmatchedIndexes(indexes ?? [], matched);
  return candidates.length === 1 ? candidates[0]! : null;
}

function amountChanged(oldRow: ComparableRow, newRow: ComparableRow) {
  return oldRow.amountMinor !== newRow.amountMinor;
}

function eventChanged(oldRow: ComparableRow, newRow: ComparableRow) {
  return oldRow.eventClass !== newRow.eventClass;
}

function statusChanged(oldRow: ComparableRow, newRow: ComparableRow) {
  return oldRow.status !== newRow.status;
}

function reasonForRepost(oldRow: ComparableRow, newRow: ComparableRow) {
  if (amountChanged(oldRow, newRow)) return "amount_changed";
  if (eventChanged(oldRow, newRow)) return "event_changed";
  if (statusChanged(oldRow, newRow)) return "status_changed";
  return "semantic_changed";
}

function oldRowWasPosted(row: ComparableRow) {
  return Boolean(row.oldPostedEntryRef);
}

function dryRunRows(result: Awaited<ReturnType<FormatPackParserService["dryRunParseCsv"]>>) {
  return result.rowResults.map((row) => ({
    rowNo: row.rowNo,
    status: row.status,
    ...(row.parsed ? { parsed: row.parsed } : {}),
    ...(row.eventClass ? { eventClass: row.eventClass } : {}),
    ...(row.shipmentId ? { shipmentId: row.shipmentId } : {}),
    ...(row.exceptionCode ? { exceptionCode: row.exceptionCode } : {}),
    ...(row.exceptionDetail ? { exceptionDetail: row.exceptionDetail } : {})
  } satisfies ImportCorrectionParsedRow));
}

function sanitizeDryRunSummary(
  result: Awaited<ReturnType<FormatPackParserService["dryRunParseCsv"]>>,
  plan: Omit<ImportCorrectionPlan, "batchId" | "items">
) {
  return {
    plannerVersion: PLANNER_VERSION,
    importFileId: plan.importFileId,
    oldFormatPackVersionId: plan.oldFormatPackVersionId,
    newFormatPackVersionId: plan.newFormatPackVersionId,
    rowCount: result.rowCount,
    parsedCount: result.parsedCount,
    resolvedCount: result.resolvedCount,
    exceptionCount: result.exceptionCount,
    skippedCount: result.skippedCount,
    fileStatus: result.fileStatus,
    fileExceptionCode: result.fileExceptionCode ?? null,
    actionCounts: plan.actionCounts,
    oldRowCount: plan.oldRowCount,
    newRowCount: plan.newRowCount,
    postedOldRowCount: plan.postedOldRowCount,
    warnings: plan.warnings
  };
}

export class ImportCorrectionPlannerService {
  constructor(
    private readonly client: CorrectionClient = defaultClient,
    private readonly parser: DryRunParser = formatPackParserService,
    private readonly contentProvider: FixtureContentProvider = defaultContentProvider
  ) {}

  async planCorrection(input: ImportCorrectionPlanInput): Promise<ImportCorrectionPlan> {
    const importFileId = cleanRequiredText(input.importFileId, "IMPORT_FILE_ID_REQUIRED");
    const newFormatPackVersionId = cleanRequiredText(input.newFormatPackVersionId, "IMPORT_CORRECTION_NEW_FORMAT_VERSION_REQUIRED");
    const reason = cleanRequiredText(input.reason, "IMPORT_CORRECTION_REASON_REQUIRED", MAX_REASON_LENGTH);
    const createdBy = cleanInternalPrincipal(input.createdBy);

    const importFile = await this.client.importFile.findUnique({
      where: { id: importFileId },
      include: { stagingRows: { orderBy: { rowNo: "asc" } } }
    });
    if (!importFile) throw new ImportPipelineError("IMPORT_FILE_NOT_FOUND");

    const content = await this.contentProvider.readText(importFile.storagePath);
    const dryRun = await this.parser.dryRunParseCsv({
      csvContent: content,
      formatPackVersionId: newFormatPackVersionId,
      statedTotalMinor: importFile.statedTotalMinor ?? null,
      source: importFile.source,
      counterparty: importFile.counterparty,
      brandOrgId: importFile.brandOrgId,
      ...(input.resolver ? { resolver: input.resolver } : {}),
      persistStagingRows: false
    });

    const oldRows = importFile.stagingRows.map((row) => toOldComparable(row));
    const newRows = dryRunRows(dryRun).map((row) => toNewComparable(row));
    const items = this.diffRows(oldRows, newRows);
    const counts = actionCounts();
    for (const item of items) addActionCount(counts, item.action);

    const warnings = this.collectWarnings(items);
    const planCore = {
      importFileId,
      oldFormatPackVersionId: importFile.formatPackVersionId,
      newFormatPackVersionId,
      reason,
      createdBy,
      actionCounts: counts,
      oldRowCount: oldRows.length,
      newRowCount: newRows.length,
      postedOldRowCount: oldRows.filter((row) => oldRowWasPosted(row)).length,
      unchangedCount: counts.no_change,
      postNewCount: counts.post_new,
      reverseOnlyCount: counts.reverse_only,
      reverseAndRepostCount: counts.reverse_and_repost,
      stillExceptionCount: counts.still_exception,
      ambiguousCount: counts.ambiguous_match,
      warnings
    };

    let batchId: string | undefined;
    if (input.persistPlan) {
      const batch = await this.client.importCorrectionBatch.create({
        data: {
          importFileId,
          oldFormatPackVersionId: importFile.formatPackVersionId,
          newFormatPackVersionId,
          reason,
          status: "planned",
          dryRunResult: json(sanitizeDryRunSummary(dryRun, planCore)),
          createdBy
        }
      });
      batchId = batch.id;
      if (items.length) {
        await this.client.importCorrectionItem.createMany({
          data: items.map((item) => ({
            batchId,
            oldStagingRowId: item.oldStagingRowId ? BigInt(item.oldStagingRowId) : null,
            proposedRowNo: item.proposedRowNo,
            oldPostedEntryRef: item.oldPostedEntryRef,
            action: item.action,
            status: item.status,
            oldFingerprint: item.oldFingerprint,
            newFingerprint: item.newFingerprint,
            diff: json(item.diff),
            errorCode: item.errorCode,
            errorDetail: item.errorDetail ? json(item.errorDetail) : Prisma.JsonNull,
            reversalEntryRef: null,
            correctedEntryRef: null
          }))
        });
      }
    }

    return {
      ...(batchId ? { batchId } : {}),
      ...planCore,
      items
    };
  }

  private diffRows(oldRows: ComparableRow[], newRows: ComparableRow[]) {
    const items: ImportCorrectionItem[] = [];
    const matchedOld = new Set<number>();
    const matchedNew = new Set<number>();
    const oldByFingerprint = indexesByKey(oldRows, (row) => row.fingerprint);
    const newByFingerprint = indexesByKey(newRows, (row) => row.fingerprint);
    const oldBySemanticKey = indexesByKey(oldRows, (row) => row.semanticKey);
    const newBySemanticKey = indexesByKey(newRows, (row) => row.semanticKey);
    const newByShipmentKey = indexesByKey(newRows, (row) => row.shipmentKey);

    for (const [fingerprint, oldIndexes] of oldByFingerprint.entries()) {
      const newIndexes = newByFingerprint.get(fingerprint) ?? [];
      if (!newIndexes.length) continue;
      const oldCandidates = unmatchedIndexes(oldIndexes, matchedOld);
      const newCandidates = unmatchedIndexes(newIndexes, matchedNew);
      if (!oldCandidates.length || !newCandidates.length) continue;
      if (oldCandidates.length === 1 && newCandidates.length === 1) {
        const oldIndex = oldCandidates[0]!;
        const newIndex = newCandidates[0]!;
        const oldRow = oldRows[oldIndex]!;
        const newRow = newRows[newIndex]!;
        if (oldRowWasPosted(oldRow)) {
          items.push(createItem("no_change", oldRow, newRow, "same_fingerprint"));
        } else if (!newRow.postable) {
          items.push(createItem("still_exception", oldRow, newRow, "same_unpostable_fingerprint", newRow.exceptionCode));
        } else {
          items.push(createItem("post_new", oldRow, newRow, "previously_unposted_now_postable"));
        }
        matchedOld.add(oldIndex);
        matchedNew.add(newIndex);
      } else {
        const oldIndex = oldCandidates[0]!;
        const newIndex = newCandidates[0]!;
        items.push(createItem("ambiguous_match", oldRows[oldIndex]!, newRows[newIndex]!, "fingerprint_multiple_rows", "AMBIGUOUS_MATCH"));
        for (const index of oldCandidates) matchedOld.add(index);
        for (const index of newCandidates) matchedNew.add(index);
      }
    }

    for (const oldRow of oldRows) {
      const oldIndex = oldRows.indexOf(oldRow);
      if (matchedOld.has(oldIndex)) continue;
      if (!oldRowWasPosted(oldRow)) continue;

      const semanticCandidates = unmatchedIndexes(newBySemanticKey.get(oldRow.semanticKey ?? "") ?? [], matchedNew)
        .filter((index) => newRows[index]?.postable);
      if (semanticCandidates.length === 1) {
        const newIndex = semanticCandidates[0]!;
        items.push(createItem("reverse_and_repost", oldRow, newRows[newIndex]!, reasonForRepost(oldRow, newRows[newIndex]!)));
        matchedOld.add(oldIndex);
        matchedNew.add(newIndex);
        continue;
      }
      if (semanticCandidates.length > 1) {
        items.push(createItem("ambiguous_match", oldRow, newRows[semanticCandidates[0]!]!, "semantic_multiple_new_rows", "AMBIGUOUS_MATCH"));
        matchedOld.add(oldIndex);
        for (const index of semanticCandidates) matchedNew.add(index);
        continue;
      }

      const shipmentCandidates = unmatchedIndexes(newByShipmentKey.get(oldRow.shipmentKey ?? "") ?? [], matchedNew)
        .filter((index) => newRows[index]?.postable);
      if (shipmentCandidates.length === 1) {
        const newIndex = shipmentCandidates[0]!;
        items.push(createItem("reverse_and_repost", oldRow, newRows[newIndex]!, reasonForRepost(oldRow, newRows[newIndex]!)));
        matchedOld.add(oldIndex);
        matchedNew.add(newIndex);
        continue;
      }
      if (shipmentCandidates.length > 1) {
        items.push(createItem("ambiguous_match", oldRow, newRows[shipmentCandidates[0]!]!, "shipment_multiple_new_rows", "AMBIGUOUS_MATCH"));
        matchedOld.add(oldIndex);
        for (const index of shipmentCandidates) matchedNew.add(index);
        continue;
      }

      items.push(createItem("reverse_only", oldRow, null, "posted_old_row_missing_from_new_parse"));
      matchedOld.add(oldIndex);
    }

    for (const oldRow of oldRows) {
      const oldIndex = oldRows.indexOf(oldRow);
      if (matchedOld.has(oldIndex)) continue;
      const newIndex = uniqueUnmatched(newBySemanticKey.get(oldRow.semanticKey ?? ""), matchedNew)
        ?? uniqueUnmatched(newByShipmentKey.get(oldRow.shipmentKey ?? ""), matchedNew);
      if (newIndex !== null && !newRows[newIndex]!.postable) {
        items.push(createItem("still_exception", oldRow, newRows[newIndex]!, "still_unpostable"));
        matchedOld.add(oldIndex);
        matchedNew.add(newIndex);
        continue;
      }
      items.push(createItem("unmatched_old_row", oldRow, null, "unposted_old_row_missing_from_new_parse", "UNMATCHED_OLD_ROW"));
      matchedOld.add(oldIndex);
    }

    for (const [newIndex, newRow] of newRows.entries()) {
      if (matchedNew.has(newIndex)) continue;
      if (newRow.postable) items.push(createItem("post_new", null, newRow, "new_postable_row"));
      else items.push(createItem("still_exception", null, newRow, newRow.exceptionCode ?? "new_unpostable_row", newRow.exceptionCode));
      matchedNew.add(newIndex);
    }

    return items;
  }

  private collectWarnings(items: ImportCorrectionItem[]) {
    const warnings = new Set<string>();
    if (items.some((item) => item.action === "ambiguous_match")) warnings.add("AMBIGUOUS_MATCH_REVIEW_REQUIRED");
    if (items.some((item) => item.action === "reverse_only")) warnings.add("REVERSAL_REVIEW_REQUIRED");
    if (items.some((item) => item.action === "unmatched_old_row")) warnings.add("UNMATCHED_OLD_ROW_REVIEW_REQUIRED");
    return [...warnings].sort();
  }
}

export const importCorrectionPlannerService = new ImportCorrectionPlannerService();
