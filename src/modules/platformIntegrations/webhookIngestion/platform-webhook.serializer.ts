function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|consumer|hash|provider|courier|staged_payload|payload/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|bigship/i;

export function sanitizePlatformWebhookValue(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizePlatformWebhookValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      output[key] = sanitizePlatformWebhookValue(child);
    }
    return output;
  }
  if (typeof value === "string" && unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

export function serializePlatformWebhookEvent(record: {
  id: string;
  connectionId?: string | null;
  platform: string;
  topic: string;
  externalEventId?: string | null;
  status: string;
  receivedAt?: Date | string | null;
  processedAt?: Date | string | null;
  safeSummary?: unknown;
  warnings?: unknown;
  errors?: unknown;
  importJobId?: string | null;
  importItemId?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    event_id: record.id,
    connection_id: record.connectionId ?? null,
    platform: record.platform,
    topic: record.topic,
    external_event_id: record.externalEventId ?? null,
    status: record.status,
    received_at: timestamp(record.receivedAt),
    processed_at: timestamp(record.processedAt),
    safe_summary: sanitizePlatformWebhookValue(record.safeSummary),
    warnings: sanitizePlatformWebhookValue(record.warnings) ?? [],
    errors: sanitizePlatformWebhookValue(record.errors) ?? [],
    import_job_id: record.importJobId ?? null,
    import_item_id: record.importItemId ?? null,
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializePlatformWebhookIngestionResult(input: {
  event: Parameters<typeof serializePlatformWebhookEvent>[0];
  duplicate?: boolean;
  verification?: unknown;
}) {
  const event = serializePlatformWebhookEvent(input.event);
  return {
    event: {
      ...event,
      status: input.duplicate ? "DUPLICATE" : event.status
    },
    duplicate: Boolean(input.duplicate),
    verification: sanitizePlatformWebhookValue(input.verification)
  };
}
