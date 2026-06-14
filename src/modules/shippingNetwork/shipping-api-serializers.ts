function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function maskPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? `ending ${digits.slice(-4)}` : null;
}

const blockedKeys = new Set([
  "keyHash",
  "secretHash",
  "providerResponseJson",
  "providerErrorJson",
  "rawProviderJson",
  "rawPayload",
  "courierOverride",
  "internalNotes",
  "providerShipmentId",
  "providerOrderId",
  "providerPickupId",
  "providerActionRef",
  "providerStatus",
  "providerRef",
  "addressLine1",
  "addressLine2",
  "line1",
  "line2"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function redactSellerApiPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSellerApiPayload);
  if (!isRecord(value)) return value;

  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (blockedKeys.has(key)) continue;
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes("secret") || lowerKey.includes("hash")) continue;
    if (lowerKey === "phone" || lowerKey.endsWith("_phone") || lowerKey.endsWith("phone")) {
      safe[key] = typeof child === "string" ? maskPhone(child) : null;
      continue;
    }
    safe[key] = redactSellerApiPayload(child);
  }

  return safe;
}

export function serializeSellerApiKey(key: {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: string;
  lastUsedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  revokedAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}, rawKey?: string | null) {
  return {
    api_key_id: key.id,
    name: key.name,
    key_prefix: key.keyPrefix,
    scopes: key.scopes,
    status: key.status,
    last_used_at: timestamp(key.lastUsedAt),
    expires_at: timestamp(key.expiresAt),
    revoked_at: timestamp(key.revokedAt),
    created_at: timestamp(key.createdAt),
    updated_at: timestamp(key.updatedAt),
    ...(rawKey ? { api_key: rawKey } : {})
  };
}

export function serializeWebhookSubscription(subscription: {
  id: string;
  url: string;
  description?: string | null;
  events: string[];
  status: string;
  failureCount: number;
  lastDeliveredAt?: Date | string | null;
  lastFailedAt?: Date | string | null;
  disabledAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}, rawSecret?: string | null) {
  return {
    subscription_id: subscription.id,
    url: subscription.url,
    description: subscription.description ?? null,
    events: subscription.events,
    status: subscription.status,
    failure_count: subscription.failureCount,
    last_delivered_at: timestamp(subscription.lastDeliveredAt),
    last_failed_at: timestamp(subscription.lastFailedAt),
    disabled_at: timestamp(subscription.disabledAt),
    created_at: timestamp(subscription.createdAt),
    updated_at: timestamp(subscription.updatedAt),
    ...(rawSecret ? { webhook_secret: rawSecret } : {})
  };
}

export function serializeWebhookEvent(event: {
  id: string;
  subscriptionId?: string | null;
  eventType: string;
  payload: unknown;
  status: string;
  attemptCount: number;
  nextAttemptAt?: Date | string | null;
  lastAttemptAt?: Date | string | null;
  deliveredAt?: Date | string | null;
  failedAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    event_id: event.id,
    subscription_id: event.subscriptionId ?? null,
    event_type: event.eventType,
    payload: redactSellerApiPayload(event.payload),
    status: event.status,
    attempt_count: event.attemptCount,
    next_attempt_at: timestamp(event.nextAttemptAt),
    last_attempt_at: timestamp(event.lastAttemptAt),
    delivered_at: timestamp(event.deliveredAt),
    failed_at: timestamp(event.failedAt),
    created_at: timestamp(event.createdAt),
    updated_at: timestamp(event.updatedAt)
  };
}
