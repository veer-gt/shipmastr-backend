import { PlatformImportItemStatus, PlatformImportJobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { generateImportDigestNotification } from "../merchantNotifications/merchant-notification.service.js";
import { defaultWorkerConfig } from "./worker-config.js";
import { runWorkerOnce, workerRunSummary, type WorkerDb } from "./worker-health.service.js";
import type { ShipmastrWorkerConfig, WorkerRunOnceInput } from "./worker.types.js";

export async function runNotificationWorkerOnce(
  merchantId: string,
  input: WorkerRunOnceInput = {},
  client: WorkerDb = prisma,
  options: {
    config?: ShipmastrWorkerConfig;
    generateDigest?: (merchantId: string, client: WorkerDb) => Promise<unknown>;
  } = {}
) {
  const config = options.config ?? defaultWorkerConfig();
  const generateDigest = options.generateDigest ?? generateImportDigestNotification;
  return runWorkerOnce(merchantId, "notifications", input, async ({ dryRun }) => {
    const [failedJobs, failedItems, duplicateItems, retryReady, needsAttentionConversions] = await Promise.all([
      client.platformImportJob.count({ where: { merchantId, status: PlatformImportJobStatus.FAILED } }),
      client.platformImportItem.count({ where: { merchantId, status: PlatformImportItemStatus.FAILED } }),
      client.platformImportItem.count({ where: { merchantId, status: PlatformImportItemStatus.DUPLICATE } }),
      client.platformImportItem.count({ where: { merchantId, nextAttemptAt: { not: null } } }),
      client.platformImportConversion.count({ where: { merchantId, status: "NEEDS_ATTENTION" } })
    ]);
    const eligibleCount = failedJobs + failedItems + duplicateItems + retryReady + needsAttentionConversions;
    if (dryRun) {
      return {
        processedCount: eligibleCount ? 1 : 0,
        warnings: ["Dry-run only. No notification digest was created."],
        summary: workerRunSummary("Notification worker dry-run completed.", {
          eligible_count: eligibleCount,
          dry_run: true
        })
      };
    }
    if (!eligibleCount) {
      return {
        processedCount: 0,
        summary: workerRunSummary("Notification worker found no import issues requiring a digest.", {
          eligible_count: 0,
          dry_run: false
        })
      };
    }
    await generateDigest(merchantId, client);
    return {
      processedCount: 1,
      summary: workerRunSummary("Notification worker generated an in-app digest.", {
        eligible_count: eligibleCount,
        dry_run: false
      })
    };
  }, client, config);
}
