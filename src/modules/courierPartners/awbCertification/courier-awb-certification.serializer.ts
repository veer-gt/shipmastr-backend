import type {
  CourierAwbCertificationDryRunResult,
  CourierAwbCertificationLiveOneShotResult,
  CourierAwbCertificationProviderStatus
} from "./courier-awb-certification.types.js";

const unsafeStringPattern = /shiprocket|shipmozo|bigship|provider courier|provider pickup|provider[_-]?courier|provider[_-]?pickup|authorization|bearer|token|secret|password|rawpayload|rawheaders|rawresponse|credential|api[_-]?key/i;

function safeString(value: string | null | undefined) {
  if (!value) return value ?? null;
  return unsafeStringPattern.test(value) ? "Shipmastr Courier Network" : value.slice(0, 240);
}

function safeList(values: string[]) {
  return [...new Set(values.map((value) => safeString(value)).filter((value): value is string => Boolean(value)))];
}

export function serializeCourierAwbCertificationSellerSafe(result: CourierAwbCertificationDryRunResult) {
  return {
    public_network_name: "Shipmastr Courier Network",
    shipment_id: result.shipment_id,
    pickup_location_id: result.pickup_location_id,
    requested_tier: result.requested_tier,
    dry_run_ready: result.dry_run_ready,
    live_one_shot_ready: result.live_one_shot_ready,
    status: result.status,
    payload_readiness: result.payload_readiness,
    live_gate_readiness: result.live_gate_readiness,
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message),
    next_actions: safeList(result.admin_next_actions)
  };
}

export function serializeCourierAwbCertificationAdmin(result: CourierAwbCertificationDryRunResult) {
  return {
    provider_key: result.provider_key,
    public_network_name: result.public_network_name,
    shipment_id: result.shipment_id,
    pickup_location_id: result.pickup_location_id,
    requested_tier: result.requested_tier,
    dry_run_ready: result.dry_run_ready,
    live_one_shot_ready: result.live_one_shot_ready,
    status: result.status,
    payload_readiness: result.payload_readiness,
    live_gate_readiness: result.live_gate_readiness,
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message),
    admin_next_actions: safeList(result.admin_next_actions),
    seller_safe: serializeCourierAwbCertificationSellerSafe(result)
  };
}

export function serializeCourierAwbCertificationProviderStatus(status: CourierAwbCertificationProviderStatus) {
  return {
    provider_key: status.provider_key,
    public_network_name: status.public_network_name,
    sandbox_available: status.sandbox_available,
    status: status.status,
    awb_dimension_status: status.awb_dimension_status,
    can_use_for_awb: status.can_use_for_awb,
    blockers: safeList(status.blockers),
    warnings: safeList(status.warnings),
    next_actions: safeList(status.next_actions)
  };
}

export function serializeCourierAwbCertificationLiveOneShot(result: CourierAwbCertificationLiveOneShotResult) {
  return {
    success: result.success,
    provider_key: result.provider_key,
    public_network_name: result.public_network_name,
    shipment_id: result.shipment_id,
    public_awb_status: result.public_awb_status,
    shipmastr_awb_number: result.shipmastr_awb_number,
    label_ready: result.label_ready,
    tracking_ready: result.tracking_ready,
    certification_status: result.certification_status,
    blockers: safeList(result.blockers),
    warnings: safeList(result.warnings),
    seller_safe_message: safeString(result.seller_safe_message),
    admin_next_actions: safeList(result.admin_next_actions),
    seller_safe: {
      public_network_name: "Shipmastr Courier Network",
      shipment_id: result.shipment_id,
      public_awb_status: result.public_awb_status,
      shipmastr_awb_number: result.shipmastr_awb_number,
      label_ready: result.label_ready,
      tracking_ready: result.tracking_ready,
      certification_status: result.certification_status,
      blockers: safeList(result.blockers),
      warnings: safeList(result.warnings),
      seller_safe_message: safeString(result.seller_safe_message)
    }
  };
}
