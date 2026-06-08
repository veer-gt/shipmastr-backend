import { PlatformImportItemStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { recordImportItemNotifications } from "../merchantNotifications/merchant-notification.service.js";
import { defaultWorkerConfig } from "./worker-config.js";
import { runWorkerOnce, workerRunSummary, type WorkerDb } from "./worker-health.service.js";
import type { ShipmastrWorkerConfig, WorkerRunOnceInput } from "./worker.types.js";

export async function runRetryWorkerOnce(
  merchantId: string,
  input: WorkerRunOnceInput = {},
  client: WorkerDb = prisma,
  options: {
    config?: ShipmastrWorkerConfig;
    notifyRetryReady?: (item: unknown, client: WorkerDb) => Promise<unknown>;
  } = {}
) {
  const config = options.config ?? defaultWorkerConfig();
  const notifyRetryReady = options.notifyRetryReady ?? recordImportItemNotifications;
  return runWorkerOnce(merchantId, "retries", input, async ({ dryRun, maxBatch }) => {
    const now = new Date();
    const items = await client.platformImportItem.findMany({
      where: {
        merchantId,
        status: PlatformImportItemStatus.FAILED,
        nextAttemptAt: { lte: now }
      },
      orderBy: { nextAttemptAt: "asc" },
      take: maxBatch
    });
    if (dryRun) {
      return {
        processedCount: items.length,
        warnings: ["Dry-run only. Retry-ready notifications were not generated."],
        summary: workerRunSummary("Retry worker dry-run completed.", {
          eligible_count: items.length,
          processed_ids: items.map((item) => item.id),
          dry_run: true
        })
      };
    }
    let failedCount = 0;
    const errors: string[] = [];
    for (const item of items) {
      try {
        await notifyRetryReady(item, client);
      } catch {
        failedCount += 1;
        errors.push("RETRY_READY_NOTIFICATION_FAILED");
      }
    }
    return {
      processedCount: items.length,
      failedCount,
      errors,
      summary: workerRunSummary("Retry worker surfaced retry-ready import items.", {
        eligible_count: items.length,
        processed_ids: items.map((item) => item.id),
        dry_run: false
      })
    };
  }, client, config);
}
