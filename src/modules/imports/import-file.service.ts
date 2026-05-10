import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CourierImportStatus } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { importCodRemittances } from "../codRemittances/cod-remittance.service.js";
import { importCourierInvoice } from "../courierInvoices/courier-invoice.service.js";
import { runReconciliation } from "../reconciliation/reconciliation.service.js";
import {
  normalizeCodRemittanceRows,
  normalizeInvoiceRows,
  type NormalizedCodRemittanceRow,
  type NormalizedInvoiceRow
} from "./import-normalizer.js";
import { parseImportFile } from "./tabular-file-parser.js";

type PreviewFileInput = {
  merchantId: string;
  fileName: string;
  mimeType?: string | undefined;
  buffer: Buffer;
};

type InvoicePreviewInput = PreviewFileInput & {
  courierId: string;
  invoiceNumber?: string | undefined;
  periodStart: Date;
  periodEnd: Date;
};

type CodPreviewInput = PreviewFileInput & {
  defaultCourierId?: string | undefined;
};

type CommitDeps = {
  importCourierInvoice?: typeof importCourierInvoice | undefined;
  importCodRemittances?: typeof importCodRemittances | undefined;
  runReconciliation?: typeof runReconciliation | undefined;
};

function hashFile(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metadataObject(value: unknown) {
  return isObject(value) ? value : {};
}

function previewSummary<T>(rows: Array<{
  rowNumber: number;
  valid: boolean;
  duplicateAwb: boolean;
  awb: string | null;
  errors: string[];
  normalizedData: T | null;
}>) {
  return {
    totalRows: rows.length,
    validRows: rows.filter((row) => row.valid).length,
    invalidRows: rows.filter((row) => !row.valid).length,
    duplicateAwbRows: rows.filter((row) => row.duplicateAwb).length,
    invalid: rows
      .filter((row) => !row.valid)
      .map((row) => ({ rowNumber: row.rowNumber, errors: row.errors })),
    duplicateAwbs: rows
      .filter((row) => row.duplicateAwb)
      .map((row) => ({ rowNumber: row.rowNumber, awb: row.awb }))
  };
}

async function assertUniqueHash(input: {
  merchantId: string;
  fileHash: string;
  kind: "INVOICE" | "COD";
}, client: typeof prisma) {
  const existing = input.kind === "INVOICE"
    ? await client.courierImportFile.findFirst({ where: { merchantId: input.merchantId, fileHash: input.fileHash } })
    : await client.codRemittanceImportFile.findFirst({ where: { merchantId: input.merchantId, fileHash: input.fileHash } });

  if (existing) {
    throw new HttpError(409, "DUPLICATE_IMPORT_FILE", {
      importFileId: existing.id,
      status: existing.status
    });
  }
}

export async function previewCourierInvoiceUpload(input: InvoicePreviewInput, client: typeof prisma = prisma) {
  const fileHash = hashFile(input.buffer);
  await assertUniqueHash({ merchantId: input.merchantId, fileHash, kind: "INVOICE" }, client);
  const parsedRows = await parseImportFile(input);
  const rows = normalizeInvoiceRows({ rows: parsedRows, courierId: input.courierId });
  const summary = previewSummary<NormalizedInvoiceRow>(rows);

  const file = await client.courierImportFile.create({
    data: {
      merchantId: input.merchantId,
      courierId: input.courierId,
      fileName: input.fileName,
      mimeType: input.mimeType ?? null,
      fileHash,
      status: "PREVIEWED",
      totalRows: summary.totalRows,
      validRows: summary.validRows,
      invalidRows: summary.invalidRows,
      duplicateAwbRows: summary.duplicateAwbRows,
      metadata: json({
        invoiceNumber: input.invoiceNumber ?? null,
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString()
      }),
      rows: {
        create: rows.map((row) => ({
          rowNumber: row.rowNumber,
          awb: row.awb,
          orderId: row.orderId,
          externalOrderId: row.externalOrderId,
          valid: row.valid,
          duplicateAwb: row.duplicateAwb,
          errors: row.errors,
          rawData: json(row.rawData),
          normalizedData: row.normalizedData ? json(row.normalizedData) : Prisma.JsonNull
        }))
      }
    },
    include: { rows: true }
  });

  await audit({
    merchantId: input.merchantId,
    action: "COURIER_INVOICE_UPLOAD_PREVIEWED",
    entityType: "CourierImportFile",
    entityId: file.id,
    metadata: { fileHash, ...summary }
  }, client);

  return { file, summary };
}

export async function previewCodRemittanceUpload(input: CodPreviewInput, client: typeof prisma = prisma) {
  const fileHash = hashFile(input.buffer);
  await assertUniqueHash({ merchantId: input.merchantId, fileHash, kind: "COD" }, client);
  const parsedRows = await parseImportFile(input);
  const rows = normalizeCodRemittanceRows({ rows: parsedRows, defaultCourierId: input.defaultCourierId });
  const summary = previewSummary<NormalizedCodRemittanceRow>(rows);

  const file = await client.codRemittanceImportFile.create({
    data: {
      merchantId: input.merchantId,
      fileName: input.fileName,
      mimeType: input.mimeType ?? null,
      fileHash,
      status: "PREVIEWED",
      totalRows: summary.totalRows,
      validRows: summary.validRows,
      invalidRows: summary.invalidRows,
      duplicateAwbRows: summary.duplicateAwbRows,
      metadata: json({ defaultCourierId: input.defaultCourierId ?? null }),
      rows: {
        create: rows.map((row) => ({
          rowNumber: row.rowNumber,
          awb: row.awb,
          orderId: row.orderId,
          externalOrderId: row.externalOrderId,
          valid: row.valid,
          duplicateAwb: row.duplicateAwb,
          errors: row.errors,
          rawData: json(row.rawData),
          normalizedData: row.normalizedData ? json(row.normalizedData) : Prisma.JsonNull
        }))
      }
    },
    include: { rows: true }
  });

  await audit({
    merchantId: input.merchantId,
    action: "COD_REMITTANCE_UPLOAD_PREVIEWED",
    entityType: "CodRemittanceImportFile",
    entityId: file.id,
    metadata: { fileHash, ...summary }
  }, client);

  return { file, summary };
}

function assertPreviewed(status: CourierImportStatus) {
  if (status === "IMPORTED") throw new HttpError(409, "IMPORT_FILE_ALREADY_IMPORTED");
  if (status !== "PREVIEWED") throw new HttpError(409, "IMPORT_FILE_NOT_READY");
}

function invoiceRows(rows: Array<{ valid: boolean; normalizedData: Prisma.JsonValue; rawData: Prisma.JsonValue }>) {
  return rows
    .filter((row) => row.valid && isObject(row.normalizedData))
    .map((row) => {
      const normalized = row.normalizedData as Record<string, unknown>;
      return {
        awb: typeof normalized.awb === "string" ? normalized.awb : undefined,
        orderId: typeof normalized.orderId === "string" ? normalized.orderId : undefined,
        externalOrderId: typeof normalized.externalOrderId === "string" ? normalized.externalOrderId : undefined,
        chargedWeightGrams: typeof normalized.chargedWeightGrams === "number" ? normalized.chargedWeightGrams : undefined,
        billedWeightGrams: typeof normalized.billedWeightGrams === "number" ? normalized.billedWeightGrams : undefined,
        zone: typeof normalized.zone === "string" ? normalized.zone : undefined,
        forwardFreight: Number(normalized.forwardFreight ?? 0),
        rtoFreight: Number(normalized.rtoFreight ?? 0),
        codFee: Number(normalized.codFee ?? 0),
        otherCharges: Number(normalized.otherCharges ?? 0),
        gstAmount: Number(normalized.gstAmount ?? 0),
        totalCharge: Number(normalized.totalCharge ?? 0),
        rawPayload: json(row.rawData)
      };
    });
}

function codRows(rows: Array<{ valid: boolean; normalizedData: Prisma.JsonValue; rawData: Prisma.JsonValue }>) {
  return rows
    .filter((row) => row.valid && isObject(row.normalizedData))
    .map((row) => {
      const normalized = row.normalizedData as Record<string, unknown>;
      return {
        courierId: typeof normalized.courierId === "string" ? normalized.courierId : undefined,
        awb: typeof normalized.awb === "string" ? normalized.awb : undefined,
        orderId: typeof normalized.orderId === "string" ? normalized.orderId : undefined,
        externalOrderId: typeof normalized.externalOrderId === "string" ? normalized.externalOrderId : undefined,
        codAmount: Number(normalized.codAmount ?? 0),
        remittedAmount: Number(normalized.remittedAmount ?? 0),
        remittedAt: typeof normalized.remittedAt === "string" ? new Date(normalized.remittedAt) : normalized.remittedAt instanceof Date ? normalized.remittedAt : undefined,
        utr: typeof normalized.utr === "string" ? normalized.utr : undefined,
        rawPayload: json(row.rawData)
      };
    });
}

export async function commitCourierInvoiceUpload(input: {
  merchantId: string;
  importFileId: string;
  triggerReconciliation?: boolean | undefined;
}, client: typeof prisma = prisma, deps: CommitDeps = {}) {
  const file = await client.courierImportFile.findFirst({
    where: { id: input.importFileId, merchantId: input.merchantId },
    include: { rows: true }
  });
  if (!file) throw new HttpError(404, "IMPORT_FILE_NOT_FOUND");
  assertPreviewed(file.status);

  const metadata = metadataObject(file.metadata);
  const lines = invoiceRows(file.rows);
  const invoice = await (deps.importCourierInvoice ?? importCourierInvoice)({
    merchantId: input.merchantId,
    courierId: file.courierId ?? String(metadata.courierId ?? ""),
    invoiceNumber: typeof metadata.invoiceNumber === "string" ? metadata.invoiceNumber : undefined,
    periodStart: new Date(String(metadata.periodStart)),
    periodEnd: new Date(String(metadata.periodEnd)),
    lines
  }, client);

  const updated = await client.courierImportFile.update({
    where: { id: file.id },
    data: {
      status: "IMPORTED",
      importedInvoiceId: invoice.id,
      importedAt: new Date()
    }
  });

  let reconciliation = null;
  if (input.triggerReconciliation) {
    reconciliation = await (deps.runReconciliation ?? runReconciliation)({ merchantId: input.merchantId }, client);
  }

  await audit({
    merchantId: input.merchantId,
    action: "COURIER_INVOICE_UPLOAD_IMPORTED",
    entityType: "CourierImportFile",
    entityId: updated.id,
    metadata: { invoiceId: invoice.id, validRows: lines.length, reconciliationRunId: reconciliation?.run.id ?? null }
  }, client);

  return { file: updated, invoice, reconciliation };
}

export async function commitCodRemittanceUpload(input: {
  merchantId: string;
  importFileId: string;
  triggerReconciliation?: boolean | undefined;
}, client: typeof prisma = prisma, deps: CommitDeps = {}) {
  const file = await client.codRemittanceImportFile.findFirst({
    where: { id: input.importFileId, merchantId: input.merchantId },
    include: { rows: true }
  });
  if (!file) throw new HttpError(404, "IMPORT_FILE_NOT_FOUND");
  assertPreviewed(file.status);

  const remittances = codRows(file.rows);
  const imported = await (deps.importCodRemittances ?? importCodRemittances)({
    merchantId: input.merchantId,
    remittances
  }, client);

  const updated = await client.codRemittanceImportFile.update({
    where: { id: file.id },
    data: {
      status: "IMPORTED",
      importedRowCount: imported.length,
      importedAt: new Date()
    }
  });

  let reconciliation = null;
  if (input.triggerReconciliation) {
    reconciliation = await (deps.runReconciliation ?? runReconciliation)({ merchantId: input.merchantId }, client);
  }

  await audit({
    merchantId: input.merchantId,
    action: "COD_REMITTANCE_UPLOAD_IMPORTED",
    entityType: "CodRemittanceImportFile",
    entityId: updated.id,
    metadata: { importedRows: imported.length, reconciliationRunId: reconciliation?.run.id ?? null }
  }, client);

  return { file: updated, remittances: imported, reconciliation };
}

export async function listImportFiles(merchantId: string, client: typeof prisma = prisma) {
  const [courierInvoiceFiles, codRemittanceFiles] = await Promise.all([
    client.courierImportFile.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 100
    }),
    client.codRemittanceImportFile.findMany({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 100
    })
  ]);

  return [
    ...courierInvoiceFiles.map((file) => ({ kind: "COURIER_INVOICE" as const, file })),
    ...codRemittanceFiles.map((file) => ({ kind: "COD_REMITTANCE" as const, file }))
  ].sort((left, right) => right.file.createdAt.getTime() - left.file.createdAt.getTime());
}

export async function getImportFile(input: {
  merchantId: string;
  id: string;
}, client: typeof prisma = prisma) {
  const courierFile = await client.courierImportFile.findFirst({
    where: { id: input.id, merchantId: input.merchantId },
    include: { rows: { orderBy: { rowNumber: "asc" } } }
  });
  if (courierFile) return { kind: "COURIER_INVOICE" as const, file: courierFile };

  const codFile = await client.codRemittanceImportFile.findFirst({
    where: { id: input.id, merchantId: input.merchantId },
    include: { rows: { orderBy: { rowNumber: "asc" } } }
  });
  if (codFile) return { kind: "COD_REMITTANCE" as const, file: codFile };

  throw new HttpError(404, "IMPORT_FILE_NOT_FOUND");
}
