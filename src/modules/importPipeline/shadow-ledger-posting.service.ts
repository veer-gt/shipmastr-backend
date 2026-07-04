import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { ledgerService, LedgerService } from "../walletLedger/ledger.service.js";
import { ImportPipelineError } from "./import-pipeline.errors.js";
import { ShadowAccountProvisioningService, type ProvisionedShadowAccounts } from "./shadow-account-provisioning.service.js";
import {
  mapStagingRowToShadowLedgerCommand,
  parsePostingAmountMinor,
  type ShadowLedgerImportFile,
  type ShadowLedgerMappedCommand,
  type ShadowLedgerStagingRow
} from "./shadow-ledger-mapper.js";

type ImportFileWithRows = {
  id: string;
  counterparty: string | null;
  brandOrgId: string | null;
  formatPackVersionId: string | null;
  stagingRows: ShadowLedgerStagingRow[];
};

type ShadowLedgerPostingClient = {
  importFile: {
    findUnique(input: {
      where: { id: string };
      include: { stagingRows: { orderBy: { rowNo: "asc" } } };
    }): Promise<ImportFileWithRows | null>;
  };
  stagingRow: {
    update(input: { where: { id: bigint }; data: Record<string, unknown> }): Promise<ShadowLedgerStagingRow>;
  };
};

type PostReadyRowsForFileInput = {
  fileId: string;
  createdBy: string;
  dryRun?: boolean | undefined;
};

export type ShadowPostingRowResult = {
  stagingRowId: string;
  rowNo: number;
  status: "posted" | "mapped" | "skipped" | "failed";
  code?: string | undefined;
  entryRef?: string | undefined;
  entryType?: string | undefined;
  amountMinor?: string | undefined;
  idempotent?: boolean | undefined;
  command?: ShadowLedgerMappedCommand["command"] | undefined;
};

export type ShadowPostingBatchResult = {
  fileId: string;
  attemptedCount: number;
  postedCount: number;
  skippedCount: number;
  failedCount: number;
  dryRun: boolean;
  rows: ShadowPostingRowResult[];
};

const defaultClient = prisma as unknown as ShadowLedgerPostingClient;
const READY_STATUSES = new Set(["validated", "resolved", "ready_for_posting"]);

function cleanRequired(value: unknown, code: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new ImportPipelineError(code, code);
  return text;
}

function cleanInternalCreatedBy(value: unknown) {
  const text = cleanRequired(value, "LEDGER_POST_CREATED_BY_REQUIRED");
  if (/@/.test(text) || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) {
    throw new ImportPipelineError("LEDGER_CREATED_BY_MUST_BE_INTERNAL", "LEDGER_CREATED_BY_MUST_BE_INTERNAL");
  }
  if (text !== "import_pipeline_w0" && !text.startsWith("system:") && !text.startsWith("usr_")) {
    throw new ImportPipelineError("LEDGER_CREATED_BY_MUST_BE_INTERNAL", "LEDGER_CREATED_BY_MUST_BE_INTERNAL");
  }
  return text;
}

