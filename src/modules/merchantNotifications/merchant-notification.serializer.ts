const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|consumer|hash|provider|courier/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|bigship/i;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

export function sanitizeNotificationMeta(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeNotificationMeta);
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      safe[key] = sanitizeNotificationMeta(child);
    }
    return safe;
  }
  if (typeof value === "string" && unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

export function serializeMerchantNotification(record: {
  id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  message: string;
  actionLabel?: string | null;
  actionUrl?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceMeta?: unknown;
  readAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    notification_id: record.id,
    type: record.type,
    severity: record.severity,
    status: record.status,
    title: record.title,
    message: record.message,
    action_label: record.actionLabel ?? null,
    action_url: record.actionUrl ?? null,
    source_type: record.sourceType ?? null,
    source_id: record.sourceId ?? null,
    source_meta: sanitizeNotificationMeta(record.sourceMeta),
    read_at: timestamp(record.readAt),
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializeMerchantNotificationPreference(record: {
  inAppEnabled: boolean;
  importFailedEnabled: boolean;
  needsReviewEnabled: boolean;
  duplicateEnabled: boolean;
  conversionBlockedEnabled: boolean;
  digestEnabled: boolean;
  emailEnabled: boolean;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    in_app_enabled: record.inAppEnabled,
    import_failed_enabled: record.importFailedEnabled,
    needs_review_enabled: record.needsReviewEnabled,
    duplicate_enabled: record.duplicateEnabled,
    conversion_blocked_enabled: record.conversionBlockedEnabled,
    digest_enabled: record.digestEnabled,
    email_enabled: record.emailEnabled,
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}
