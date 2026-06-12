import type {
  CourierCertificationSnapshot,
  CourierCertificationSummary,
  SellerSafeCourierAvailability
} from "./courier-certification.types.js";

const unsafeKeyPattern = /secret|token|password|credential|authorization|cookie|headers|raw|api[_-]?key|private|hash|provider_payload|provider_response|provider_ref|providerPickupId|providerCourierId|courier_id|courierId/i;
const unsafeStringPattern = /bearer\s+|basic\s+|token|secret|password|private[_-]?key|access[_-]?key|vault:|shiprocket|shipmozo|bigship|blue dart|provider courier id|provider pickup id/i;

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

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 160)))];
}

export function serializeCourierCertificationSnapshot(snapshot: CourierCertificationSnapshot): CourierCertificationSnapshot {
  return {
    provider_key: snapshot.provider_key,
    provider_label_internal: snapshot.provider_label_internal,
    public_network_name: "Shipmastr Courier Network",
    status: snapshot.status,
    live_ready: snapshot.live_ready,
    can_use_for_rates: snapshot.can_use_for_rates,
    can_use_for_awb: snapshot.can_use_for_awb,
    can_use_for_label: snapshot.can_use_for_label,
    can_use_for_tracking: snapshot.can_use_for_tracking,
    dimensions: snapshot.dimensions.map((dimension) => ({
      key: dimension.key,
      status: dimension.status,
      blockers: uniqueStrings(dimension.blockers),
      warnings: uniqueStrings(dimension.warnings),
      safe_summary: (safeValue(dimension.safe_summary) ?? {}) as Record<string, unknown>
    })),
    blockers: uniqueStrings(snapshot.blockers),
    warnings: uniqueStrings(snapshot.warnings),
    next_actions: uniqueStrings(snapshot.next_actions),
    checked_at: snapshot.checked_at
  };
}

export function serializeCourierCertificationSummary(summary: CourierCertificationSummary): CourierCertificationSummary {
  return {
    merchant_id: summary.merchant_id,
    public_network_name: "Shipmastr Courier Network",
    checked_at: summary.checked_at,
    providers: summary.providers.map(serializeCourierCertificationSnapshot),
    counts: summary.counts,
    blockers: uniqueStrings(summary.blockers),
    warnings: uniqueStrings(summary.warnings),
    next_actions: uniqueStrings(summary.next_actions)
  };
}

export function sellerSafeCourierAvailability(input: {
  blocked?: boolean;
  checking?: boolean;
  support?: boolean;
  pickupIssue?: boolean;
}): SellerSafeCourierAvailability {
  if (input.support) {
    return {
      status: "CONTACT_SUPPORT",
      message: "Contact support.",
      next_actions: ["Contact support."]
    };
  }
  if (input.checking) {
    return {
      status: "CHECKING",
      message: "Shipmastr is checking courier availability.",
      next_actions: ["Try again shortly."]
    };
  }
  if (input.blocked || input.pickupIssue) {
    return {
      status: "TEMPORARILY_UNAVAILABLE",
      message: "Shipping option is temporarily unavailable for this pickup.",
      next_actions: ["Try another pickup location.", "Contact support."]
    };
  }
  return {
    status: "AVAILABLE",
    message: "Shipmastr Courier Network is available.",
    next_actions: []
  };
}
