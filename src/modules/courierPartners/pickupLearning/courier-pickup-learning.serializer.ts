import type {
  CourierPickupLearningClassification,
  CourierPickupLearningProviderSummary
} from "./courier-pickup-learning.types.js";

const unsafeStringPattern = /shiprocket|shipmozo|bigship|authorization|bearer|token|secret|password|rawpayload|rawheaders|rawresponse|provider courier|provider pickup/i;

function safeString(value: string | null | undefined) {
  if (!value) return value ?? null;
  return unsafeStringPattern.test(value) ? "Shipmastr Courier Network" : value.slice(0, 240);
}

export function serializeCourierPickupLearningClassification(input: CourierPickupLearningClassification) {
  return {
    provider_key: input.provider_key,
    pickup_pincode: input.pickup_pincode,
    delivery_pincode: input.delivery_pincode,
    status: input.status,
    availability_score: input.availability_score,
    observation_count: input.observation_count,
    pickup_available_count: input.pickup_available_count,
    pickup_unavailable_count: input.pickup_unavailable_count,
    delivery_available_count: input.delivery_available_count,
    latest_observed_at: input.latest_observed_at,
    recommendation: input.recommendation,
    seller_safe_message: safeString(messageFor(input))
  };
}

export function serializeCourierPickupLearningProvider(input: CourierPickupLearningProviderSummary) {
  return {
    provider_key: input.provider_key,
    public_network_name: "Shipmastr Courier Network",
    status: input.status,
    availability_score: input.availability_score,
    observation_count: input.observation_count,
    pickup_count: input.pickup_count,
    unavailable_pickup_count: input.unavailable_pickup_count,
    latest_observed_at: input.latest_observed_at,
    recommendation: input.recommendation,
    pickups: input.pickups.map(serializeCourierPickupLearningClassification)
  };
}

export function serializeCourierPickupLearningProviders(input: { providers: CourierPickupLearningProviderSummary[] }) {
  return {
    providers: input.providers.map(serializeCourierPickupLearningProvider)
  };
}

function messageFor(input: CourierPickupLearningClassification) {
  if (input.status === "HEALTHY") return "This pickup has recent successful Shipmastr shipping observations.";
  if (input.status === "DEGRADED") return "This pickup has mixed availability. Refresh rates before shipping.";
  if (input.status === "UNAVAILABLE") return "This pickup has repeated unavailable observations. Try another pickup location.";
  return "No pickup learning is available yet. Run a controlled rate refresh.";
}
