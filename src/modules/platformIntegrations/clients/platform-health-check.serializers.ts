function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

const unsafeKeyPattern = /secret|token|password|encrypted|raw|authorization|api[_-]?key|consumer/i;

export function sanitizeHealthDetails(value: unknown): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(sanitizeHealthDetails);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      safe[key] = sanitizeHealthDetails(child);
    }
    return safe;
  }
  if (typeof value === "string" && /shpat_|ck_|cs_|magentotoken_|bearer\s+|sk_live|sk_test|whsec_|token|secret/i.test(value)) {
    return "[redacted]";
  }
  return value;
}

export function serializePlatformHealthCheck(record: {
  id: string;
  connectionId: string;
  merchantId?: string;
  platform: string;
  checkType: string;
  status: string;
  message: string;
  safeDetails?: unknown;
  errorCode?: string | null;
  checkedAt?: Date | string | null;
  createdAt?: Date | string | null;
}) {
  return {
    health_check_id: record.id,
    connection_id: record.connectionId,
    platform: record.platform,
    check_type: record.checkType,
    status: record.status,
    message: record.message,
    safe_details: sanitizeHealthDetails(record.safeDetails),
    error_code: record.errorCode ?? null,
    checked_at: timestamp(record.checkedAt),
    created_at: timestamp(record.createdAt)
  };
}

export function serializeLatestPlatformHealth(input: {
  connectionId: string;
  platform: string;
  latest: ReturnType<typeof serializePlatformHealthCheck> | null;
}) {
  return {
    connection_id: input.connectionId,
    platform: input.platform,
    latest_health_check: input.latest,
    status: input.latest?.status ?? "NOT_CONFIGURED",
    message: input.latest?.message ?? "No health check has been run yet."
  };
}
