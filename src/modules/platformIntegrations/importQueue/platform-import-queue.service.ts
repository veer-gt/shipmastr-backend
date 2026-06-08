import {
  PlatformConnectionStatus,
  PlatformHealthCheckStatus,
  PlatformImportItemStatus,
  PlatformImportJobMode,
  PlatformImportJobStatus,
  PlatformImportSource,
  PlatformOrderImportStatus,
  StorePlatform,
  type Prisma,
  type PlatformConnection,
  type PlatformImportJob
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { buildRawPayloadPreview } from "../platform-integrations.serializers.js";
import { mapPlatformOrder } from "../platform-integrations.service.js";
import { getPlatformAdapter } from "../platform-registry.js";
import type { NormalizedPlatformOrder } from "../platform-types.js";
import {
  fetchPlatformOrdersReadOnly,
  type PlatformReadOrderFetchOptions
} from "../readOnlyFetch/platform-order-fetch.service.js";
import type { ReadableStorePlatform } from "../readOnlyFetch/platform-order-fetch.types.js";
import { hasImportedExternalOrder, platformPayloadHash } from "./platform-import-deduplication.service.js";
import { countImportItems, finalImportJobStatus, retryBackoffMinutes } from "./platform-import-orchestrator.service.js";
import {
  sanitizeImportPreview,
  serializePlatformImportItem,
  serializePlatformImportJob,
  serializePlatformImportJobWithItems
} from "./platform-import-queue.serializers.js";
import type {
  CreatePlatformImportJobInput,
  ListPlatformImportJobsQueryInput
} from "./platform-import-queue.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;
type ReadFetchQueueOptions = Omit<PlatformReadOrderFetchOptions, "client">;

const terminalJobStatuses = new Set<string>([
  PlatformImportJobStatus.COMPLETED,
  PlatformImportJobStatus.COMPLETED_WITH_WARNINGS,
  PlatformImportJobStatus.FAILED,
  PlatformImportJobStatus.CANCELLED
]);

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(sanitizeImportPreview(value))) as Prisma.InputJsonValue;
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  return connection;
}

async function findJob(merchantId: string, jobId: string, client: Db) {
  const job = await client.platformImportJob.findFirst({
    where: { id: jobId, merchantId }
  });
  if (!job) throw new HttpError(404, "PLATFORM_IMPORT_JOB_NOT_FOUND");
  return job;
}

async function findItem(merchantId: string, itemId: string, client: Db) {
  const item = await client.platformImportItem.findFirst({
    where: { id: itemId, merchantId }
  });
  if (!item) throw new HttpError(404, "PLATFORM_IMPORT_ITEM_NOT_FOUND");
  return item;
}

function assertConnectionUsable(connection: PlatformConnection) {
  if (connection.status === PlatformConnectionStatus.DISABLED || connection.status === PlatformConnectionStatus.ERROR) {
    throw new HttpError(409, "PLATFORM_IMPORT_CONNECTION_NOT_READY");
  }
}

function assertModeSupported(connection: PlatformConnection, mode: PlatformImportJobMode) {
  if (mode === PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER) return;
  if (!getPlatformAdapter(connection.platform)) {
    throw new HttpError(400, "PLATFORM_IMPORT_UNSUPPORTED_PLATFORM");
  }
}

async function assertHealthAllowsImportFoundation(merchantId: string, connectionId: string, client: Db) {
  const latest = await client.platformConnectionHealthCheck.findFirst({
    where: { merchantId, connectionId },
    orderBy: { checkedAt: "desc" }
  });
  if (latest?.status === PlatformHealthCheckStatus.FAILED) {
    throw new HttpError(409, "PLATFORM_IMPORT_HEALTH_CHECK_FAILED");
  }
}

function safeSummary(message: string, extra: Record<string, unknown> = {}) {
  return {
    message,
    ...extra,
    external_calls_made: false,
    store_mutation: false,
    fulfillment_sync: false,
    tracking_sync: false
  };
}

function safeReadOptions(input: CreatePlatformImportJobInput["readOptions"] | undefined) {
  return {
    since: input?.since ?? null,
    limit: input?.limit ?? null,
    cursor: input?.cursor ?? null
  };
}

