import type {
  CourierPickupServiceabilityResult,
  CourierPickupTrialResult
} from "./courier-pickup-serviceability.types.js";

const unsafeStringPattern = /shiprocket|shipmozo|bigship|provider courier|provider pickup|authorization|bearer|token|secret|password|rawpayload|rawheaders|rawresponse/i;

function safeString(value: string | null | undefined) {
  if (!value) return value ?? null;
  return unsafeStringPattern.test(value) ? "Shipmastr Courier Network" : value.slice(0, 240);
}

function safeList(values: string[]) {
  return [...new Set(values.map((value) => safeString(value)).filter((value): value is string => Boolean(value)))];
}

export function serializeCourierPickupServiceability(result: CourierPickupServiceabilityResult) {
  return {
    public_network_name: "Shipmastr Courier Network",
    shipment_id: result.shipment_id,
    pickup_location_id: result.pickup_location_id,
    pickup_pincode: result.pickup_pincode,
    delivery_pincode: result.delivery_pincode,
    status: result.status,
    latest_rate_context: result.latest_rate_context,
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    next_actions: safeList(result.next_actions),
    seller_safe_message: safeString(result.seller_safe_message),
    recommended_action: result.recommended_action
  };
}

export function serializeCourierPickupTrial(result: CourierPickupTrialResult) {
  return {
    shipment_id: result.shipment_id,
    public_network_name: "Shipmastr Courier Network",
    pickups: result.pickups.map((pickup) => ({
      pickup_location_id: pickup.pickup_location_id,
      name: safeString(pickup.name),
      city: safeString(pickup.city),
      state: safeString(pickup.state),
      pincode: pickup.pincode,
      active: pickup.active,
      selected: pickup.selected,
      status: pickup.status,
      blockers: safeList(pickup.blockers),
      seller_safe_message: safeString(pickup.seller_safe_message)
    })),
    recommendation: {
      action: result.recommendation.action,
      pickup_location_id: result.recommendation.pickup_location_id,
      reason: safeString(result.recommendation.reason)
    }
  };
}
