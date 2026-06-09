import type { EmailDeliveryAttemptSummary, EmailDeliveryReadiness } from "./email-delivery.types.js";

const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|consumer|hash|provider_payload|courier|bigship/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|bigship/i;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

export function sanitizeEmailDeliveryMeta(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeEmailDeliveryMeta);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      output[key] = sanitizeEmailDeliveryMeta(child);
    }
    return output;
  }
  if (typeof value === "string" && unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

export function maskEmailAddress(value?: string | null) {
  const email = String(value || "").trim().toLowerCase();
  const [local, domain] = email.split("@");
  if (!local || !domain || !domain.includes(".")) return "pilot-recipient@masked";
  const [domainName = "masked", ...suffixParts] = domain.split(".");
  const suffix = suffixParts.pop() || "masked";
  return `${local.slice(0, 1)}***@${domainName.slice(0, 1)}***.${suffix}`;
}

export function serializeEmailDeliveryAttempt(record: {
  id: string;
  merchantId?: string | null;
  notificationId?: string | null;
  recipientSafe?: string | null;
  provider: string;
  mode: string;
  status: string;
  subject?: string | null;
  safeMeta?: unknown;
  sentAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}): EmailDeliveryAttemptSummary {
  return {
    attempt_id: record.id,
    merchant_id: record.merchantId ?? null,
    notification_id: record.notificationId ?? null,
    recipient_safe: record.recipientSafe ?? null,
    provider: record.provider,
    mode: record.mode,
    status: record.status,
    subject: record.subject ?? null,
    safe_meta: sanitizeEmailDeliveryMeta(record.safeMeta ?? {}),
    sent_at: timestamp(record.sentAt),
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializeEmailDeliveryReadiness(readiness: EmailDeliveryReadiness) {
  return {
    status: readiness.status,
    ready: readiness.ready,
    message: readiness.message,
    runtime: {
      enabled: readiness.runtime.enabled,
      mode: readiness.runtime.mode,
      provider: readiness.runtime.provider,
      pilot_only: readiness.runtime.pilotOnly,
      provider_configured: readiness.runtime.providerConfigured,
      live_delivery_enabled: readiness.runtime.liveDeliveryEnabled
    },
    preference_email_enabled: readiness.preferenceEmailEnabled,
    pilot: {
      allowlisted: readiness.pilot.allowlisted,
      capability_enabled: readiness.pilot.capabilityEnabled
    },
    blockers: readiness.blockers,
    warnings: readiness.warnings
  };
}
