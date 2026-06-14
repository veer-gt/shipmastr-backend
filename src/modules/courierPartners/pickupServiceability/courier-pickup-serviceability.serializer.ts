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

function serializePickupLearningForServiceability(result: CourierPickupServiceabilityResult["learning_summary"]) {
  if (!result) return null;
  return {
    status: result.status,
    availability_score: result.availability_score,
    observation_count: result.observation_count,
    pickup_available_count: result.pickup_available_count,
    pickup_unavailable_count: result.pickup_unavailable_count,
    delivery_available_count: result.delivery_available_count,
    latest_observed_at: result.latest_observed_at,
    recommendation: result.recommendation,
    seller_safe_message: safeString(
      result.status === "UNAVAILABLE"
        ? "This pickup has repeated unavailable observations. Try another pickup location."
        : result.status === "HEALTHY"
          ? "This pickup has recent successful Shipmastr shipping observations."
          : "Refresh rates before shipping from this pickup."
    )
  };
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
    recommended_action: result.recommended_action,
    pickup_learning: serializePickupLearningForServiceability(result.learning_summary)
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
