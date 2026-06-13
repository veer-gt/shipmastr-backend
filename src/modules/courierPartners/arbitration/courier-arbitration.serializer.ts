import type {
  CourierArbitrationEvaluatedOption,
  CourierArbitrationResult
} from "./courier-arbitration.types.js";

const unsafeStringPattern = /shiprocket|shipmozo|bigship|provider courier|provider pickup|authorization|bearer|token|secret|password|rawpayload|rawheaders|rawresponse|credential|api[_-]?key/i;

function safeString(value: string | null | undefined) {
  if (!value) return value ?? null;
  return unsafeStringPattern.test(value) ? "Shipmastr Courier Network" : value.slice(0, 240);
}

function safeList(values: string[]) {
  return [...new Set(values.map((value) => safeString(value)).filter((value): value is string => Boolean(value)))];
}

function serializeSellerSafeOption(option: CourierArbitrationEvaluatedOption) {
  return {
    pickup_location_id: option.pickup_location_id,
    pickup_pincode: option.pickup_pincode,
    public_network_name: "Shipmastr Courier Network",
    status: option.status,
    seller_safe_message: safeString(option.seller_safe_message)
  };
}

export function serializeCourierArbitrationSellerSafe(result: CourierArbitrationResult) {
  return {
    shipment_id: result.shipment_id,
    requested_capability: result.requested_capability,
    decision: result.decision,
    selected_option: result.selected_option
      ? {
        pickup_location_id: result.selected_option.pickup_location_id ?? null,
        pickup_pincode: result.selected_option.pickup_pincode ?? null,
        public_network_name: "Shipmastr Courier Network",
        public_service_code: result.selected_option.public_service_code ?? null
      }
      : null,
    evaluated_options: result.evaluated_options.map(serializeSellerSafeOption),
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message),
    next_actions: safeList(result.admin_next_actions)
  };
}

export function serializeCourierArbitrationAdmin(result: CourierArbitrationResult) {
  return {
    shipment_id: result.shipment_id,
    requested_capability: result.requested_capability,
    decision: result.decision,
    selected_option: result.selected_option,
    evaluated_options: result.evaluated_options.map((option) => ({
      provider_key_internal: option.provider_key_internal,
      pickup_location_id: option.pickup_location_id,
      pickup_pincode: option.pickup_pincode,
      status: option.status,
      blockers: safeList(option.blockers),
      warnings: safeList(option.warnings),
      seller_safe_message: safeString(option.seller_safe_message)
    })),
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message),
    admin_next_actions: safeList(result.admin_next_actions),
    seller_safe: serializeCourierArbitrationSellerSafe(result)
  };
}
