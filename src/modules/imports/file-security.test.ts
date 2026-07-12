import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../lib/httpError.js";
import {
  assertSafeImportFile,
  assertSafeImportRows
} from "./file-security.js";

function errorCode(run: () => unknown) {
  try {
    run();
    return "";
  } catch (error) {
    return error instanceof HttpError ? error.message : String(error);
  }
}

test("CSV uploads require a safe filename, UTF-8 content, and compatible MIME", () => {
  assert.equal(errorCode(() => assertSafeImportFile({ fileName: "../orders.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2") })), "IMPORT_FILE_NAME_INVALID");
  assert.equal(errorCode(() => assertSafeImportFile({ fileName: "orders.csv", mimeType: "image/png", buffer: Buffer.from("a,b\n1,2") })), "IMPORT_CSV_MIME_MISMATCH");
  assert.equal(errorCode(() => assertSafeImportFile({ fileName: "orders.csv", mimeType: "text/csv", buffer: Buffer.from([0xff, 0xfe]) })), "IMPORT_CSV_ENCODING_INVALID");
  assert.equal(assertSafeImportFile({ fileName: "orders.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2") }).suffix, "csv");
});

test("XLSX and PDF uploads require magic bytes", () => {
  assert.equal(errorCode(() => assertSafeImportFile({ fileName: "orders.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("not zip") })), "IMPORT_XLSX_SIGNATURE_INVALID");
  assert.equal(errorCode(() => assertSafeImportFile({ fileName: "orders.pdf", mimeType: "application/pdf", buffer: Buffer.from("not pdf") })), "IMPORT_PDF_SIGNATURE_INVALID");
});

test("spreadsheet formulas and oversized cells are rejected", () => {
  assert.equal(errorCode(() => assertSafeImportRows([{ notes: "=HYPERLINK(\"https://example.test\")" }])), "IMPORT_FORMULA_NOT_ALLOWED");
  assert.equal(errorCode(() => assertSafeImportRows([{ notes: "x".repeat(4001) }])), "IMPORT_CELL_LIMIT_EXCEEDED");
  assert.doesNotThrow(() => assertSafeImportRows([{ amount: "-12", notes: "ordinary text" }]));
});