function readOptionsFromJob(job: PlatformImportJob) {
  const summary = job.safeSummary && typeof job.safeSummary === "object"
    ? job.safeSummary as Record<string, unknown>
    : {};
  const options = summary.read_options && typeof summary.read_options === "object"
    ? summary.read_options as Record<string, unknown>
    : {};
  const since = typeof options.since === "string" && options.since ? new Date(options.since) : null;
  const limit = typeof options.limit === "number" ? options.limit : null;
  const cursor = typeof options.cursor === "string" ? options.cursor : null;
  return {
    since: since && !Number.isNaN(since.getTime()) ? since : null,
    limit,
    cursor
  };
}

function finalReadFetchStatus(counts: ReturnType<typeof countImportItems>, warnings: string[]) {
  if (counts.totalItems > 0 && counts.failedItems === counts.totalItems) return PlatformImportJobStatus.FAILED;
  if (counts.failedItems || counts.duplicateItems || counts.warningCount || warnings.length) {
    return PlatformImportJobStatus.COMPLETED_WITH_WARNINGS;
  }
  return PlatformImportJobStatus.COMPLETED;
}

function createItemPreview(normalized: NormalizedPlatformOrder) {
  return {
    ...buildRawPayloadPreview(normalized),
    mapping_warnings: normalized.mappingWarnings
  };
}

async function refreshJobCounts(job: PlatformImportJob, client: Db, finalStatus?: PlatformImportJobStatus) {
  const items = await client.platformImportItem.findMany({
    where: { jobId: job.id },
    orderBy: { createdAt: "asc" }
  });
  const counts = countImportItems(items);
  const status = finalStatus ?? job.status;
  const updated = await client.platformImportJob.update({
    where: { id: job.id },
    data: {
      totalItems: counts.totalItems,
      mappedItems: counts.mappedItems,
      importedItems: counts.importedItems,
      skippedItems: counts.skippedItems,
      duplicateItems: counts.duplicateItems,
      failedItems: counts.failedItems,
      warningCount: counts.warningCount,
      status,
      safeSummary: toJson(safeSummary("Platform import job summary updated.", counts))
    }
  });
  return { job: updated, items, counts };
}

async function createFailedItem(
  job: PlatformImportJob,
  payloadHash: string,
  errorCode: string,
  errorMessage: string,
  client: Db
) {
  return client.platformImportItem.create({
    data: {
      jobId: job.id,
      connectionId: job.connectionId,
      merchantId: job.merchantId,
      platform: job.platform,
      payloadHash,
      status: PlatformImportItemStatus.FAILED,
      errorCode,
      errorMessage,
      safePayloadPreview: toJson({ error_code: errorCode, message: errorMessage })
    }
  });
}

async function createMappedOrDuplicateItem(
  job: PlatformImportJob,
  payload: Record<string, unknown>,
  pickupLocationId: string | null,
  seenHashes: Set<string>,
  client: Db
) {
  const hash = platformPayloadHash(payload);
  if (seenHashes.has(hash)) {
    return client.platformImportItem.create({
      data: {
        jobId: job.id,
        connectionId: job.connectionId,
        merchantId: job.merchantId,
        platform: job.platform,
        payloadHash: hash,
        status: PlatformImportItemStatus.DUPLICATE,
        errorCode: "PLATFORM_IMPORT_DUPLICATE_PAYLOAD",
        errorMessage: "This payload was already included in the import job.",
        safePayloadPreview: toJson({ duplicate_scope: "same_job" })
      }
    });
  }
  seenHashes.add(hash);

  let normalized: NormalizedPlatformOrder;
  try {
    normalized = await mapPlatformOrder(job.platform, payload, { pickupLocationId });
  } catch (error) {
    return createFailedItem(
      job,
      hash,
      error instanceof HttpError ? error.message : "PLATFORM_IMPORT_MAPPING_FAILED",
      "Platform order could not be mapped safely.",
      client
    );
  }

  if (!normalized.externalOrderId) {
    return createFailedItem(job, hash, "PLATFORM_ORDER_ID_MISSING", "The platform order is missing an order ID.", client);
  }

  const alreadyImported = await hasImportedExternalOrder(
    job.merchantId,
    job.connectionId,
    job.platform,
    normalized.externalOrderId,
    client
  );

  return client.platformImportItem.create({
    data: {
      jobId: job.id,
      connectionId: job.connectionId,
      merchantId: job.merchantId,
      platform: job.platform,
      externalOrderId: normalized.externalOrderId,
      externalOrderName: normalized.externalOrderName,
      payloadHash: hash,
      status: alreadyImported ? PlatformImportItemStatus.DUPLICATE : PlatformImportItemStatus.MAPPED,
      errorCode: alreadyImported ? "PLATFORM_IMPORT_DUPLICATE_ORDER" : null,
      errorMessage: alreadyImported ? "This platform order was already imported for this store connection." : null,
      mappingWarnings: toJson(normalized.mappingWarnings),
      safePayloadPreview: toJson(createItemPreview(normalized))
    }
  });
}

