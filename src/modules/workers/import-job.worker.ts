import { PlatformImportJobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { runPlatformImportJobFoundation } from "../platformIntegrations/importQueue/platform-import-queue.service.js";
import { runWorkerOnce, workerRunSummary, type WorkerDb } from "./worker-health.service.js";
import { defaultWorkerConfig } from "./worker-config.js";
import type { ShipmastrWorkerConfig, WorkerRunOnceInput } from "./worker.types.js";

export async function runImportJobWorkerOnce(
  merchantId: string,
  input: WorkerRunOnceInput = {},
  client: WorkerDb = prisma,
  options: {
    config?: ShipmastrWorkerConfig;
    runJob?: (merchantId: string, jobId: string, client: WorkerDb) => Promise<unknown>;
  } = {}
) {
  const config = options.config ?? defaultWorkerConfig();
  const runJob = options.runJob ?? runPlatformImportJobFoundation;
  return runWorkerOnce(merchantId, "import-jobs", input, async ({ dryRun, maxBatch }) => {
    const jobs = await client.platformImportJob.findMany({
      where: { merchantId, status: PlatformImportJobStatus.QUEUED },
      orderBy: { createdAt: "asc" },
      take: maxBatch
    });
    if (dryRun) {
      return {
        processedCount: jobs.length,
        warnings: ["Dry-run only. No import job was executed."],
        summary: workerRunSummary("Import worker dry-run completed.", {
          eligible_count: jobs.length,
          processed_ids: jobs.map((job) => job.id),
          dry_run: true
        })
      };
    }
    let failedCount = 0;
    const errors: string[] = [];
    for (const job of jobs) {
      try {
        await runJob(merchantId, job.id, client);
      } catch {
        failedCount += 1;
        errors.push("IMPORT_JOB_RUN_FAILED");
      }
    }
    return {
      processedCount: jobs.length,
      failedCount,
      errors,
      summary: workerRunSummary("Import worker run-once completed.", {
        eligible_count: jobs.length,
        processed_ids: jobs.map((job) => job.id),
        dry_run: false
      })
    };
  }, client, config);
}
