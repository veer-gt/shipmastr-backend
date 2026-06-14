import type {
  CourierPickupConfirmationResult,
  CourierPickupTrialResult
} from "./courier-pickup-trial.types.js";

const unsafeStringPattern = /shiprocket|shipmozo|bigship|authorization|bearer|token|secret|password|rawpayload|rawheaders|rawresponse|provider courier|provider pickup/i;

function safeString(value: string | null | undefined) {
  if (!value) return value ?? null;
  return unsafeStringPattern.test(value) ? "Shipmastr Courier Network" : value.slice(0, 240);
}

function safeList(values: string[]) {
  return [...new Set(values.map((value) => safeString(value)).filter((value): value is string => Boolean(value)))];
}

export function serializeCourierPickupTrial(result: CourierPickupTrialResult) {
  return {
    trial_id: result.trial_id,
    provider_key: result.provider_key,
    public_network_name: "Shipmastr Courier Network",
    shipment_id: result.shipment_id,
    current_pickup_location_id: result.current_pickup_location_id,
    trial_pickup_location_id: result.trial_pickup_location_id,
    trial_pickup_pincode: result.trial_pickup_pincode,
    delivery_pincode: result.delivery_pincode,
    status: result.status,
    rate_context: result.rate_context,
    public_rate_options: result.public_rate_options.map((option) => ({
      public_service_code: option.public_service_code,
      public_service_name: safeString(option.public_service_name),
      amount_paise: option.amount_paise,
      estimated_delivery_days: option.estimated_delivery_days
    })),
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message),
    admin_next_actions: safeList(result.admin_next_actions)
  };
}

export function serializeCourierPickupConfirmation(result: CourierPickupConfirmationResult) {
  return {
    success: result.success,
    provider_key: result.provider_key,
    public_network_name: "Shipmastr Courier Network",
    shipment_id: result.shipment_id,
    previous_pickup_location_id: result.previous_pickup_location_id,
    confirmed_pickup_location_id: result.confirmed_pickup_location_id,
    confirmed_pickup_pincode: result.confirmed_pickup_pincode,
    status: result.status,
    requires_rate_refresh: result.requires_rate_refresh,
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message),
    admin_next_actions: safeList(result.admin_next_actions)
  };
}
