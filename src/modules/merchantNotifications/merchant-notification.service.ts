import { PlatformImportItemStatus, PlatformImportJobStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  sanitizeNotificationMeta,
  serializeMerchantNotification,
  serializeMerchantNotificationPreference
} from "./merchant-notification.serializer.js";
import type {
  MerchantNotificationInput,
  MerchantNotificationType
} from "./merchant-notification.types.js";
import type {
  ListMerchantNotificationsQueryInput,
  UpdateMerchantNotificationPreferencesInput
} from "./merchant-notification.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(sanitizeNotificationMeta(value))) as Prisma.InputJsonValue;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function preferencePayload(input: UpdateMerchantNotificationPreferencesInput) {
  return {
    ...(input.in_app_enabled !== undefined ? { inAppEnabled: input.in_app_enabled } : {}),
    ...(input.import_failed_enabled !== undefined ? { importFailedEnabled: input.import_failed_enabled } : {}),
    ...(input.needs_review_enabled !== undefined ? { needsReviewEnabled: input.needs_review_enabled } : {}),
    ...(input.duplicate_enabled !== undefined ? { duplicateEnabled: input.duplicate_enabled } : {}),
    ...(input.conversion_blocked_enabled !== undefined ? { conversionBlockedEnabled: input.conversion_blocked_enabled } : {}),
    ...(input.digest_enabled !== undefined ? { digestEnabled: input.digest_enabled } : {}),
    ...(input.email_enabled !== undefined ? { emailEnabled: input.email_enabled } : {})
  };
}

async function ensurePreferences(merchantId: string, client: Db) {
  const existing = await client.merchantNotificationPreference.findUnique({ where: { merchantId } });
  if (existing) return existing;
  return client.merchantNotificationPreference.create({ data: { merchantId } });
}

function preferenceAllows(type: MerchantNotificationType, preferences: {
  inAppEnabled: boolean;
  importFailedEnabled: boolean;
  needsReviewEnabled: boolean;
  duplicateEnabled: boolean;
  conversionBlockedEnabled: boolean;
  digestEnabled: boolean;
}) {
  if (!preferences.inAppEnabled) return false;
  if (type === "IMPORT_DIGEST") return preferences.digestEnabled;
  if (type === "IMPORT_ITEM_DUPLICATE") return preferences.duplicateEnabled;
  if (type === "IMPORT_ITEM_NEEDS_REVIEW" || type === "CONVERSION_NEEDS_ATTENTION") return preferences.needsReviewEnabled;
  if (type === "CONVERSION_BLOCKED") return preferences.conversionBlockedEnabled;
  return preferences.importFailedEnabled || type === "CONVERSION_COMPLETED";
}

export async function createMerchantNotification(
  merchantId: string,
  input: MerchantNotificationInput,
  client: Db = prisma
) {
  const preferences = await ensurePreferences(merchantId, client);
  if (!preferenceAllows(input.type, preferences)) {
    return { notification: null, created: false, skipped: true };
  }
  const data = {
    merchantId,
    type: input.type,
    severity: input.severity,
    title: input.title,
    message: input.message,
    actionLabel: input.actionLabel ?? null,
    actionUrl: input.actionUrl ?? null,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    sourceMeta: toJson(input.sourceMeta ?? {}),
    dedupeKey: input.dedupeKey
  };
  try {
    const created = await client.merchantNotification.create({ data });
    return { notification: serializeMerchantNotification(created), created: true, skipped: false };
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "P2002") {
      const existing = await client.merchantNotification.findFirst({
        where: { merchantId, dedupeKey: input.dedupeKey }
      });
      return {
        notification: existing ? serializeMerchantNotification(existing) : null,
        created: false,
        skipped: false
      };
    }
    throw error;
  }
}

