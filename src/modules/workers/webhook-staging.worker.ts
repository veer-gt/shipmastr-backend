import { prisma } from "../../lib/prisma.js";
import { stagePlatformWebhookEventImport } from "../platformIntegrations/webhookIngestion/platform-webhook.service.js";
import { defaultWorkerConfig } from "./worker-config.js";
import { runWorkerOnce, workerRunSummary, type WorkerDb } from "./worker-health.service.js";
import type { ShipmastrWorkerConfig, WorkerRunOnceInput } from "./worker.types.js";

export async function runWebhookStagingWorkerOnce(
  merchantId: string,
  input: WorkerRunOnceInput = {},
  client: WorkerDb = prisma,
  options: {
    config?: ShipmastrWorkerConfig;
    stageEvent?: (merchantId: string, eventId: string, client: WorkerDb) => Promise<unknown>;
  } = {}
) {
  const config = options.config ?? defaultWorkerConfig();
  const stageEvent = options.stageEvent ?? stagePlatformWebhookEventImport;
  return runWorkerOnce(merchantId, "webhook-staging", input, async ({ dryRun, maxBatch }) => {
    const events = await client.platformWebhookEvent.findMany({
      where: {
        merchantId,
        status: "VERIFIED",
        importJobId: null
      },
      orderBy: { receivedAt: "asc" },
      take: maxBatch
    });
    if (dryRun) {
      return {
        processedCount: events.length,
        warnings: ["Dry-run only. No webhook event was staged."],
        summary: workerRunSummary("Webhook staging worker dry-run completed.", {
          eligible_count: events.length,
          processed_ids: events.map((event) => event.id),
          dry_run: true
        })
      };
    }
    let failedCount = 0;
    const errors: string[] = [];
    for (const event of events) {
      try {
        await stageEvent(merchantId, event.id, client);
      } catch {
        failedCount += 1;
        errors.push("WEBHOOK_EVENT_STAGE_FAILED");
      }
    }
    return {
      processedCount: events.length,
      failedCount,
      errors,
      summary: workerRunSummary("Webhook staging worker run-once completed.", {
        eligible_count: events.length,
        processed_ids: events.map((event) => event.id),
        dry_run: false
      })
    };
  }, client, config);
}
