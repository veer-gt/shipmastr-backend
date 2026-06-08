import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { defaultWorkerConfig, effectiveMaxBatch, workerEnabled, workerSpecificEnabled } from "./worker-config.js";
import { SHIPMASTR_WORKERS } from "./worker-registry.js";
import type {
  ShipmastrWorkerConfig,
  ShipmastrWorkerMode,
  ShipmastrWorkerName,
  ShipmastrWorkerStatus,
  WorkerProcessorResult,
  WorkerRunOnceInput,
  WorkerRunSummary
} from "./worker.types.js";

export type WorkerDb = Prisma.TransactionClient | typeof prisma;

type WorkerRunRecord = {
  id: string;
  workerName: string;
  merchantId?: string | null;
  status: string;
  mode: string;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  processedCount?: number | null;
  failedCount?: number | null;
  warnings?: unknown;
  errors?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|consumer|hash|provider|courier/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|bigship/i;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function sanitizeWorkerValue(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeWorkerValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      output[key] = sanitizeWorkerValue(child);
    }
    return output;
  }
  if (typeof value === "string" && unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(sanitizeWorkerValue(value ?? null))) as Prisma.InputJsonValue;
}

function safeSummary(input: Partial<WorkerRunSummary> & { message: string }): WorkerRunSummary {
  return {
    message: input.message,
    ...(input.eligible_count !== undefined ? { eligible_count: input.eligible_count } : {}),
    ...(input.processed_ids ? { processed_ids: input.processed_ids } : {}),
    ...(input.dry_run !== undefined ? { dry_run: input.dry_run } : {}),
    ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    external_calls_made: false,
    platform_writes: false,
    courier_calls: false,
    rates_fetched: false,
    awb_created: false,
    labels_created: false,
    email_sent: false,
    scheduler_started: false
  };
}

export function serializeWorkerRun(record: WorkerRunRecord) {
  return {
    run_id: record.id,
    worker_name: record.workerName,
    merchant_id: record.merchantId ?? null,
    status: record.status,
    mode: record.mode,
    started_at: timestamp(record.startedAt),
    finished_at: timestamp(record.finishedAt),
    processed_count: record.processedCount ?? 0,
    failed_count: record.failedCount ?? 0,
    warnings: sanitizeWorkerValue(record.warnings) ?? [],
    errors: sanitizeWorkerValue(record.errors) ?? [],
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function workerRunSummary(message: string, extra: Partial<WorkerRunSummary> = {}) {
  return safeSummary({ ...extra, message });
}

export async function runWorkerOnce(
  merchantId: string,
  workerName: ShipmastrWorkerName,
  input: WorkerRunOnceInput,
  processor: (context: {
    merchantId: string;
    client: WorkerDb;
    dryRun: boolean;
    maxBatch: number;
    config: ShipmastrWorkerConfig;
  }) => Promise<WorkerProcessorResult>,
  client: WorkerDb = prisma,
  config: ShipmastrWorkerConfig = defaultWorkerConfig()
) {
  const maxBatch = effectiveMaxBatch(config, input.max_batch);
  const dryRun = input.dry_run ?? config.dryRun;
  const enabled = workerEnabled(config, workerName);
  const mode: ShipmastrWorkerMode = !enabled ? "DISABLED" : dryRun ? "DRY_RUN" : "ACTIVE";
  const now = new Date();
  const lockSince = new Date(now.getTime() - config.lockSeconds * 1000);
  const active = await client.shipmastrWorkerRun.findFirst({
    where: {
      workerName,
      status: "RUNNING",
      startedAt: { gte: lockSince }
    }
  });
  if (active) throw new HttpError(409, "SHIPMASTR_WORKER_LOCKED");

  const run = await client.shipmastrWorkerRun.create({
    data: {
      workerName,
      merchantId,
      status: "RUNNING",
      mode,
      processedCount: 0,
      failedCount: 0,
      warnings: toJson([]),
      errors: toJson([])
    }
  });

  if (!enabled) {
    const skipped = await client.shipmastrWorkerRun.update({
      where: { id: run.id },
      data: {
        status: "SKIPPED",
        finishedAt: new Date(),
        warnings: toJson(["Worker is disabled by configuration."]),
        errors: toJson([]),
        processedCount: 0,
        failedCount: 0
      }
    });
    return {
      run: serializeWorkerRun(skipped),
      summary: workerRunSummary("Worker run skipped because this worker is disabled.", {
        disabled: true,
        dry_run: true,
        eligible_count: 0
      })
    };
  }

  try {
    const result = await processor({ merchantId, client, dryRun, maxBatch, config });
    const status: ShipmastrWorkerStatus = result.failedCount ? "FAILED" : "COMPLETED";
    const updated = await client.shipmastrWorkerRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        processedCount: result.processedCount,
        failedCount: result.failedCount ?? 0,
        warnings: toJson(result.warnings ?? []),
        errors: toJson(result.errors ?? [])
      }
    });
    return {
      run: serializeWorkerRun(updated),
      summary: result.summary
    };
  } catch (error) {
    const updated = await client.shipmastrWorkerRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        processedCount: 0,
        failedCount: 1,
        warnings: toJson([]),
        errors: toJson([error instanceof HttpError ? error.message : "WORKER_RUN_FAILED"])
      }
    });
    return {
      run: serializeWorkerRun(updated),
      summary: workerRunSummary("Worker run failed safely.", {
        eligible_count: 0,
        dry_run: dryRun
      })
    };
  }
}

export async function getWorkerHealth(
  merchantId: string,
  config: ShipmastrWorkerConfig = defaultWorkerConfig(),
  client: WorkerDb = prisma
) {
  const latestRuns = await client.shipmastrWorkerRun.findMany({
    where: { merchantId },
    orderBy: { startedAt: "desc" },
    take: 12
  });
  return {
    enabled: config.workersEnabled,
    dry_run: config.dryRun,
    max_batch: config.maxBatch,
    lock_seconds: config.lockSeconds,
    scheduler_started: false,
    production_loop_started: false,
    workers: SHIPMASTR_WORKERS.map((worker) => ({
      worker_name: worker.name,
      label: worker.label,
      description: worker.description,
      enabled: config.workersEnabled && workerSpecificEnabled(config, worker.name),
      dry_run: config.dryRun
    })),
    latest_runs: latestRuns.map(serializeWorkerRun)
  };
}

export async function listWorkerRuns(
  merchantId: string,
  query: { page: number; per_page: number; worker_name?: string | undefined; status?: string | undefined },
  client: WorkerDb = prisma
) {
  const where: Prisma.ShipmastrWorkerRunWhereInput = {
    merchantId,
    ...(query.worker_name ? { workerName: query.worker_name } : {}),
    ...(query.status ? { status: query.status } : {})
  };
  const [runs, total] = await Promise.all([
    client.shipmastrWorkerRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.shipmastrWorkerRun.count({ where })
  ]);
  return {
    runs: runs.map(serializeWorkerRun),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getWorkerRun(merchantId: string, runId: string, client: WorkerDb = prisma) {
  const run = await client.shipmastrWorkerRun.findFirst({
    where: { id: runId, merchantId }
  });
  if (!run) throw new HttpError(404, "SHIPMASTR_WORKER_RUN_NOT_FOUND");
  return serializeWorkerRun(run);
}
