import type { FileParserInput, ImportFileParser, ParsedImportRow } from "./file-parser.types.js";
import { UnsupportedImportFileError } from "./file-parser.types.js";

export class PdfImportParser implements ImportFileParser {
  supports(input: Pick<FileParserInput, "fileName" | "mimeType">) {
    return input.mimeType === "application/pdf" || input.fileName.toLowerCase().endsWith(".pdf");
  }

  parse(_input: FileParserInput): ParsedImportRow[] {
    throw new UnsupportedImportFileError("PDF_IMPORT_NOT_SUPPORTED_YET");
  }
}
