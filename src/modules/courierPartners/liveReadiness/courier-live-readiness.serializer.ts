import type { CourierProviderCredential, CourierProviderReadinessProbe } from "@prisma/client";
import { getCourierLiveProviderDefinition } from "./courier-live-readiness.providers.js";
import type {
  CourierLiveCredentialSummary,
  CourierLiveProbeResult,
  CourierLiveProviderKey,
  CourierLiveProviderSummary,
  CourierLiveReadinessBlocker,
  CourierLiveReadinessMode,
  CourierLiveReadinessStatus
} from "./courier-live-readiness.types.js";

const unsafeKeyPattern = /secret|token|password|credential_ref|credentialRef|authorization|cookie|headers|raw|api[_-]?key|private|hash|provider_payload|provider_response|awb|label|manifest/i;
const unsafeStringPattern = /bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|password|private[_-]?key|access[_-]?key/i;

function safeValue(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(safeValue).filter((item) => item !== undefined);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      const next = safeValue(child);
      if (next !== undefined) output[key] = next;
    }
    return output;
  }
  if (typeof value === "string") {
    if (unsafeStringPattern.test(value)) return undefined;
    return value.slice(0, 240);
  }
  return value;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  const safe = safeValue(value);
  return safe && typeof safe === "object" && !Array.isArray(safe) ? safe as Record<string, unknown> : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && !unsafeStringPattern.test(item));
}

function asFieldNameArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(item));
}

export function serializeCourierLiveProvider(providerKey: CourierLiveProviderKey): CourierLiveProviderSummary {
  const definition = getCourierLiveProviderDefinition(providerKey);
  return {
    provider_key: definition.providerKey,
    label: definition.label,
    required_fields: definition.requiredFields,
    supported_probe_types: definition.supportedProbeTypes,
    supports_awb_label_readiness: definition.supportsAwbLabelReadiness,
    default_live_base_url_configured: Boolean(definition.defaultLiveBaseUrl)
  };
}

export function readinessBlockers(record: CourierProviderCredential | null): CourierLiveReadinessBlocker[] {
  if (!record) return ["LIVE_PROVIDER_CREDENTIALS_MISSING", "LIVE_PROVIDER_TEST_NOT_RUN"];
  const blockers: CourierLiveReadinessBlocker[] = [];
  if (!record.credentialRef) blockers.push("LIVE_PROVIDER_CREDENTIALS_MISSING");
  if (record.status === "REVOKED") blockers.push("LIVE_PROVIDER_SECRET_STORAGE_INVALID");
  if (record.mode !== "LIVE") blockers.push("LIVE_PROVIDER_RUNTIME_DISABLED");
  if (!record.lastTestedAt || !record.lastTestStatus) blockers.push("LIVE_PROVIDER_TEST_NOT_RUN");
  if (record.lastTestStatus && record.lastTestStatus !== "PASS") blockers.push("LIVE_PROVIDER_TEST_FAILED");
  if (record.status !== "ACTIVE") blockers.push("LIVE_PROVIDER_NON_DESTRUCTIVE_PROBE_MISSING");
  return [...new Set(blockers)];
}

export function isCourierCredentialLiveReady(record: CourierProviderCredential | null) {
  return Boolean(record
    && record.mode === "LIVE"
    && record.status === "ACTIVE"
    && record.credentialRef
    && record.lastTestedAt
    && record.lastTestStatus === "PASS");
}

export function serializeCourierCredential(record: CourierProviderCredential): CourierLiveCredentialSummary {
  const definition = getCourierLiveProviderDefinition(record.providerKey as CourierLiveProviderKey);
  const requiredFieldsPresent = asFieldNameArray(record.safeMeta && typeof record.safeMeta === "object"
    ? (record.safeMeta as Record<string, unknown>).required_fields_present
    : []);
  const missingFields = definition.requiredFields.filter((field) => !requiredFieldsPresent.includes(field));
  return {
    credential_id: record.id,
    merchant_id: record.merchantId ?? null,
    provider_key: record.providerKey as CourierLiveProviderKey,
    mode: record.mode as CourierLiveReadinessMode,
    status: record.status as CourierLiveReadinessStatus,
    configured: Boolean(record.credentialRef),
    credential_ref_configured: Boolean(record.credentialRef),
    required_fields: definition.requiredFields,
    required_fields_present: requiredFieldsPresent,
    missing_fields: missingFields,
    safe_meta: safeObject(record.safeMeta),
    last_tested_at: record.lastTestedAt,
    last_test_status: record.lastTestStatus,
    last_test_summary: safeObject(record.lastTestSummary),
    live_ready: isCourierCredentialLiveReady(record),
    blockers: readinessBlockers(record),
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

export function serializeCourierProbe(record: CourierProviderReadinessProbe): CourierLiveProbeResult {
  return {
    probe_id: record.id,
    credential_id: record.credentialId ?? null,
    merchant_id: record.merchantId ?? null,
    provider_key: record.providerKey as CourierLiveProviderKey,
    probe_type: record.probeType as CourierLiveProbeResult["probe_type"],
    mode: record.mode as CourierLiveReadinessMode,
    status: record.status as CourierLiveProbeResult["status"],
    safe_summary: safeObject(record.safeSummary) ?? {},
    warnings: asStringArray(record.warnings),
    errors: asStringArray(record.errors),
    tested_at: record.testedAt
  };
}
