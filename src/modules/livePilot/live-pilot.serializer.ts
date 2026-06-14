import type {
  LivePilotCapability,
  LivePilotCapabilitySummary,
  LivePilotMerchantSummary,
  LivePilotReadinessSnapshot,
  LivePilotStatus
} from "./live-pilot.types.js";
import { LIVE_PILOT_CAPABILITIES } from "./live-pilot.types.js";

const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|consumer|hash|provider|courier/i;
const unsafeStringPattern = /shpat_|ck_|cs_|magentotoken_|bearer\s+|basic\s+|sk_live|sk_test|whsec_|token|secret|bigship/i;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

export function sanitizeLivePilotMeta(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeLivePilotMeta);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeKeyPattern.test(key)) continue;
      output[key] = sanitizeLivePilotMeta(child);
    }
    return output;
  }
  if (typeof value === "string" && unsafeStringPattern.test(value)) return "[redacted]";
  return value;
}

export function serializeLivePilotMerchant(record: {
  merchantId: string;
  status: string;
  notes?: string | null;
  enabledAt?: Date | string | null;
  disabledAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}): LivePilotMerchantSummary {
  return {
    merchant_id: record.merchantId,
    status: record.status as LivePilotStatus,
    notes: record.notes ?? null,
    enabled_at: timestamp(record.enabledAt),
    disabled_at: timestamp(record.disabledAt),
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializeLivePilotCapability(record: {
  capability: string;
  status: string;
  approvalId?: string | null;
  notes?: string | null;
  enabledAt?: Date | string | null;
  disabledAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}): LivePilotCapabilitySummary {
  return {
    capability: record.capability as LivePilotCapability,
    status: record.status as LivePilotStatus,
    approval_id: record.approvalId ?? null,
    notes: record.notes ?? null,
    enabled_at: timestamp(record.enabledAt),
    disabled_at: timestamp(record.disabledAt),
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializeLivePilotApproval(record: {
  id: string;
  merchantId?: string | null;
  approvalType: string;
  status: string;
  approvedBy?: string | null;
  approvedAt?: Date | string | null;
  revokedBy?: string | null;
  revokedAt?: Date | string | null;
  reason?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    approval_id: record.id,
    merchant_id: record.merchantId ?? null,
    approval_type: record.approvalType,
    status: record.status,
    approved_by: record.approvedBy ? "recorded" : null,
    approved_at: timestamp(record.approvedAt),
    revoked_by: record.revokedBy ? "recorded" : null,
    revoked_at: timestamp(record.revokedAt),
    reason: record.reason ?? null,
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializeLivePilotAuditLog(record: {
  id: string;
  merchantId?: string | null;
  action: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  safeMeta?: unknown;
  createdAt?: Date | string | null;
}) {
  return {
    audit_log_id: record.id,
    merchant_id: record.merchantId ?? null,
    action: record.action,
    actor: record.actorId ? "recorded" : null,
    target_type: record.targetType ?? null,
    target_id: record.targetId ?? null,
    safe_meta: sanitizeLivePilotMeta(record.safeMeta ?? {}),
    created_at: timestamp(record.createdAt)
  };
}

export function serializeLivePilotReadiness(snapshot: LivePilotReadinessSnapshot) {
  return {
    merchant_id: snapshot.merchantId,
    allowlisted: snapshot.allowlisted,
    merchant_status: snapshot.merchantStatus,
    enabled_capabilities: snapshot.enabledCapabilities,
    approved_capabilities: snapshot.approvedCapabilities,
    pending_capabilities: snapshot.pendingCapabilities,
    disabled_capabilities: snapshot.disabledCapabilities,
    rollback_ready: snapshot.rollbackReady,
    blockers: snapshot.blockers
  };
}

export function defaultCapabilityRows(existing: LivePilotCapabilitySummary[]) {
  const byCapability = new Map(existing.map((capability) => [capability.capability, capability]));
  return LIVE_PILOT_CAPABILITIES.map((capability) => byCapability.get(capability) ?? {
    capability,
    status: "DISABLED" as LivePilotStatus,
    approval_id: null,
    notes: null,
    enabled_at: null,
    disabled_at: null,
    created_at: null,
    updated_at: null
  });
}