export async function createPlatformImportJob(
  merchantId: string,
  input: CreatePlatformImportJobInput,
  client: Db = prisma
) {
  const connection = await findConnection(merchantId, input.connectionId, client);
  const mode = input.mode as PlatformImportJobMode;
  const source = input.source as PlatformImportSource;
  assertConnectionUsable(connection);
  assertModeSupported(connection, mode);

  if (mode === PlatformImportJobMode.IMPORT_FOUNDATION) {
    await assertHealthAllowsImportFoundation(merchantId, connection.id, client);
  }

  const job = await client.platformImportJob.create({
    data: {
      connectionId: connection.id,
      merchantId,
      platform: connection.platform,
      mode,
      source,
      status: PlatformImportJobStatus.QUEUED,
      requestedBy: input.requestedBy ?? null,
      totalItems: input.orders.length,
      safeSummary: toJson(safeSummary("Platform import job queued. Manual run is required in this foundation phase.", {
        order_payloads_received: input.orders.length,
        dry_run: mode === PlatformImportJobMode.DRY_RUN,
        read_only_fetch: mode === PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
        read_options: safeReadOptions(input.readOptions)
      }))
    }
  });

  if (mode === PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER) {
    return serializePlatformImportJobWithItems(job, []);
  }

  const seenHashes = new Set<string>();
  for (const payload of input.orders) {
    await createMappedOrDuplicateItem(job, payload, input.pickupLocationId ?? null, seenHashes, client);
  }
  const refreshed = await refreshJobCounts(job, client);
  return serializePlatformImportJobWithItems(refreshed.job, refreshed.items);
}

