import type { PlatformImportItemStatus } from "@prisma/client";

export type PlatformImportCounts = {
  totalItems: number;
  mappedItems: number;
  importedItems: number;
  skippedItems: number;
  duplicateItems: number;
  failedItems: number;
  warningCount: number;
};

export type PlatformImportItemResult = {
  status: PlatformImportItemStatus;
  externalOrderId?: string | null;
  externalOrderName?: string | null;
  mappingWarnings?: unknown;
  safePayloadPreview?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
};
