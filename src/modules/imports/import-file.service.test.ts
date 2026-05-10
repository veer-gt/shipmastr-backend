import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import { exportReconciliationDisputes } from "../reconciliation/reconciliation.service.js";
import {
  commitCourierInvoiceUpload,
  previewCodRemittanceUpload,
  previewCourierInvoiceUpload
} from "./import-file.service.js";

function csv(content: string) {
  return Buffer.from(content.trim(), "utf8");
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files: Record<string, string>) {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(local, nameBuffer, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function escapeXml(value: unknown) {
  return String(value).replace(/[<>&"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" })[char]!);
}

function cell(column: string, row: number, value: unknown) {
  const ref = `${column}${row}`;
  return typeof value === "number"
    ? `<c r="${ref}"><v>${value}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function xlsx(headers: string[], values: unknown[]) {
  const columns = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1">${headers.map((header, index) => cell(columns[index]!, 1, header)).join("")}</row>
<row r="2">${values.map((value, index) => cell(columns[index]!, 2, value)).join("")}</row>
</sheetData>
</worksheet>`;
  return zipStore({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    "xl/worksheets/sheet1.xml": sheet
  });
}

function makeImportClient() {
  const now = new Date("2026-05-05T00:00:00.000Z");
  const state = {
    courierFiles: [] as any[],
    courierRows: [] as any[],
    codFiles: [] as any[],
    codRows: [] as any[],
    auditLogs: [] as any[],
    disputes: [
      {
        id: "dispute_1",
        type: "COD_SHORTFALL",
        status: "OPEN",
        amount: 300,
        awb: "AWB1",
        orderId: "order_1",
        courierId: "courier_1",
        reason: "COD shortfall",
        createdAt: now
      }
    ]
  };

  function createFile(collection: any[], rowsCollection: any[], data: any, prefix: string) {
    const file = {
      id: `${prefix}_file_${collection.length + 1}`,
      createdAt: now,
      updatedAt: now,
      ...data
    };
    const rows = (data.rows?.create ?? []).map((row: any, index: number) => ({
      id: `${prefix}_row_${rowsCollection.length + index + 1}`,
      importFileId: file.id,
      createdAt: now,
      ...row
    }));
    delete file.rows;
    collection.push(file);
    rowsCollection.push(...rows);
    return { ...file, rows };
  }

  function findFile(collection: any[], rowsCollection: any[], where: any, include?: any) {
    const file = collection.find((item) => Object.entries(where).every(([key, value]) => item[key] === value));
    if (!file) return null;
    return include?.rows ? { ...file, rows: rowsCollection.filter((row) => row.importFileId === file.id) } : file;
  }

  const client = {
    courierImportFile: {
      findFirst: async ({ where, include }: any) => findFile(state.courierFiles, state.courierRows, where, include),
      create: async ({ data }: any) => createFile(state.courierFiles, state.courierRows, data, "courier"),
      update: async ({ where, data }: any) => {
        const file = state.courierFiles.find((item) => item.id === where.id);
        Object.assign(file, data, { updatedAt: now });
        return file;
      },
      findMany: async () => state.courierFiles
    },
    codRemittanceImportFile: {
      findFirst: async ({ where, include }: any) => findFile(state.codFiles, state.codRows, where, include),
      create: async ({ data }: any) => createFile(state.codFiles, state.codRows, data, "cod"),
      update: async ({ where, data }: any) => {
        const file = state.codFiles.find((item) => item.id === where.id);
        Object.assign(file, data, { updatedAt: now });
        return file;
      },
      findMany: async () => state.codFiles
    },
    reconciliationDispute: {
      findMany: async () => state.disputes
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

const invoiceCsv = csv(`
awb,total_charge,forward_freight,cod_fee,gst_amount,charged_weight_grams,zone
AWB1,141.6,100,20,21.6,500,A
`);

describe("courier file imports", () => {
  it("previews CSV courier invoices", async () => {
    const { client } = makeImportClient();
    const preview = await previewCourierInvoiceUpload({
      merchantId: "merchant_1",
      courierId: "courier_1",
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-05"),
      fileName: "invoice.csv",
      mimeType: "text/csv",
      buffer: invoiceCsv
    }, client);

    assert.equal(preview.summary.totalRows, 1);
    assert.equal(preview.summary.validRows, 1);
    assert.equal(preview.file.rows[0]?.awb, "AWB1");
  });

  it("previews XLSX courier invoices", async () => {
    const { client } = makeImportClient();
    const preview = await previewCourierInvoiceUpload({
      merchantId: "merchant_1",
      courierId: "courier_1",
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-05"),
      fileName: "invoice.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: xlsx(["awb", "total_charge", "forward_freight", "cod_fee", "gst_amount"], ["AWB1", 141.6, 100, 20, 21.6])
    }, client);

    assert.equal(preview.summary.validRows, 1);
    assert.equal(preview.file.rows[0]?.awb, "AWB1");
  });

  it("previews CSV COD remittances", async () => {
    const { client } = makeImportClient();
    const preview = await previewCodRemittanceUpload({
      merchantId: "merchant_1",
      defaultCourierId: "courier_1",
      fileName: "cod.csv",
      mimeType: "text/csv",
      buffer: csv(`
awb,cod_amount,remitted_amount,remitted_at,utr
AWB1,1000,1000,2026-05-03,UTR1
`)
    }, client);

    assert.equal(preview.summary.totalRows, 1);
    assert.equal(preview.summary.validRows, 1);
    assert.equal(preview.file.rows[0]?.awb, "AWB1");
  });

  it("blocks duplicate file hashes", async () => {
    const { client } = makeImportClient();
    const input = {
      merchantId: "merchant_1",
      courierId: "courier_1",
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-05"),
      fileName: "invoice.csv",
      mimeType: "text/csv",
      buffer: invoiceCsv
    };

    await previewCourierInvoiceUpload(input, client);
    await assert.rejects(
      () => previewCourierInvoiceUpload(input, client),
      (err: unknown) => err instanceof HttpError && err.status === 409 && err.message === "DUPLICATE_IMPORT_FILE"
    );
  });

  it("flags duplicate AWBs inside an import file", async () => {
    const { client } = makeImportClient();
    const preview = await previewCourierInvoiceUpload({
      merchantId: "merchant_1",
      courierId: "courier_1",
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-05"),
      fileName: "invoice.csv",
      mimeType: "text/csv",
      buffer: csv(`
awb,total_charge
AWB1,100
AWB1,100
`)
    }, client);

    assert.equal(preview.summary.duplicateAwbRows, 2);
    assert.equal(preview.file.rows[0]?.duplicateAwb, true);
  });

  it("returns invalid row numbers with reasons", async () => {
    const { client } = makeImportClient();
    const preview = await previewCourierInvoiceUpload({
      merchantId: "merchant_1",
      courierId: "courier_1",
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-05"),
      fileName: "invoice.csv",
      mimeType: "text/csv",
      buffer: csv(`
awb,total_charge
AWB1,not-a-number
`)
    }, client);

    assert.equal(preview.summary.invalidRows, 1);
    assert.equal(preview.summary.invalid[0]?.rowNumber, 2);
    assert.ok(preview.summary.invalid[0]?.errors.length);
  });

  it("commits valid preview rows into invoice ledger rows", async () => {
    const { client } = makeImportClient();
    const preview = await previewCourierInvoiceUpload({
      merchantId: "merchant_1",
      courierId: "courier_1",
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-05"),
      fileName: "invoice.csv",
      mimeType: "text/csv",
      buffer: invoiceCsv
    }, client);
    let committedLines = 0;

    const result = await commitCourierInvoiceUpload({
      merchantId: "merchant_1",
      importFileId: preview.file.id
    }, client, {
      importCourierInvoice: async (input: any) => {
        committedLines = input.lines.length;
        return { id: "invoice_1" } as any;
      }
    });

    assert.equal(committedLines, 1);
    assert.equal(result.file.status, "IMPORTED");
    assert.equal(result.file.importedInvoiceId, "invoice_1");
  });

  it("runs reconciliation after commit when requested", async () => {
    const { client } = makeImportClient();
    const preview = await previewCourierInvoiceUpload({
      merchantId: "merchant_1",
      courierId: "courier_1",
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-05"),
      fileName: "invoice.csv",
      mimeType: "text/csv",
      buffer: invoiceCsv
    }, client);
    let ran = false;

    const result = await commitCourierInvoiceUpload({
      merchantId: "merchant_1",
      importFileId: preview.file.id,
      triggerReconciliation: true
    }, client, {
      importCourierInvoice: async () => ({ id: "invoice_1" }) as any,
      runReconciliation: async () => {
        ran = true;
        return { run: { id: "run_1" }, summary: {} } as any;
      }
    });

    assert.equal(ran, true);
    assert.equal(result.reconciliation?.run.id, "run_1");
  });

  it("exports disputes in courier-ready CSV and JSON", async () => {
    const { client } = makeImportClient();
    const csvExport = await exportReconciliationDisputes({ merchantId: "merchant_1", format: "csv" }, client);
    const jsonExport = await exportReconciliationDisputes({ merchantId: "merchant_1", format: "json" }, client);

    assert.equal(csvExport.contentType, "text/csv");
    assert.ok(csvExport.body.includes("disputeId,type,status"));
    assert.ok(csvExport.body.includes("COD_SHORTFALL"));
    assert.equal(jsonExport.contentType, "application/json");
    assert.ok(jsonExport.body.includes("dispute_1"));
  });
});