function isImportPipelineError(error: unknown): error is ImportPipelineError {
  return error instanceof ImportPipelineError;
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

function rowId(row: ShadowLedgerStagingRow) {
  return String(row.id);
}

function rowUpdateId(row: ShadowLedgerStagingRow) {
  return typeof row.id === "bigint" ? row.id : BigInt(String(row.id));
}

function safeExceptionDetail(code: string, row: ShadowLedgerStagingRow) {
  return {
    code,
    stagingRowId: rowId(row),
    rowNo: row.rowNo
  };
}

function resultForError(row: ShadowLedgerStagingRow, code: string): ShadowPostingRowResult {
  return {
    stagingRowId: rowId(row),
    rowNo: row.rowNo,
    status: "failed",
    code
  };
}

function shouldSkipRow(row: ShadowLedgerStagingRow) {
  if (row.postedEntryRef) return "ALREADY_POSTED";
  if (row.status === "exception") return "ROW_NOT_READY";
  if (!READY_STATUSES.has(row.status)) return "ROW_NOT_READY";
  return null;
}

function needsDisputeHoldBalance(mapping: ShadowLedgerMappedCommand) {
  return mapping.eventClass === "weight_dispute_credit";
}

export class ShadowLedgerPostingService {
  constructor(
    private readonly client: ShadowLedgerPostingClient = defaultClient,
    private readonly ledger: LedgerService = ledgerService,
    private readonly provisioning: ShadowAccountProvisioningService = new ShadowAccountProvisioningService(defaultClient as never, ledger)
  ) {}

  async postReadyRowsForFile(input: PostReadyRowsForFileInput): Promise<ShadowPostingBatchResult> {
    const fileId = cleanRequired(input.fileId, "IMPORT_FILE_ID_REQUIRED");
    const createdBy = cleanInternalCreatedBy(input.createdBy);
    const dryRun = input.dryRun === true;
    const file = await this.client.importFile.findUnique({
      where: { id: fileId },
      include: { stagingRows: { orderBy: { rowNo: "asc" } } }
    });
    if (!file) throw new ImportPipelineError("IMPORT_FILE_NOT_FOUND", "IMPORT_FILE_NOT_FOUND", { fileId });

    const importFile: ShadowLedgerImportFile = {
      id: file.id,
      formatPackVersionId: file.formatPackVersionId
    };
    const rows: ShadowPostingRowResult[] = [];
    let provisioned: ProvisionedShadowAccounts | null = null;

    for (const row of file.stagingRows) {
      const skipCode = shouldSkipRow(row);
      if (skipCode) {
        rows.push({
          stagingRowId: rowId(row),
          rowNo: row.rowNo,
          status: "skipped",
          code: skipCode,
          entryRef: row.postedEntryRef ?? undefined
        });
        continue;
      }

      try {
        provisioned ??= dryRun
          ? await this.provisioning.findAccountsForImportFile(file)
          : await this.provisioning.ensureAccountsForImportFile(file);
        const mapping = mapStagingRowToShadowLedgerCommand({
          importFile,
          row,
          accounts: provisioned.accounts,
          createdBy
        });
        if (needsDisputeHoldBalance(mapping)) {
          const balance = await this.provisioning.getBalancePaise(provisioned.accounts.seller.disputeHold);
          const amount = parsePostingAmountMinor(mapping.amountMinor, { allowNegative: false });
          if (balance < amount) throw new ImportPipelineError("INSUFFICIENT_DISPUTE_HOLD", "INSUFFICIENT_DISPUTE_HOLD");
        }

        if (dryRun) {
          rows.push({
            stagingRowId: rowId(row),
            rowNo: row.rowNo,
            status: "mapped",
            entryRef: mapping.entryRef,
            entryType: mapping.entryType,
            amountMinor: mapping.amountMinor,
            command: mapping.command
          });
          continue;
        }

        const posted = await this.ledger.postEntry(mapping.command);
        await this.client.stagingRow.update({
          where: { id: rowUpdateId(row) },
          data: { postedEntryRef: posted.entry.entryRef }
        });
        rows.push({
          stagingRowId: rowId(row),
          rowNo: row.rowNo,
          status: "posted",
          entryRef: posted.entry.entryRef,
          entryType: posted.entry.entryType,
          amountMinor: mapping.amountMinor,
          idempotent: posted.idempotent
        });
      } catch (error) {
        const code = isImportPipelineError(error)
          ? error.code
          : isHttpError(error) && error.status === 409
            ? "LEDGER_POST_CONFLICT"
            : isHttpError(error)
              ? "LEDGER_POST_FAILED"
              : "LEDGER_POST_FAILED";
        if (!dryRun) {
          await this.client.stagingRow.update({
            where: { id: rowUpdateId(row) },
            data: {
              status: "exception",
              exceptionCode: code,
              exceptionDetail: safeExceptionDetail(code, row)
            }
          });
        }
        rows.push(resultForError(row, code));
      }
    }

    return {
      fileId,
      attemptedCount: rows.length,
      postedCount: rows.filter((row) => row.status === "posted").length,
      skippedCount: rows.filter((row) => row.status === "skipped").length,
      failedCount: rows.filter((row) => row.status === "failed").length,
      dryRun,
      rows
    };
  }
}

export const shadowLedgerPostingService = new ShadowLedgerPostingService();
