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

export function serializeMagentoConnection(
  connection: Parameters<typeof serializePlatformConnection>[0],
  state: {
    baseUrl: string;
    storeViewCode?: string | null;
    websiteCode?: string | null;
    apiVersion?: string | null;
    installMode: string;
    webhookStatus: string;
    lastWebhookReceivedAt?: Date | string | null;
    lastOrderWebhookId?: string | null;
    lastShippingSyncAttemptAt?: Date | string | null;
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
  } | null
) {
  const base = serializePlatformConnection(connection);
  return {
    ...base,
    magento: state ? {
      base_url: state.baseUrl,
      store_view_code: state.storeViewCode ?? null,
      website_code: state.websiteCode ?? null,
      api_version: state.apiVersion ?? null,
      install_mode: state.installMode,
      webhook_status: state.webhookStatus,
      last_webhook_received_at: timestamp(state.lastWebhookReceivedAt),
      last_order_webhook_id: state.lastOrderWebhookId ?? null,
      last_shipping_sync_attempt_at: timestamp(state.lastShippingSyncAttemptAt),
      state_created_at: timestamp(state.createdAt),
      state_updated_at: timestamp(state.updatedAt)
    } : null
  };
}

export function serializeMagentoOrderPreview(input: {
  connection: Parameters<typeof serializePlatformConnection>[0];
  state: Parameters<typeof serializeMagentoConnection>[1];
  normalizedOrder: NormalizedPlatformOrder;
  webhookValidation?: unknown;
}) {
  return {
    connection: serializeMagentoConnection(input.connection, input.state),
    normalized_order: serializeNormalizedPlatformOrder(input.normalizedOrder),
    mapping_warnings: input.normalizedOrder.mappingWarnings,
    webhook_validation: input.webhookValidation ?? null,
    will_create_shipmastr_order: false,
    will_create_shipment: false
  };
}

export function serializeMagentoOrderImport(record: Parameters<typeof serializePlatformOrderImport>[0]) {
  return serializePlatformOrderImport(record);
}

export function serializeMagentoShippingSync(record: Parameters<typeof serializePlatformTrackingSync>[0]) {
  return {
    ...serializePlatformTrackingSync(record),
    carrier_title: "Shipmastr",
    external_delivery: "simulation_only"
  };
}

export function serializeMagentoWebhookValidation(result: {
  status: "VALID" | "INVALID" | "NOT_CONFIGURED";
  missingHeaders: string[];
  topic?: string | null;
  event?: string | null;
  store?: string | null;
  webhookId?: string | null;
  signatureConfigured: boolean;
}) {
  return {
    status: result.status,
    missing_headers: result.missingHeaders,
    topic: result.topic ?? null,
    event: result.event ?? null,
    store: result.store ?? null,
    webhook_id: result.webhookId ?? null,
    signature_configured: result.signatureConfigured
  };
}
