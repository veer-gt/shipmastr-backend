function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

const unsafeKeyPattern = /secret|token|password|encrypted|authorization|cookie|headers|raw|api[_-]?key|consumer/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|sk_live|sk_test|whsec_|token|secret/i;

export function sanitizeImportPreview(value: unknown): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(sanitizeImportPreview);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      safe[key] = sanitizeImportPreview(child);
    }
    return safe;
  }
  if (typeof value === "string" && unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

export function serializePlatformImportItem(record: {
  id: string;
  jobId: string;
  connectionId: string;
  platform: string;
  externalOrderId?: string | null;
  externalOrderName?: string | null;
  payloadHash?: string | null;
  status: string;
  orderImportId?: string | null;
  normalizedOrderId?: string | null;
  attemptCount?: number | null;
  lastAttemptAt?: Date | string | null;
  nextAttemptAt?: Date | string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  mappingWarnings?: unknown;
  safePayloadPreview?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    item_id: record.id,
    job_id: record.jobId,
    connection_id: record.connectionId,
    platform: record.platform,
    external_order_id: record.externalOrderId ?? null,
    external_order_name: record.externalOrderName ?? null,
    payload_hash: record.payloadHash ?? null,
    status: record.status,
    order_import_id: record.orderImportId ?? null,
    normalized_order_id: record.normalizedOrderId ?? null,
    attempt_count: record.attemptCount ?? 0,
    last_attempt_at: timestamp(record.lastAttemptAt),
    next_attempt_at: timestamp(record.nextAttemptAt),
    error_code: record.errorCode ?? null,
    error_message: record.errorMessage ?? null,
    mapping_warnings: sanitizeImportPreview(record.mappingWarnings) ?? [],
    safe_payload_preview: sanitizeImportPreview(record.safePayloadPreview),
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializePlatformImportJob(record: {
  id: string;
  connectionId: string;
  platform: string;
  mode: string;
  source: string;
  status: string;
  requestedBy?: string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  totalItems?: number | null;
  mappedItems?: number | null;
  importedItems?: number | null;
  skippedItems?: number | null;
  duplicateItems?: number | null;
  failedItems?: number | null;
  warningCount?: number | null;
  safeSummary?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    job_id: record.id,
    connection_id: record.connectionId,
    platform: record.platform,
    mode: record.mode,
    source: record.source,
    status: record.status,
    requested_by: record.requestedBy ?? null,
    started_at: timestamp(record.startedAt),
    completed_at: timestamp(record.completedAt),
    cancelled_at: timestamp(record.cancelledAt),
    total_items: record.totalItems ?? 0,
    mapped_items: record.mappedItems ?? 0,
    imported_items: record.importedItems ?? 0,
    skipped_items: record.skippedItems ?? 0,
    duplicate_items: record.duplicateItems ?? 0,
    failed_items: record.failedItems ?? 0,
    warning_count: record.warningCount ?? 0,
    safe_summary: sanitizeImportPreview(record.safeSummary),
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializePlatformImportJobWithItems(job: Parameters<typeof serializePlatformImportJob>[0], items: Parameters<typeof serializePlatformImportItem>[0][]) {
  return {
    job: serializePlatformImportJob(job),
    items: items.map(serializePlatformImportItem)
  };
}

export function serializePlatformImportCursor(record: {
  id: string;
  connectionId: string;
  platform: string;
  cursor?: string | null;
  page?: number | null;
  since?: Date | string | null;
  status: string;
  lastJobId?: string | null;
  hasMore?: boolean | null;
  warningCount?: number | null;
  errorCount?: number | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    cursor_id: record.id,
    connection_id: record.connectionId,
    platform: record.platform,
    next_cursor: record.cursor ?? null,
    page: record.page ?? null,
    since: timestamp(record.since),
    status: record.status,
    last_job_id: record.lastJobId ?? null,
    has_more: Boolean(record.hasMore),
    warning_count: record.warningCount ?? 0,
    error_count: record.errorCount ?? 0,
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializePlatformImportProgress(input: {
  job: Parameters<typeof serializePlatformImportJob>[0];
  cursor?: Parameters<typeof serializePlatformImportCursor>[0] | null;
  progress: {
    processed_items: number;
    total_items: number;
    progress_percent: number;
    has_more: boolean;
    next_cursor?: string | null;
    next_page_ready: boolean;
    rate_limit_warning?: string | null;
  };
}) {
  return {
    job: serializePlatformImportJob(input.job),
    cursor: input.cursor ? serializePlatformImportCursor(input.cursor) : null,
    progress: sanitizeImportPreview(input.progress) as typeof input.progress
  };
}
