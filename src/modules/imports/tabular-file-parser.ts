import { parse } from "csv-parse/sync";
import { readSheet } from "read-excel-file/node";
import type { FileParserInput, ImportFileParser, ParsedImportRow } from "./file-parser.types.js";
import { PdfImportParser } from "./pdf-parser.adapter.js";

function normalizedKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [normalizedKey(key), value])
  );
}

export class CsvImportParser implements ImportFileParser {
  supports(input: Pick<FileParserInput, "fileName" | "mimeType">) {
    const name = input.fileName.toLowerCase();
    return name.endsWith(".csv") || input.mimeType === "text/csv" || input.mimeType === "application/csv";
  }

  parse(input: FileParserInput): ParsedImportRow[] {
    const records = parse(input.buffer, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true
    }) as Record<string, unknown>[];

    return records.map((record, index) => ({
      rowNumber: index + 2,
      data: normalizeRow(record)
    }));
  }
}

export class XlsxImportParser implements ImportFileParser {
  supports(input: Pick<FileParserInput, "fileName" | "mimeType">) {
    const name = input.fileName.toLowerCase();
    return name.endsWith(".xlsx")
      || input.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  async parse(input: FileParserInput): Promise<ParsedImportRow[]> {
    const rows = await readSheet(input.buffer);
    const [headers, ...dataRows] = rows;
    if (!headers) return [];
    const normalizedHeaders = headers.map((header) => String(header ?? ""));
    const records = dataRows.map((values) => Object.fromEntries(
      normalizedHeaders.map((header, index) => [header, values[index] ?? ""])
    ));

    return records.map((record, index) => ({
      rowNumber: index + 2,
      data: normalizeRow(record)
    }));
  }
}

const parsers: ImportFileParser[] = [
  new CsvImportParser(),
  new XlsxImportParser(),
  new PdfImportParser()
];

export async function parseImportFile(input: FileParserInput) {
  const parser = parsers.find((candidate) => candidate.supports(input));
  if (!parser) throw new Error("UNSUPPORTED_IMPORT_FILE");
  return parser.parse(input);
}
