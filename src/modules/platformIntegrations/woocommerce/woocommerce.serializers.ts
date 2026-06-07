import {
  serializeNormalizedPlatformOrder,
  serializePlatformConnection,
  serializePlatformOrderImport,
  serializePlatformTrackingSync
} from "../platform-integrations.serializers.js";
import type { NormalizedPlatformOrder } from "../platform-types.js";

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

export function serializeWooCommerceConnection(
  connection: Parameters<typeof serializePlatformConnection>[0],
  state: {
    siteUrl: string;
    apiVersion?: string | null;
    installMode: string;
    webhookStatus: string;
    lastWebhookReceivedAt?: Date | string | null;
    lastOrderWebhookId?: string | null;
    lastTrackingSyncAttemptAt?: Date | string | null;
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
  } | null
) {
  const base = serializePlatformConnection(connection);
  return {
    ...base,
    woocommerce: state ? {
      site_url: state.siteUrl,
      api_version: state.apiVersion ?? null,
      install_mode: state.installMode,
      webhook_status: state.webhookStatus,
      last_webhook_received_at: timestamp(state.lastWebhookReceivedAt),
      last_order_webhook_id: state.lastOrderWebhookId ?? null,
      last_tracking_sync_attempt_at: timestamp(state.lastTrackingSyncAttemptAt),
      state_created_at: timestamp(state.createdAt),
      state_updated_at: timestamp(state.updatedAt)
    } : null
  };
}

export function serializeWooCommerceOrderPreview(input: {
  connection: Parameters<typeof serializePlatformConnection>[0];
  state: Parameters<typeof serializeWooCommerceConnection>[1];
  normalizedOrder: NormalizedPlatformOrder;
  webhookValidation?: unknown;
}) {
  return {
    connection: serializeWooCommerceConnection(input.connection, input.state),
    normalized_order: serializeNormalizedPlatformOrder(input.normalizedOrder),
    mapping_warnings: input.normalizedOrder.mappingWarnings,
    webhook_validation: input.webhookValidation ?? null,
    will_create_shipmastr_order: false,
    will_create_shipment: false
  };
}

export function serializeWooCommerceOrderImport(record: Parameters<typeof serializePlatformOrderImport>[0]) {
  return serializePlatformOrderImport(record);
}

export function serializeWooCommerceTrackingSync(record: Parameters<typeof serializePlatformTrackingSync>[0]) {
  return {
    ...serializePlatformTrackingSync(record),
    tracking_provider: "Shipmastr",
    external_delivery: "simulation_only"
  };
}

export function serializeWooCommerceWebhookValidation(result: {
  status: "VALID" | "INVALID" | "NOT_CONFIGURED";
  missingHeaders: string[];
  source?: string | null;
  topic?: string | null;
  resource?: string | null;
  event?: string | null;
  webhookId?: string | null;
  deliveryId?: string | null;
  signatureConfigured: boolean;
}) {
  return {
    status: result.status,
    missing_headers: result.missingHeaders,
    source: result.source ?? null,
    topic: result.topic ?? null,
    resource: result.resource ?? null,
    event: result.event ?? null,
    webhook_id: result.webhookId ?? null,
    delivery_id: result.deliveryId ?? null,
    signature_configured: result.signatureConfigured
  };
}
