import type {
  CourierReadinessAutopilotProviderList,
  CourierReadinessAutopilotProviderResult
} from "./courier-readiness-autopilot.types.js";

const unsafeStringPattern = /shiprocket|shipmozo|bigship|blue dart|provider pickup id|provider order id|provider shipment id|provider raw|authorization|bearer|token|secret|password|credential ref|credential|api[_-]?key|one-shot token/i;

function safeString(value: string | null | undefined) {
  if (!value) return value ?? null;
  return unsafeStringPattern.test(value) ? "Shipmastr Courier Network" : value.slice(0, 240);
}

function safeList(values: string[]) {
  return [...new Set(values
    .map((value) => safeString(value))
    .filter((value): value is string => Boolean(value)))];
}

export function serializeCourierReadinessAutopilotProvider(
  provider: CourierReadinessAutopilotProviderResult
): CourierReadinessAutopilotProviderResult {
  return {
    provider_key_internal: provider.provider_key_internal,
    public_network_name: "Shipmastr Courier Network",
    lifecycle_state: provider.lifecycle_state,
    capabilities: provider.capabilities,
    blockers: safeList(provider.blockers),
    warnings: safeList(provider.warnings),
    next_safe_action: provider.next_safe_action,
    admin_next_actions: safeList(provider.admin_next_actions),
    seller_safe_message: safeString(provider.seller_safe_message) ?? "Shipmastr is keeping this shipment in safe review.",
    requested_capability: provider.requested_capability,
    shipment_id: provider.shipment_id,
    checked_at: provider.checked_at
  };
}

export function serializeCourierReadinessAutopilotList(
  list: CourierReadinessAutopilotProviderList
): CourierReadinessAutopilotProviderList {
  return {
    public_network_name: "Shipmastr Courier Network",
    shipment_id: list.shipment_id,
    requested_capability: list.requested_capability,
    checked_at: list.checked_at,
    providers: list.providers.map(serializeCourierReadinessAutopilotProvider),
    counts: list.counts,
    blockers: safeList(list.blockers),
    warnings: safeList(list.warnings),
    next_safe_actions: list.next_safe_actions
  };
}
