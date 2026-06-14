import {
  PlatformImportItemStatus,
  PlatformImportJobStatus,
  type PlatformImportJobMode
} from "@prisma/client";
import type { PlatformImportCounts } from "./platform-import-queue.types.js";

export function countImportItems(items: Array<{ status: string; mappingWarnings?: unknown }>): PlatformImportCounts {
  return {
    totalItems: items.length,
    mappedItems: items.filter((item) => item.status === PlatformImportItemStatus.MAPPED).length,
    importedItems: items.filter((item) => item.status === PlatformImportItemStatus.IMPORTED).length,
    skippedItems: items.filter((item) => item.status === PlatformImportItemStatus.SKIPPED).length,
    duplicateItems: items.filter((item) => item.status === PlatformImportItemStatus.DUPLICATE).length,
    failedItems: items.filter((item) => item.status === PlatformImportItemStatus.FAILED).length,
    warningCount: items.reduce((total, item) => {
      const warnings = Array.isArray(item.mappingWarnings) ? item.mappingWarnings : [];
      return total + warnings.length;
    }, 0)
  };
}

export function finalImportJobStatus(counts: PlatformImportCounts, mode: PlatformImportJobMode) {
  if (mode === "READ_ONLY_FETCH_PLACEHOLDER") return PlatformImportJobStatus.COMPLETED_WITH_WARNINGS;
  if (counts.totalItems > 0 && counts.failedItems === counts.totalItems) return PlatformImportJobStatus.FAILED;
  if (counts.failedItems || counts.duplicateItems || counts.skippedItems || counts.warningCount) {
    return PlatformImportJobStatus.COMPLETED_WITH_WARNINGS;
  }
  return PlatformImportJobStatus.COMPLETED;
}

export function retryBackoffMinutes(attemptCount: number) {
  if (attemptCount <= 1) return 5;
  if (attemptCount === 2) return 15;
  return 60;
}
