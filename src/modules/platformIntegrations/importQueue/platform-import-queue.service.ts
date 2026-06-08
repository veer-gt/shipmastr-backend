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
  type PlatformImportCursor,
  type PlatformImportJob
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import {
  notifyImportJobFailed,
  recordImportItemNotifications
} from "../../merchantNotifications/merchant-notification.service.js";
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
  serializePlatformImportCursor,
  serializePlatformImportProgress,
  serializePlatformImportItem,
  serializePlatformImportJob,
  serializePlatformImportJobWithItems
} from "./platform-import-queue.serializers.js";
import type {
  ContinuePlatformImportJobInput,
  CreatePlatformImportJobInput,
  ListPlatformImportCursorsQueryInput,
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

function readOptionsFromCursor(cursor: PlatformImportCursor, limit?: number | null) {
  return {
    since: cursor.since ?? null,
    limit: limit ?? null,
    cursor: cursor.cursor ?? null
  };
}

function cursorStatus(hasMore: boolean, failedItems: number, warningCount: number) {
  if (failedItems > 0) return "ERROR";
  if (hasMore) return warningCount > 0 ? "HAS_MORE_WITH_WARNINGS" : "HAS_MORE";
  return warningCount > 0 ? "EXHAUSTED_WITH_WARNINGS" : "EXHAUSTED";
}

function nextPageFrom(current: number | null | undefined) {
  return (current ?? 0) + 1;
}

function processedCount(counts: ReturnType<typeof countImportItems>) {
  return counts.mappedItems + counts.importedItems + counts.skippedItems + counts.duplicateItems + counts.failedItems;
}

function progressPercent(processed: number, total: number) {
  if (!total) return processed ? 100 : 0;
  return Math.min(100, Math.round((processed / total) * 100));
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

async function findCursor(merchantId: string, cursorId: string, client: Db) {
  const cursor = await client.platformImportCursor.findFirst({
    where: { id: cursorId, merchantId }
  });
  if (!cursor) throw new HttpError(404, "PLATFORM_IMPORT_CURSOR_NOT_FOUND");
  return cursor;
}

async function findConnectionCursor(
  merchantId: string,
  connectionId: string,
  platform: StorePlatform,
  client: Db
) {
  return client.platformImportCursor.findFirst({
    where: { merchantId, connectionId, platform },
    orderBy: { updatedAt: "desc" }
  });
}

async function upsertReadFetchCursor(
  job: PlatformImportJob,
  input: {
    since?: Date | null;
    nextCursor?: string | null;
    hasMore: boolean;
    warningCount: number;
    errorCount: number;
  },
  client: Db
) {
  const existing = await findConnectionCursor(job.merchantId, job.connectionId, job.platform, client);
  const page = nextPageFrom(existing?.page);
  const data = {
    merchantId: job.merchantId,
    connectionId: job.connectionId,
    platform: job.platform,
    cursor: input.nextCursor ?? null,
    page,
    since: input.since ?? existing?.since ?? null,
    status: cursorStatus(input.hasMore, input.errorCount, input.warningCount),
    lastJobId: job.id,
    hasMore: input.hasMore,
    warningCount: input.warningCount,
    errorCount: input.errorCount
  };
  if (existing) {
    return client.platformImportCursor.update({
      where: { id: existing.id },
      data
    });
  }
  return client.platformImportCursor.create({ data });
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
  const item = await client.platformImportItem.create({
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
  await recordImportItemNotifications(item, client).catch(() => undefined);
  return item;
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
    const duplicate = await client.platformImportItem.create({
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
    await recordImportItemNotifications(duplicate, client).catch(() => undefined);
    return duplicate;
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
  const findQueuedItem = (client.platformImportItem as unknown as {
    findFirst?: typeof client.platformImportItem.findFirst;
  }).findFirst;
  const alreadyQueued = alreadyImported || !findQueuedItem ? null : await findQueuedItem.call(client.platformImportItem, {
    where: {
      merchantId: job.merchantId,
      connectionId: job.connectionId,
      platform: job.platform,
      externalOrderId: normalized.externalOrderId,
      NOT: { jobId: job.id }
    }
  });

  const item = await client.platformImportItem.create({
    data: {
      jobId: job.id,
      connectionId: job.connectionId,
      merchantId: job.merchantId,
      platform: job.platform,
      externalOrderId: normalized.externalOrderId,
      externalOrderName: normalized.externalOrderName,
      payloadHash: hash,
      status: alreadyImported || alreadyQueued ? PlatformImportItemStatus.DUPLICATE : PlatformImportItemStatus.MAPPED,
      errorCode: alreadyImported || alreadyQueued ? "PLATFORM_IMPORT_DUPLICATE_ORDER" : null,
      errorMessage: alreadyImported || alreadyQueued ? "This platform order was already imported or queued for this store connection." : null,
      mappingWarnings: toJson(normalized.mappingWarnings),
      safePayloadPreview: toJson(createItemPreview(normalized))
    }
  });
  await recordImportItemNotifications(item, client).catch(() => undefined);
  return item;
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
      const cursor = await upsertReadFetchCursor(running, {
        since: options.since,
        nextCursor: fetched.nextCursor,
        hasMore: fetched.hasMore,
        warningCount: counts.warningCount + warnings.length,
        errorCount: counts.failedItems
      }, client);
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
            cursor_id: cursor.id,
            cursor_status: cursor.status,
            next_page_ready: Boolean(cursor.hasMore && cursor.cursor),
            warnings,
            retry_after_seconds: fetched.retryAfterSeconds,
            fetch_details: fetched.safeDetails
          }))
        }
      });
      await notifyImportJobFailed(updated, client).catch(() => undefined);
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
      await upsertReadFetchCursor(running, {
        since: queuedReadOptions?.since ?? null,
        nextCursor: queuedReadOptions?.cursor ?? null,
        hasMore: false,
        warningCount: 1,
        errorCount: Math.max(1, items.length ? items.length : 1)
      }, client).catch(() => undefined);
      await notifyImportJobFailed(updated, client).catch(() => undefined);
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
        const updatedItem = await client.platformImportItem.update({
          where: { id: item.id },
          data: {
            status: PlatformImportItemStatus.FAILED,
            errorCode: "PLATFORM_ORDER_ID_MISSING",
            errorMessage: "The platform order is missing an order ID."
          }
        });
        await recordImportItemNotifications(updatedItem, client).catch(() => undefined);
        continue;
      }
      const existing = await hasImportedExternalOrder(merchantId, running.connectionId, running.platform, item.externalOrderId, client);
      if (existing) {
        const updatedItem = await client.platformImportItem.update({
          where: { id: item.id },
          data: {
            status: PlatformImportItemStatus.DUPLICATE,
            errorCode: "PLATFORM_IMPORT_DUPLICATE_ORDER",
            errorMessage: "This platform order was already imported for this store connection."
          }
        });
        await recordImportItemNotifications(updatedItem, client).catch(() => undefined);
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
  await notifyImportJobFailed(updated, client).catch(() => undefined);
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
  await recordImportItemNotifications(updated, client).catch(() => undefined);
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

export async function getPlatformImportJobProgress(
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
  const cursor = await findConnectionCursor(merchantId, job.connectionId, job.platform, client);
  const summary = job.safeSummary && typeof job.safeSummary === "object"
    ? job.safeSummary as Record<string, unknown>
    : {};
  const processed = processedCount(counts);
  const total = Math.max(job.totalItems || 0, counts.totalItems);
  const warningList = Array.isArray(summary.warnings) ? summary.warnings : [];
  return serializePlatformImportProgress({
    job,
    cursor,
    progress: {
      processed_items: processed,
      total_items: total,
      progress_percent: progressPercent(processed, total),
      has_more: Boolean(cursor?.hasMore || summary.has_more),
      next_cursor: cursor?.cursor ?? (typeof summary.next_cursor === "string" ? summary.next_cursor : null),
      next_page_ready: Boolean((cursor?.hasMore || summary.has_more) && (cursor?.cursor || summary.next_cursor)),
      rate_limit_warning: typeof warningList[0] === "string" && /rate limit/i.test(warningList[0]) ? warningList[0] : null
    }
  });
}

export async function listPlatformImportCursors(
  merchantId: string,
  query: ListPlatformImportCursorsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const where: Prisma.PlatformImportCursorWhereInput = {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.connectionId ? { connectionId: query.connectionId } : {}),
    ...(query.status ? { status: query.status } : {})
  };
  const [cursors, total] = await Promise.all([
    client.platformImportCursor.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformImportCursor.count({ where })
  ]);
  return {
    cursors: cursors.map(serializePlatformImportCursor),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getPlatformImportCursor(
  merchantId: string,
  cursorId: string,
  client: Db = prisma
) {
  return serializePlatformImportCursor(await findCursor(merchantId, cursorId, client));
}

async function createAndRunNextPageJob(
  merchantId: string,
  cursor: PlatformImportCursor,
  input: ContinuePlatformImportJobInput = {},
  client: Db = prisma,
  fetchOptions: ReadFetchQueueOptions = {}
) {
  if (!cursor.hasMore || !cursor.cursor) throw new HttpError(409, "PLATFORM_IMPORT_CURSOR_EXHAUSTED");
  const readOptions = readOptionsFromCursor(cursor, input.limit ?? null);
  const created = await createPlatformImportJob(merchantId, {
    connectionId: cursor.connectionId,
    mode: PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER,
    source: PlatformImportSource.POLLING_PLACEHOLDER,
    readOptions: {
      ...(readOptions.since ? { since: readOptions.since.toISOString() } : {}),
      ...(readOptions.limit ? { limit: readOptions.limit } : {}),
      ...(readOptions.cursor ? { cursor: readOptions.cursor } : {})
    },
    orders: []
  }, client);
  const ran = await runPlatformImportJobFoundation(merchantId, created.job.job_id, client, fetchOptions);
  const updatedCursor = await findConnectionCursor(merchantId, cursor.connectionId, cursor.platform, client);
  return {
    cursor: updatedCursor ? serializePlatformImportCursor(updatedCursor) : null,
    result: ran,
    progress: await getPlatformImportJobProgress(merchantId, ran.job.job_id, client)
  };
}

export async function continuePlatformImportJob(
  merchantId: string,
  jobId: string,
  input: ContinuePlatformImportJobInput = {},
  client: Db = prisma,
  fetchOptions: ReadFetchQueueOptions = {}
) {
  const job = await findJob(merchantId, jobId, client);
  if (job.mode !== PlatformImportJobMode.READ_ONLY_FETCH_PLACEHOLDER) {
    throw new HttpError(409, "PLATFORM_IMPORT_JOB_NOT_READ_ONLY_FETCH");
  }
  const cursor = await findConnectionCursor(merchantId, job.connectionId, job.platform, client);
  if (!cursor) throw new HttpError(409, "PLATFORM_IMPORT_CURSOR_NOT_READY");
  return createAndRunNextPageJob(merchantId, cursor, input, client, fetchOptions);
}

export async function runNextPlatformImportCursorPage(
  merchantId: string,
  cursorId: string,
  input: ContinuePlatformImportJobInput = {},
  client: Db = prisma,
  fetchOptions: ReadFetchQueueOptions = {}
) {
  const cursor = await findCursor(merchantId, cursorId, client);
  return createAndRunNextPageJob(merchantId, cursor, input, client, fetchOptions);
}

export async function resetPlatformImportCursor(
  merchantId: string,
  cursorId: string,
  client: Db = prisma
) {
  const cursor = await findCursor(merchantId, cursorId, client);
  const updated = await client.platformImportCursor.update({
    where: { id: cursor.id },
    data: {
      cursor: null,
      hasMore: false,
      page: 0,
      status: "RESET",
      lastJobId: null,
      warningCount: 0,
      errorCount: 0
    }
  });
  return serializePlatformImportCursor(updated);
}
