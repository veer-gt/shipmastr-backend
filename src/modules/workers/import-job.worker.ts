import { PlatformImportJobStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  runNextPlatformImportCursorPage,
  runPlatformImportJobFoundation
} from "../platformIntegrations/importQueue/platform-import-queue.service.js";
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
    runCursorNextPage?: (merchantId: string, cursorId: string, client: WorkerDb) => Promise<unknown>;
  } = {}
) {
  const config = options.config ?? defaultWorkerConfig();
  const runJob = options.runJob ?? runPlatformImportJobFoundation;
  const runCursorNextPage = options.runCursorNextPage ?? ((scope, cursorId, workerClient) => (
    runNextPlatformImportCursorPage(scope, cursorId, {}, workerClient)
  ));
  return runWorkerOnce(merchantId, "import-jobs", input, async ({ dryRun, maxBatch }) => {
    const jobs = await client.platformImportJob.findMany({
      where: { merchantId, status: PlatformImportJobStatus.QUEUED },
      orderBy: { createdAt: "asc" },
      take: maxBatch
    });
    const remainingBatch = Math.max(0, maxBatch - jobs.length);
    const cursors = remainingBatch > 0
      ? await client.platformImportCursor.findMany({
          where: { merchantId, hasMore: true },
          orderBy: { updatedAt: "asc" },
          take: remainingBatch
        })
      : [];
    if (dryRun) {
      return {
        processedCount: jobs.length + cursors.length,
        warnings: ["Dry-run only. No import job or cursor page was executed."],
        summary: workerRunSummary("Import worker dry-run completed.", {
          eligible_count: jobs.length + cursors.length,
          processed_ids: [...jobs.map((job) => job.id), ...cursors.map((cursor) => cursor.id)],
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
    for (const cursor of cursors) {
      try {
        await runCursorNextPage(merchantId, cursor.id, client);
      } catch {
        failedCount += 1;
        errors.push("IMPORT_CURSOR_NEXT_PAGE_FAILED");
      }
    }
    return {
      processedCount: jobs.length + cursors.length,
      failedCount,
      errors,
      summary: workerRunSummary("Import worker run-once completed.", {
        eligible_count: jobs.length + cursors.length,
        processed_ids: [...jobs.map((job) => job.id), ...cursors.map((cursor) => cursor.id)],
        dry_run: false
      })
    };
  }, client, config);
}
