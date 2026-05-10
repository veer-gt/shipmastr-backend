export type ParsedImportRow = {
  rowNumber: number;
  data: Record<string, unknown>;
};

export type FileParserInput = {
  fileName: string;
  mimeType?: string | undefined;
  buffer: Buffer;
};

export interface ImportFileParser {
  supports(input: Pick<FileParserInput, "fileName" | "mimeType">): boolean;
  parse(input: FileParserInput): Promise<ParsedImportRow[]> | ParsedImportRow[];
}

export class UnsupportedImportFileError extends Error {
  constructor(message = "UNSUPPORTED_IMPORT_FILE") {
    super(message);
  }
}
