import type { ReconciliationStatusInput } from "./platform-import-reconciliation.validation.js";
import { sanitizeImportPreview } from "../importQueue/platform-import-queue.serializers.js";

type ImportItemRecord = {
  id: string;
  jobId: string;
  connectionId: string;
  platform: string;
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

type JobRecord = {
  id: string;
  connectionId: string;
  platform: string;
  mode: string;
  status: string;
  totalItems?: number | null;
  mappedItems?: number | null;
  importedItems?: number | null;
  duplicateItems?: number | null;
  failedItems?: number | null;
  warningCount?: number | null;
  safeSummary?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type ConnectionRecord = {
  id: string;
  platform: string;
  storeName?: string | null;
  storeUrl?: string | null;
};

export type ReconciliationItemView = {
  item: ImportItemRecord;
  status: ReconciliationStatusInput;
  warnings: string[];
  errors: string[];
  duplicateReason: string | null;
};

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function warningText(value: unknown) {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return stringValue(record.message) ?? stringValue(record.code) ?? "Mapping warning";
}

function errorList(item: ImportItemRecord) {
  return [item.errorMessage, item.errorCode].filter((value): value is string => Boolean(value));
}

export function reconciliationWarnings(item: ImportItemRecord) {
  return asArray(sanitizeImportPreview(item.mappingWarnings)).map(warningText).filter(Boolean);
}

export function reconciliationErrors(item: ImportItemRecord) {
  return errorList(item);
}

export function reconciliationStatusForItem(item: ImportItemRecord): ReconciliationStatusInput {
  const status = String(item.status || "").toUpperCase();
  const warnings = reconciliationWarnings(item);
  const errors = reconciliationErrors(item);

  if (status === "DUPLICATE") return "DUPLICATE";
  if (status === "FAILED" || errors.length) return "FAILED";
  if (warnings.length) return "WARNING";
  if (status === "MAPPED" || status === "IMPORTED") return "READY";
  if (status === "SKIPPED") return "IGNORED";
  return "NEEDS_REVIEW";
}

function safePayload(item: ImportItemRecord) {
  return asRecord(sanitizeImportPreview(item.safePayloadPreview));
}

function destinationFromPreview(preview: Record<string, unknown>) {
  return asRecord(preview.destination ?? preview.delivery ?? preview.shipping_address);
}

function buyerFromPreview(preview: Record<string, unknown>) {
  return asRecord(preview.buyerPreview ?? preview.buyer_preview ?? preview.buyer);
}

function lineItemsFromPreview(preview: Record<string, unknown>) {
  return asArray(preview.lineItemPreview ?? preview.line_item_preview ?? preview.line_items ?? preview.items)
    .slice(0, 20)
    .map((item) => {
      const record = asRecord(item);
      return {
        name: stringValue(record.name),
        quantity: numberValue(record.quantity ?? record.qty),
        sku: stringValue(record.sku),
        weight_grams: numberValue(record.weightGrams ?? record.weight_grams)
      };
    });
}

function buyerPreview(item: ImportItemRecord) {
  const preview = safePayload(item);
  const buyer = buyerFromPreview(preview);
  const destination = destinationFromPreview(preview);

  return {
    name: stringValue(buyer.name),
    city: stringValue(destination.city ?? buyer.city),
    state: stringValue(destination.state ?? buyer.state),
    pincode: stringValue(destination.postal_code ?? destination.postalCode ?? destination.pincode ?? buyer.pincode),
    country: stringValue(destination.country ?? buyer.country),
    phone_masked: stringValue(buyer.phoneMasked ?? buyer.phone_masked),
    email_masked: stringValue(buyer.emailMasked ?? buyer.email_masked)
  };
}

function orderPreview(item: ImportItemRecord, includeLineItems = false) {
  const preview = safePayload(item);
  const lineItems = lineItemsFromPreview(preview);
  const itemCount = numberValue(preview.item_count ?? preview.itemCount) ?? (lineItems.length || null);
  const totalAmount = numberValue(preview.totalAmount ?? preview.total_amount ?? preview.order_amount ?? preview.order_amount_paise);
  const codDetected = typeof preview.codDetected === "boolean"
    ? preview.codDetected
    : typeof preview.cod_detected === "boolean"
      ? preview.cod_detected
      : String(preview.payment_mode || "").toUpperCase() === "COD";

  return {
    total_amount: totalAmount,
    currency: stringValue(preview.currency),
    cod_detected: codDetected,
    item_count: itemCount,
    ...(includeLineItems ? { line_items: lineItems } : {}),
    created_at: timestamp(preview.createdAt as string | undefined) ?? timestamp(preview.created_at as string | undefined),
    updated_at: timestamp(preview.updatedAt as string | undefined) ?? timestamp(preview.updated_at as string | undefined)
  };
}

export function buildReconciliationItemView(item: ImportItemRecord): ReconciliationItemView {
  const status = reconciliationStatusForItem(item);
  const warnings = reconciliationWarnings(item);
  const errors = reconciliationErrors(item);
  const duplicateReason = status === "DUPLICATE"
    ? item.errorMessage ?? item.errorCode ?? "This platform order already exists in this import scope."
    : null;
  return { item, status, warnings, errors, duplicateReason };
}

export function serializeReconciliationItem(view: ReconciliationItemView) {
  const { item, status, warnings, errors } = view;
  return {
    item_id: item.id,
    job_id: item.jobId,
    platform: item.platform,
    connection_id: item.connectionId,
    external_order_id: item.externalOrderId ?? null,
    external_order_name: item.externalOrderName ?? null,
    reconciliation_status: status,
    import_status: item.status,
    buyer_preview: buyerPreview(item),
    order_preview: orderPreview(item),
    warnings,
    errors,
    retry_state: {
      can_retry: item.status === "FAILED",
      retry_count: item.attemptCount ?? 0,
      next_retry_at: timestamp(item.nextAttemptAt)
    },
    created_at: timestamp(item.createdAt),
    updated_at: timestamp(item.updatedAt)
  };
}

export function serializeReconciliationItemDetail(view: ReconciliationItemView) {
  const { item, status, warnings, errors, duplicateReason } = view;
  const safeNextActions = status === "FAILED"
    ? ["REVIEW", "RETRY"]
    : ["REVIEW"];

  return {
    item_id: item.id,
    job_id: item.jobId,
    platform: item.platform,
    connection_id: item.connectionId,
    external_order_id: item.externalOrderId ?? null,
    external_order_name: item.externalOrderName ?? null,
    reconciliation_status: status,
    import_status: item.status,
    buyer_preview: buyerPreview(item),
    order_preview: orderPreview(item, true),
    warnings,
    errors,
    duplicate_reason: duplicateReason,
    safe_next_actions: safeNextActions,
    created_at: timestamp(item.createdAt),
    updated_at: timestamp(item.updatedAt)
  };
}

export function serializeReconciliationSummary(input: {
  jobs: JobRecord[];
  itemViews: ReconciliationItemView[];
  connections: ConnectionRecord[];
}) {
  const { jobs, itemViews, connections } = input;
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));

  const countStatus = (status: ReconciliationStatusInput) => itemViews.filter((view) => view.status === status).length;
  const readOnlyFetched = jobs.reduce((sum, job) => {
    const safeSummary = asRecord(sanitizeImportPreview(job.safeSummary));
    const fetched = numberValue(safeSummary.fetched_count);
    return sum + (fetched ?? (job.mode === "READ_ONLY_FETCH_PLACEHOLDER" ? Number(job.totalItems || 0) : 0));
  }, 0);

  const platforms = new Map<string, ReconciliationItemView[]>();
  const connectionGroups = new Map<string, ReconciliationItemView[]>();
  for (const view of itemViews) {
    platforms.set(view.item.platform, [...(platforms.get(view.item.platform) ?? []), view]);
    connectionGroups.set(view.item.connectionId, [...(connectionGroups.get(view.item.connectionId) ?? []), view]);
  }

  const groupCounts = (views: ReconciliationItemView[]) => ({
    total_items: views.length,
    ready_items: views.filter((view) => view.status === "READY").length,
    duplicate_items: views.filter((view) => view.status === "DUPLICATE").length,
    warning_items: views.filter((view) => view.status === "WARNING" || view.status === "NEEDS_REVIEW").length,
    failed_items: views.filter((view) => view.status === "FAILED").length
  });

  return {
    total_jobs: jobs.length,
    total_items: itemViews.length,
    fetched_items: readOnlyFetched,
    ready_items: countStatus("READY"),
    duplicate_items: countStatus("DUPLICATE"),
    warning_items: countStatus("WARNING") + countStatus("NEEDS_REVIEW"),
    failed_items: countStatus("FAILED"),
    ignored_items: countStatus("IGNORED"),
    retriable_items: itemViews.filter((view) => view.item.status === "FAILED").length,
    by_platform: Array.from(platforms.entries()).map(([platform, views]) => ({
      platform,
      ...groupCounts(views)
    })),
    by_connection: Array.from(connectionGroups.entries()).map(([connectionId, views]) => {
      const connection = connectionsById.get(connectionId);
      return {
        connection_id: connectionId,
        connection_name: connection?.storeName ?? connection?.storeUrl ?? null,
        platform: connection?.platform ?? views[0]?.item.platform ?? "CUSTOM",
        ...groupCounts(views)
      };
    }),
    latest_jobs: jobs.slice(0, 8).map((job) => {
      const views = itemViews.filter((view) => view.item.jobId === job.id);
      const counts = groupCounts(views);
      return {
        job_id: job.id,
        platform: job.platform,
        mode: job.mode,
        status: job.status,
        total_items: job.totalItems ?? counts.total_items,
        ready_items: counts.ready_items,
        warning_items: counts.warning_items,
        failed_items: counts.failed_items,
        created_at: timestamp(job.createdAt),
        updated_at: timestamp(job.updatedAt)
      };
    })
  };
}
