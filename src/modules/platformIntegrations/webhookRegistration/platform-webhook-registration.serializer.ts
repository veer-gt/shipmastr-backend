const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|consumer|hash|provider_payload|provider_response|courier|bigship|external_webhook_id/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|bigship/i;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

export function sanitizeWebhookRegistrationValue(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeWebhookRegistrationValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      output[key] = sanitizeWebhookRegistrationValue(child);
    }
    return output;
  }
  if (typeof value === "string" && unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

export function serializePlatformWebhookRegistration(record: {
  id: string;
  merchantId?: string | null;
  connectionId: string;
  platform: string;
  topic: string;
  callbackUrlSafe: string;
  status: string;
  registeredAt?: Date | string | null;
  disabledAt?: Date | string | null;
  safeMeta?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  const safeMeta = sanitizeWebhookRegistrationValue(record.safeMeta) as Record<string, unknown> | null;
  return {
    registration_id: record.id,
    merchant_id: record.merchantId ?? null,
    connection_id: record.connectionId,
    platform: record.platform,
    topic: record.topic,
    callback_url_safe: record.callbackUrlSafe,
    status: record.status,
    mode: safeMeta?.mode ?? "DRY_RUN",
    provider_topic: safeMeta?.provider_topic ?? null,
    live_registration_performed: false,
    registered_at: timestamp(record.registeredAt),
    disabled_at: timestamp(record.disabledAt),
    safe_meta: safeMeta ?? {},
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializeWebhookRegistrationReadiness(input: {
  status: "READY" | "DISABLED" | "BLOCKED";
  ready: boolean;
  runtime: unknown;
  blockers: string[];
  warnings: string[];
}) {
  return sanitizeWebhookRegistrationValue({
    status: input.status,
    ready: input.ready,
    runtime: input.runtime,
    blockers: input.blockers,
    warnings: input.warnings
  });
}
