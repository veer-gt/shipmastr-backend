import { HttpError } from "../../lib/httpError.js";

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
export const MAX_IMPORT_COLUMNS = 100;
export const MAX_IMPORT_CELL_CHARS = 4_000;

const CSV_MIME_TYPES = new Set(["", "text/csv", "text/plain", "application/csv"]);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function extension(fileName: string) {
  const match = /^.+\.([a-z0-9]+)$/i.exec(fileName);
  return match?.[1]?.toLowerCase() || "";
}

export function assertSafeImportFile(input: { fileName: string; mimeType?: string | undefined; buffer: Buffer }) {
  const fileName = String(input.fileName ?? "").trim();
  const mimeType = String(input.mimeType ?? "").trim().toLowerCase();
  const suffix = extension(fileName);
  if (!fileName || fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(fileName)) {
    throw new HttpError(400, "IMPORT_FILE_NAME_INVALID");
  }
  if (input.buffer.length <= 0 || input.buffer.length > MAX_IMPORT_FILE_BYTES) {
    throw new HttpError(413, "IMPORT_FILE_TOO_LARGE");
  }

  if (suffix === "csv") {
    if (!CSV_MIME_TYPES.has(mimeType)) throw new HttpError(400, "IMPORT_CSV_MIME_MISMATCH");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.buffer);
    } catch {
      throw new HttpError(400, "IMPORT_CSV_ENCODING_INVALID");
    }
    if (text.includes("\u0000")) throw new HttpError(400, "IMPORT_CSV_BINARY_CONTENT");
    if (text.split(/\r?\n/).length > MAX_IMPORT_ROWS + 1) throw new HttpError(400, "IMPORT_ROW_LIMIT_EXCEEDED");
    return { suffix, mimeType, text };
  }

  if (suffix === "xlsx") {
    if (mimeType !== XLSX_MIME) throw new HttpError(400, "IMPORT_XLSX_MIME_MISMATCH");
    if (input.buffer.length < 4 || input.buffer[0] !== 0x50 || input.buffer[1] !== 0x4b || input.buffer[2] !== 0x03 || input.buffer[3] !== 0x04) {
      throw new HttpError(400, "IMPORT_XLSX_SIGNATURE_INVALID");
    }
    return { suffix, mimeType, text: undefined };
  }

  if (suffix === "pdf") {
    if (mimeType && mimeType !== "application/pdf") throw new HttpError(400, "IMPORT_PDF_MIME_MISMATCH");
    if (input.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new HttpError(400, "IMPORT_PDF_SIGNATURE_INVALID");
    return { suffix, mimeType, text: undefined };
  }

  throw new HttpError(400, "UNSUPPORTED_IMPORT_FILE");
}

export function assertSafeImportCell(value: unknown) {
  if (typeof value !== "string") return;
  if (value.length > MAX_IMPORT_CELL_CHARS) throw new HttpError(400, "IMPORT_CELL_LIMIT_EXCEEDED");
  // Keep ordinary signed numeric values (for example +919876543210) valid,
  // while rejecting spreadsheet formula prefixes and command-like cells.
  if (/^=/.test(value) || /^\+(?!\d)/.test(value) || /^@/.test(value) || /^-(?!\d|\s*$)/.test(value)) {
    throw new HttpError(400, "IMPORT_FORMULA_NOT_ALLOWED");
  }
}

export function assertSafeImportRows(rows: Array<Record<string, unknown>>) {
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, "IMPORT_ROW_LIMIT_EXCEEDED");
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length > MAX_IMPORT_COLUMNS) throw new HttpError(400, "IMPORT_COLUMN_LIMIT_EXCEEDED");
    for (const value of Object.values(row)) assertSafeImportCell(value);
  }
}
