import { StorePlatform, type Prisma } from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import {
  buildReconciliationItemView,
  reconciliationErrors,
  reconciliationStatusForItem,
  reconciliationWarnings,
  serializeReconciliationItem,
  serializeReconciliationItemDetail,
  serializeReconciliationSummary,
  type ReconciliationItemView
} from "./platform-import-reconciliation.serializer.js";
import type {
  ReconciliationItemsQueryInput,
  ReconciliationSummaryQueryInput
} from "./platform-import-reconciliation.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

type ImportItemRecord = {
  id: string;
  jobId: string;
  connectionId: string;
  merchantId: string;
  platform: StorePlatform | string;
  externalOrderId?: string | null;
  externalOrderName?: string | null;
  status: string;
  attemptCount?: number | null;
  lastAttemptAt?: Date | string | null;
  nextAttemptAt?: Date | string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  mappingWarnings?: unknown;
  safePayloadPreview?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

function parseDate(value: string | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateValue(value: Date | string | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSameOrAfter(value: Date | null, floor: Date | null) {
  return !floor || (value && value.getTime() >= floor.getTime());
}

function isSameOrBefore(value: Date | null, ceiling: Date | null) {
  return !ceiling || (value && value.getTime() <= ceiling.getTime());
}

function matchesDateRange(item: ImportItemRecord, from: Date | null, to: Date | null) {
  const createdAt = dateValue(item.createdAt);
  return isSameOrAfter(createdAt, from) && isSameOrBefore(createdAt, to);
}

function safeSearchText(view: ReconciliationItemView) {
  const serialized = serializeReconciliationItem(view);
  return [
    serialized.external_order_id,
    serialized.external_order_name,
    serialized.buyer_preview?.name,
    serialized.buyer_preview?.city,
    serialized.buyer_preview?.state,
    serialized.order_preview?.currency,
    view.item.platform
  ].filter(Boolean).join(" ").toLowerCase();
}

function filterViews(
  views: ReconciliationItemView[],
  query: ReconciliationSummaryQueryInput & Partial<ReconciliationItemsQueryInput>
) {
  const from = parseDate(query.dateFrom);
  const to = parseDate(query.dateTo);
  const search = query.search?.toLowerCase() ?? "";

  return views.filter((view) => {
    const item = view.item as ImportItemRecord;
    if (query.status && view.status !== query.status) return false;
    if (query.hasWarnings === true && reconciliationWarnings(item).length === 0) return false;
    if (query.hasWarnings === false && reconciliationWarnings(item).length > 0) return false;
    if (query.hasErrors === true && reconciliationErrors(item).length === 0) return false;
    if (query.hasErrors === false && reconciliationErrors(item).length > 0) return false;
    if (!matchesDateRange(item, from, to)) return false;
    if (search && !safeSearchText(view).includes(search)) return false;
    return true;
  });
}

function sortViews(views: ReconciliationItemView[], sort: ReconciliationItemsQueryInput["sort"]) {
  const [field, direction] = sort === "created_at_asc"
    ? ["createdAt", "asc"]
    : sort === "updated_at_asc"
      ? ["updatedAt", "asc"]
      : sort === "created_at_desc"
        ? ["createdAt", "desc"]
        : ["updatedAt", "desc"];

  return [...views].sort((left, right) => {
    const leftDate = dateValue((left.item as Record<string, unknown>)[field] as Date | string | null)?.getTime() ?? 0;
    const rightDate = dateValue((right.item as Record<string, unknown>)[field] as Date | string | null)?.getTime() ?? 0;
    return direction === "asc" ? leftDate - rightDate : rightDate - leftDate;
  });
}

function itemBaseWhere(
  merchantId: string,
  query: ReconciliationSummaryQueryInput & Partial<ReconciliationItemsQueryInput>
): Prisma.PlatformImportItemWhereInput {
  return {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.connectionId ? { connectionId: query.connectionId } : {}),
    ...(query.jobId ? { jobId: query.jobId } : {})
  };
}

function jobBaseWhere(
  merchantId: string,
  query: ReconciliationSummaryQueryInput & Partial<ReconciliationItemsQueryInput>
): Prisma.PlatformImportJobWhereInput {
  return {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.connectionId ? { connectionId: query.connectionId } : {}),
    ...(query.jobId ? { id: query.jobId } : {})
  };
}

async function loadReconciliationState(
  merchantId: string,
  query: ReconciliationSummaryQueryInput & Partial<ReconciliationItemsQueryInput>,
  client: Db
) {
  const [jobs, items, connections] = await Promise.all([
    client.platformImportJob.findMany({
      where: jobBaseWhere(merchantId, query),
      orderBy: { createdAt: "desc" }
    }),
    client.platformImportItem.findMany({
      where: itemBaseWhere(merchantId, query),
      orderBy: { updatedAt: "desc" }
    }),
    client.platformConnection.findMany({
      where: { merchantId }
    })
  ]);
  const conversions = items.length
    ? await client.platformImportConversion.findMany({
      where: {
        merchantId,
        importItemId: { in: items.map((item) => item.id) }
      }
    })
    : [];
  const conversionsByItemId = new Map(conversions.map((conversion) => [conversion.importItemId, conversion]));

  const from = parseDate(query.dateFrom);
  const to = parseDate(query.dateTo);
  const dateFilteredJobs = jobs.filter((job) => {
    const createdAt = dateValue(job.createdAt);
    return isSameOrAfter(createdAt, from) && isSameOrBefore(createdAt, to);
  });
  const itemViews = filterViews(items.map((item) => buildReconciliationItemView(item, conversionsByItemId.get(item.id))), query);
  const itemJobIds = new Set(itemViews.map((view) => view.item.jobId));
  const matchingJobs = query.status || query.hasWarnings !== undefined || query.hasErrors !== undefined || query.search
    ? dateFilteredJobs.filter((job) => itemJobIds.has(job.id))
    : dateFilteredJobs;

  return { jobs: matchingJobs, itemViews, connections };
}

export async function getPlatformImportReconciliationSummary(
  merchantId: string,
  query: ReconciliationSummaryQueryInput = {},
  client: Db = prisma
) {
  const state = await loadReconciliationState(merchantId, query, client);
  return serializeReconciliationSummary(state);
}

export async function listPlatformImportReconciliationItems(
  merchantId: string,
  query: ReconciliationItemsQueryInput,
  client: Db = prisma
) {
  const state = await loadReconciliationState(merchantId, query, client);
  const sorted = sortViews(state.itemViews, query.sort);
  const page = query.page;
  const limit = query.limit;
  const start = (page - 1) * limit;
  const pageItems = sorted.slice(start, start + limit);

  return {
    items: pageItems.map(serializeReconciliationItem),
    page,
    limit,
    total: sorted.length,
    has_more: start + limit < sorted.length
  };
}

export async function getPlatformImportReconciliationItem(
  merchantId: string,
  itemId: string,
  client: Db = prisma
) {
  const item = await client.platformImportItem.findFirst({
    where: { id: itemId, merchantId }
  });
  if (!item) throw new HttpError(404, "PLATFORM_IMPORT_ITEM_NOT_FOUND");
  const conversion = await client.platformImportConversion.findFirst({
    where: { merchantId, importItemId: item.id }
  });
  return serializeReconciliationItemDetail(buildReconciliationItemView(item, conversion));
}

export const reconciliationStatusForImportItem = reconciliationStatusForItem;
