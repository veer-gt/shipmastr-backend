import { prisma } from "../../lib/prisma.js";
import type { FormatPackClient } from "./types.js";

type ImportFileRecord = {
  id: string;
  fileHash: string;
  source: string;
  counterparty: string | null;
  brandOrgId: string | null;
  period: string | null;
  storagePath: string;
  formatPackId: string | null;
  formatPackVersionId: string | null;
  statedTotalMinor: bigint | null;
  status: string;
};

type ImportFileClient = FormatPackClient & {
  importFile: {
    create(input: { data: Record<string, unknown> }): Promise<ImportFileRecord>;
    findUnique(input: { where: { fileHash?: string; id?: string } }): Promise<ImportFileRecord | null>;
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<ImportFileRecord>;
  };
};

type LandFileInput = {
  fileHash: string;
  source: string;
  counterparty?: string | null | undefined;
  brandOrgId?: string | null | undefined;
  period?: string | null | undefined;
  storagePath: string;
  statedTotalMinor?: string | bigint | null | undefined;
  formatPackId?: string | null | undefined;
  formatPackVersionId?: string | null | undefined;
};

const defaultClient = prisma as unknown as ImportFileClient;

function cleanRequired(value: unknown, code: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(code);
  return text;
}

function cleanOptional(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function optionalBigInt(value: string | bigint | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "bigint" ? value : BigInt(value);
}

export class ImportFileService {
  constructor(private readonly client: ImportFileClient = defaultClient) {}

  async landFile(input: LandFileInput) {
    const fileHash = cleanRequired(input.fileHash, "IMPORT_FILE_HASH_REQUIRED");
    const existing = await this.client.importFile.findUnique({ where: { fileHash } });
    if (existing) return existing;

    return this.client.importFile.create({
      data: {
        fileHash,
        source: cleanRequired(input.source, "IMPORT_FILE_SOURCE_REQUIRED"),
        counterparty: cleanOptional(input.counterparty),
        brandOrgId: cleanOptional(input.brandOrgId),
        period: cleanOptional(input.period),
        storagePath: cleanRequired(input.storagePath, "IMPORT_FILE_STORAGE_PATH_REQUIRED"),
        statedTotalMinor: optionalBigInt(input.statedTotalMinor),
        formatPackId: cleanOptional(input.formatPackId),
        formatPackVersionId: cleanOptional(input.formatPackVersionId),
        status: "landed"
      }
    });
  }

  markParsed(id: string) {
    return this.markFileStatus(id, "parsed");
  }

  markValidated(id: string) {
    return this.markFileStatus(id, "validated");
  }

  markStaged(id: string) {
    return this.markFileStatus(id, "staged");
  }

  markException(id: string) {
    return this.markFileStatus(id, "exception");
  }

  markFileStatus(id: string, status: "parsed" | "validated" | "staged" | "exception") {
    return this.client.importFile.update({
      where: { id },
      data: { status }
    });
  }
}

export const importFileService = new ImportFileService();