export async function listMerchantNotifications(
  merchantId: string,
  query: ListMerchantNotificationsQueryInput,
  client: Db = prisma
) {
  const where: Prisma.MerchantNotificationWhereInput = {
    merchantId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.severity ? { severity: query.severity } : {})
  };
  const [notifications, total] = await Promise.all([
    client.merchantNotification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.merchantNotification.count({ where })
  ]);
  return {
    notifications: notifications.map(serializeMerchantNotification),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getMerchantNotification(
  merchantId: string,
  notificationId: string,
  client: Db = prisma
) {
  const notification = await client.merchantNotification.findFirst({
    where: { id: notificationId, merchantId }
  });
  if (!notification) throw new HttpError(404, "MERCHANT_NOTIFICATION_NOT_FOUND");
  return serializeMerchantNotification(notification);
}

export async function getUnreadMerchantNotificationCount(merchantId: string, client: Db = prisma) {
  const count = await client.merchantNotification.count({ where: { merchantId, status: "UNREAD" } });
  return { unread_count: count };
}

export async function markMerchantNotificationRead(
  merchantId: string,
  notificationId: string,
  client: Db = prisma
) {
  await getMerchantNotification(merchantId, notificationId, client);
  const notification = await client.merchantNotification.update({
    where: { id: notificationId },
    data: { status: "READ", readAt: new Date() }
  });
  return serializeMerchantNotification(notification);
}

export async function markMerchantNotificationUnread(
  merchantId: string,
  notificationId: string,
  client: Db = prisma
) {
  await getMerchantNotification(merchantId, notificationId, client);
  const notification = await client.merchantNotification.update({
    where: { id: notificationId },
    data: { status: "UNREAD", readAt: null }
  });
  return serializeMerchantNotification(notification);
}

export async function markAllMerchantNotificationsRead(merchantId: string, client: Db = prisma) {
  const now = new Date();
  const result = await client.merchantNotification.updateMany({
    where: { merchantId, status: "UNREAD" },
    data: { status: "READ", readAt: now }
  });
  return { marked_read_count: result.count };
}

export async function getMerchantNotificationPreferences(merchantId: string, client: Db = prisma) {
  return serializeMerchantNotificationPreference(await ensurePreferences(merchantId, client));
}

export async function updateMerchantNotificationPreferences(
  merchantId: string,
  input: UpdateMerchantNotificationPreferencesInput,
  client: Db = prisma
) {
  const preferences = await client.merchantNotificationPreference.upsert({
    where: { merchantId },
    create: { merchantId, ...preferencePayload(input) },
    update: preferencePayload(input)
  });
  return serializeMerchantNotificationPreference(preferences);
}

export async function notifyImportJobFailed(
  job: {
    id: string;
    merchantId: string;
    platform: string;
    status: string;
    failedItems?: number | null;
    totalItems?: number | null;
    warningCount?: number | null;
  },
  client: Db = prisma
) {
  if (job.status !== PlatformImportJobStatus.FAILED) return null;
  return createMerchantNotification(job.merchantId, {
    type: "IMPORT_JOB_FAILED",
    severity: "ERROR",
    title: "Import job needs review",
    message: "An order import job could not finish safely. Review the job before retrying.",
    actionLabel: "Review import job",
    actionUrl: `/seller/developer?importJobId=${encodeURIComponent(job.id)}`,
    sourceType: "PLATFORM_IMPORT_JOB",
    sourceId: job.id,
    sourceMeta: {
      platform: job.platform,
      status: job.status,
      failed_items: job.failedItems ?? 0,
      total_items: job.totalItems ?? 0,
      warning_count: job.warningCount ?? 0
    },
    dedupeKey: `import-job-failed:${job.id}`
  }, client);
}

export async function notifyImportItemIssue(
  item: {
    id: string;
    merchantId: string;
    jobId: string;
    connectionId: string;
    platform: string;
    externalOrderId?: string | null;
    externalOrderName?: string | null;
    status: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    nextAttemptAt?: Date | string | null;
  },
  type: "IMPORT_ITEM_FAILED" | "IMPORT_ITEM_NEEDS_REVIEW" | "IMPORT_ITEM_DUPLICATE" | "IMPORT_ITEM_RETRY_READY",
  client: Db = prisma
) {
  const severity = type === "IMPORT_ITEM_FAILED" ? "ERROR" : type === "IMPORT_ITEM_DUPLICATE" ? "INFO" : "WARNING";
  const title = type === "IMPORT_ITEM_FAILED"
    ? "Imported order failed"
    : type === "IMPORT_ITEM_DUPLICATE"
      ? "Duplicate imported order found"
      : type === "IMPORT_ITEM_RETRY_READY"
        ? "Imported order retry is ready"
        : "Imported order needs review";
  const message = type === "IMPORT_ITEM_DUPLICATE"
    ? "Shipmastr found a duplicate platform order and kept it out of the shipping queue."
    : type === "IMPORT_ITEM_RETRY_READY"
      ? "A failed import item has a manual retry window recorded."
      : "An imported order needs merchant review before it can move forward.";
  return createMerchantNotification(item.merchantId, {
    type,
    severity,
    title,
    message,
    actionLabel: type === "IMPORT_ITEM_RETRY_READY" ? "Retry import item" : "Open reconciliation",
    actionUrl: `/seller/developer?reconciliationItemId=${encodeURIComponent(item.id)}`,
    sourceType: "PLATFORM_IMPORT_ITEM",
    sourceId: item.id,
    sourceMeta: {
      job_id: item.jobId,
      connection_id: item.connectionId,
      platform: item.platform,
      external_order_id: item.externalOrderId ?? null,
      external_order_name: item.externalOrderName ?? null,
      status: item.status,
      error_code: item.errorCode ?? null,
      next_attempt_at: item.nextAttemptAt ?? null
    },
    dedupeKey: `${type.toLowerCase()}:${item.id}`
  }, client);
}

export async function recordImportItemNotifications(
  item: {
    id: string;
    merchantId: string;
    jobId: string;
    connectionId: string;
    platform: string;
    externalOrderId?: string | null;
    externalOrderName?: string | null;
    status: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    mappingWarnings?: unknown;
    nextAttemptAt?: Date | string | null;
  },
  client: Db = prisma
) {
  if (item.status === PlatformImportItemStatus.FAILED) {
    await notifyImportItemIssue(item, "IMPORT_ITEM_FAILED", client);
  }
  if (item.status === PlatformImportItemStatus.DUPLICATE) {
    await notifyImportItemIssue(item, "IMPORT_ITEM_DUPLICATE", client);
  }
  if (item.nextAttemptAt) {
    await notifyImportItemIssue(item, "IMPORT_ITEM_RETRY_READY", client);
  }
  if (
    item.status !== PlatformImportItemStatus.FAILED &&
    item.status !== PlatformImportItemStatus.DUPLICATE &&
    Array.isArray(item.mappingWarnings) &&
    item.mappingWarnings.length > 0
  ) {
    await notifyImportItemIssue(item, "IMPORT_ITEM_NEEDS_REVIEW", client);
  }
}

export async function notifyConversionResult(
  merchantId: string,
  result: {
    itemId?: string;
    item_id?: string;
    status: string;
    orderId?: string | null;
    order_id?: string | null;
    shipmentId?: string | null;
    shipment_id?: string | null;
    queue?: string | null;
    reasonCodes?: string[];
    reason_codes?: string[];
    warnings?: unknown;
  },
  client: Db = prisma
) {
  if (result.status === "ALREADY_CONVERTED") return null;
  const itemId = result.itemId ?? result.item_id ?? "";
  const orderId = result.orderId ?? result.order_id ?? null;
  const shipmentId = result.shipmentId ?? result.shipment_id ?? null;
  const reasonCodes = result.reasonCodes ?? result.reason_codes ?? [];
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
  const type = result.status === "CONVERTED"
    ? "CONVERSION_COMPLETED"
    : result.status === "NEEDS_ATTENTION"
      ? "CONVERSION_NEEDS_ATTENTION"
      : "CONVERSION_BLOCKED";
  const severity = type === "CONVERSION_COMPLETED" ? "SUCCESS" : type === "CONVERSION_BLOCKED" ? "WARNING" : "WARNING";
  return createMerchantNotification(merchantId, {
    type,
    severity,
    title: type === "CONVERSION_COMPLETED"
      ? "Imported order prepared"
      : type === "CONVERSION_NEEDS_ATTENTION"
        ? "Converted order needs attention"
        : "Conversion was blocked",
    message: type === "CONVERSION_COMPLETED"
      ? "An imported order was prepared for Shipmastr shipping."
      : type === "CONVERSION_NEEDS_ATTENTION"
        ? "An imported order was converted, but needs review before shipping."
        : "An imported order could not be converted. Review the reason before trying again.",
    actionLabel: type === "CONVERSION_COMPLETED" ? "View order" : "Review item",
    actionUrl: orderId
      ? `/seller/shipping?orderId=${encodeURIComponent(orderId)}`
      : `/seller/developer?reconciliationItemId=${encodeURIComponent(itemId)}`,
    sourceType: "PLATFORM_IMPORT_CONVERSION",
    sourceId: itemId,
    sourceMeta: {
      item_id: itemId,
      order_id: orderId,
      shipment_id: shipmentId,
      queue: result.queue ?? null,
      reason_codes: reasonCodes,
      warnings
    },
    dedupeKey: `${type.toLowerCase()}:${itemId}`
  }, client);
}

export async function generateImportDigestNotification(merchantId: string, client: Db = prisma) {
  const [jobsFailed, itemsFailed, itemsDuplicate, retryReady, conversionsNeedsAttention] = await Promise.all([
    client.platformImportJob.count({ where: { merchantId, status: PlatformImportJobStatus.FAILED } }),
    client.platformImportItem.count({ where: { merchantId, status: PlatformImportItemStatus.FAILED } }),
    client.platformImportItem.count({ where: { merchantId, status: PlatformImportItemStatus.DUPLICATE } }),
    client.platformImportItem.count({ where: { merchantId, nextAttemptAt: { not: null } } }),
    client.platformImportConversion.count({ where: { merchantId, status: "NEEDS_ATTENTION" } })
  ]);
  return createMerchantNotification(merchantId, {
    type: "IMPORT_DIGEST",
    severity: jobsFailed || itemsFailed ? "WARNING" : "INFO",
    title: "Import review digest",
    message: "Your import review summary is ready in Shipmastr.",
    actionLabel: "Open reconciliation",
    actionUrl: "/seller/developer?section=reconciliation",
    sourceType: "IMPORT_DIGEST",
    sourceId: todayKey(),
    sourceMeta: {
      failed_jobs: jobsFailed,
      failed_items: itemsFailed,
      duplicate_items: itemsDuplicate,
      retry_ready_items: retryReady,
      needs_attention_conversions: conversionsNeedsAttention,
      email_sent: false
    },
    dedupeKey: `import-digest:${todayKey()}`
  }, client);
}