export async function listPlatformImportJobs(
  merchantId: string,
  query: ListPlatformImportJobsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformImportJobWhereInput = {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.status ? { status: query.status as PlatformImportJobStatus } : {}),
    ...(query.mode ? { mode: query.mode as PlatformImportJobMode } : {}),
    ...(query.connectionId ? { connectionId: query.connectionId } : {})
  };
  const [jobs, total] = await Promise.all([
    client.platformImportJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformImportJob.count({ where })
  ]);
  return {
    jobs: jobs.map(serializePlatformImportJob),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getPlatformImportJob(
  merchantId: string,
  jobId: string,
  client: Db = prisma
) {
  const job = await findJob(merchantId, jobId, client);
  const items = await client.platformImportItem.findMany({
    where: { jobId: job.id, merchantId },
    orderBy: { createdAt: "asc" }
  });
  return serializePlatformImportJobWithItems(job, items);
}

export async function cancelPlatformImportJob(
  merchantId: string,
  jobId: string,
  client: Db = prisma
) {
  const job = await findJob(merchantId, jobId, client);
  if (terminalJobStatuses.has(job.status)) throw new HttpError(409, "PLATFORM_IMPORT_JOB_NOT_CANCELLABLE");
  const now = new Date();
  const updated = await client.platformImportJob.update({
    where: { id: job.id },
    data: {
      status: PlatformImportJobStatus.CANCELLED,
      cancelledAt: now,
      safeSummary: toJson(safeSummary("Platform import job was cancelled before worker execution."))
    }
  });
  return serializePlatformImportJob(updated);
}

export async function runPlatformImportJobFoundation(
  merchantId: string,
  jobId: string,
  client: Db = prisma,
  readOptions: ReadFetchQueueOptions = {}
) {
  const job = await findJob(merchantId, jobId, client);
  if (terminalJobStatuses.has(job.status)) throw new HttpError(409, "PLATFORM_IMPORT_JOB_NOT_RUNNABLE");
  const queuedReadOptions = job.mode === PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER ? readOptionsFromJob(job) : null;
  const now = new Date();
  const running = await client.platformImportJob.update({
    where: { id: job.id },
    data: {
      status: PlatformImportJobStatus.RUNNING,
      startedAt: job.startedAt ?? now,
      safeSummary: toJson(safeSummary("Platform import job is running in manual foundation mode.", queuedReadOptions ? {
        read_only_fetch: true,
        read_options: {
          since: queuedReadOptions.since?.toISOString() ?? null,
          limit: queuedReadOptions.limit,
          cursor: queuedReadOptions.cursor
        }
      } : {}))
    }
  });

  if (running.mode === PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER) {
    try {
      const options = queuedReadOptions ?? readOptionsFromJob(running);
      const fetched = await fetchPlatformOrdersReadOnly({
        merchantId,
        connectionId: running.connectionId,
        platform: running.platform as ReadableStorePlatform,
        since: options.since,
        limit: options.limit,
        cursor: options.cursor,
        mode: "READ_ONLY_FETCH"
      }, {
        ...readOptions,
        client
      });
      const seenHashes = new Set<string>();
      for (const rawOrder of fetched.rawOrders) {
        await createMappedOrDuplicateItem(running, rawOrder, null, seenHashes, client);
      }
      const items = await client.platformImportItem.findMany({
        where: { jobId: running.id, merchantId },
        orderBy: { createdAt: "asc" }
      });
      const counts = countImportItems(items);
      const warnings = [...fetched.warnings, ...fetched.rateLimitWarnings];
      const finalStatus = finalReadFetchStatus(counts, warnings);
      const updated = await client.platformImportJob.update({
        where: { id: running.id },
        data: {
          status: finalStatus,
          completedAt: new Date(),
          totalItems: counts.totalItems,
          mappedItems: counts.mappedItems,
          importedItems: counts.importedItems,
          skippedItems: counts.skippedItems,
          duplicateItems: counts.duplicateItems,
          failedItems: counts.failedItems,
          warningCount: counts.warningCount + warnings.length,
          safeSummary: toJson(safeSummary("Read-only platform order fetch completed in manual foundation mode.", {
            ...counts,
            fetched_count: fetched.fetchedCount,
            mapped_preview_count: fetched.orders.length,
            requested_limit: fetched.requestedLimit,
            effective_limit: fetched.effectiveLimit,
            has_more: fetched.hasMore,
            next_cursor: fetched.nextCursor,
            warnings,
            retry_after_seconds: fetched.retryAfterSeconds,
            fetch_details: fetched.safeDetails
          }))
        }
      });
      return serializePlatformImportJobWithItems(updated, items);
    } catch (error) {
      const items = await client.platformImportItem.findMany({
        where: { jobId: running.id, merchantId },
        orderBy: { createdAt: "asc" }
      });
      const updated = await client.platformImportJob.update({
        where: { id: running.id },
        data: {
          status: PlatformImportJobStatus.FAILED,
          completedAt: new Date(),
          failedItems: Math.max(1, items.length ? items.length : 1),
          safeSummary: toJson(safeSummary("Read-only platform order fetch failed safely.", {
            error_code: error instanceof HttpError ? error.message : "PLATFORM_READ_REQUEST_FAILED",
            warning: "Connection is not ready for read-only fetch."
          }))
        }
      });
      return serializePlatformImportJobWithItems(updated, items);
    }
  }

  if (running.mode === PlatformImportJobMode.IMPORT_FOUNDATION) {
    const items = await client.platformImportItem.findMany({
      where: { jobId: running.id, merchantId, status: PlatformImportItemStatus.MAPPED },
      orderBy: { createdAt: "asc" }
    });
    for (const item of items) {
      if (!item.externalOrderId) {
        await client.platformImportItem.update({
          where: { id: item.id },
          data: {
            status: PlatformImportItemStatus.FAILED,
            errorCode: "PLATFORM_ORDER_ID_MISSING",
            errorMessage: "The platform order is missing an order ID."
          }
        });
        continue;
      }
      const existing = await hasImportedExternalOrder(merchantId, running.connectionId, running.platform, item.externalOrderId, client);
      if (existing) {
        await client.platformImportItem.update({
          where: { id: item.id },
          data: {
            status: PlatformImportItemStatus.DUPLICATE,
            errorCode: "PLATFORM_IMPORT_DUPLICATE_ORDER",
            errorMessage: "This platform order was already imported for this store connection."
          }
        });
        continue;
      }
      const record = await client.platformOrderImport.create({
        data: {
          connectionId: running.connectionId,
          merchantId,
          platform: running.platform,
          externalOrderId: item.externalOrderId,
          externalOrderName: item.externalOrderName,
          status: PlatformOrderImportStatus.MAPPED,
          rawPayloadHash: item.payloadHash,
          rawPayloadPreview: item.safePayloadPreview as Prisma.InputJsonValue,
          mappingWarnings: (item.mappingWarnings ?? []) as Prisma.InputJsonValue
        }
      });
      await client.platformImportItem.update({
        where: { id: item.id },
        data: {
          status: PlatformImportItemStatus.IMPORTED,
          orderImportId: record.id,
          lastAttemptAt: new Date(),
          nextAttemptAt: null,
          errorCode: null,
          errorMessage: null
        }
      });
    }
    await client.platformConnection.update({
      where: { id: running.connectionId },
      data: { lastOrderImportAt: new Date() }
    });
  }

  const items = await client.platformImportItem.findMany({
    where: { jobId: running.id, merchantId },
    orderBy: { createdAt: "asc" }
  });
  const counts = countImportItems(items);
  const finalStatus = finalImportJobStatus(counts, running.mode);
  const updated = await client.platformImportJob.update({
    where: { id: running.id },
    data: {
      status: finalStatus,
      completedAt: new Date(),
      totalItems: counts.totalItems,
      mappedItems: counts.mappedItems,
      importedItems: counts.importedItems,
      skippedItems: counts.skippedItems,
      duplicateItems: counts.duplicateItems,
      failedItems: counts.failedItems,
      warningCount: counts.warningCount,
      safeSummary: toJson(safeSummary("Platform import job completed in manual foundation mode.", counts))
    }
  });
  return serializePlatformImportJobWithItems(updated, items);
}

export async function retryPlatformImportItem(
  merchantId: string,
  itemId: string,
  client: Db = prisma
) {
  const item = await findItem(merchantId, itemId, client);
  if (item.status !== PlatformImportItemStatus.FAILED) {
    throw new HttpError(409, "PLATFORM_IMPORT_ITEM_NOT_RETRYABLE");
  }
  const nextAttemptCount = item.attemptCount + 1;
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + retryBackoffMinutes(nextAttemptCount) * 60_000);
  const updated = await client.platformImportItem.update({
    where: { id: item.id },
    data: {
      attemptCount: nextAttemptCount,
      lastAttemptAt: now,
      nextAttemptAt,
      errorMessage: "Manual retry recorded. Background retries are not enabled in this foundation phase."
    }
  });
  return serializePlatformImportItem(updated);
}

export async function getPlatformImportJobSummary(
  merchantId: string,
  jobId: string,
  client: Db = prisma
) {
  const job = await findJob(merchantId, jobId, client);
  const items = await client.platformImportItem.findMany({
    where: { jobId: job.id, merchantId },
    orderBy: { createdAt: "asc" }
  });
  const counts = countImportItems(items);
  return {
    job: serializePlatformImportJob(job),
    summary: {
      ...counts,
      message: job.safeSummary && typeof job.safeSummary === "object"
        ? (job.safeSummary as Record<string, unknown>).message ?? "Platform import job summary."
        : "Platform import job summary.",
      next_retry_count: items.filter((item) => item.nextAttemptAt).length
    },
    items: items.map(serializePlatformImportItem)
  };
}
