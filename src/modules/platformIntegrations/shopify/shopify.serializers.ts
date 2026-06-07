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

export function serializeShopifyConnection(
  connection: Parameters<typeof serializePlatformConnection>[0],
  state: {
    shopDomain: string;
    apiVersion?: string | null;
    installMode: string;
    webhookStatus: string;
    lastWebhookReceivedAt?: Date | string | null;
    lastOrderWebhookId?: string | null;
    lastFulfillmentSyncAttemptAt?: Date | string | null;
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
  } | null
) {
  const base = serializePlatformConnection(connection);
  return {
    ...base,
    shopify: state ? {
      shop_domain: state.shopDomain,
      api_version: state.apiVersion ?? null,
      install_mode: state.installMode,
      webhook_status: state.webhookStatus,
      last_webhook_received_at: timestamp(state.lastWebhookReceivedAt),
      last_order_webhook_id: state.lastOrderWebhookId ?? null,
      last_fulfillment_sync_attempt_at: timestamp(state.lastFulfillmentSyncAttemptAt),
      state_created_at: timestamp(state.createdAt),
      state_updated_at: timestamp(state.updatedAt)
    } : null
  };
}

export function serializeShopifyOrderPreview(input: {
  connection: Parameters<typeof serializePlatformConnection>[0];
  state: Parameters<typeof serializeShopifyConnection>[1];
  normalizedOrder: NormalizedPlatformOrder;
  webhookValidation?: unknown;
}) {
  return {
    connection: serializeShopifyConnection(input.connection, input.state),
    normalized_order: serializeNormalizedPlatformOrder(input.normalizedOrder),
    mapping_warnings: input.normalizedOrder.mappingWarnings,
    webhook_validation: input.webhookValidation ?? null,
    will_create_shipmastr_order: false,
    will_create_shipment: false
  };
}

export function serializeShopifyOrderImport(record: Parameters<typeof serializePlatformOrderImport>[0]) {
  return serializePlatformOrderImport(record);
}

export function serializeShopifyFulfillmentSync(record: Parameters<typeof serializePlatformTrackingSync>[0]) {
  return {
    ...serializePlatformTrackingSync(record),
    tracking_company: "Shipmastr",
    external_delivery: "simulation_only"
  };
}

export function serializeShopifyWebhookValidation(result: {
  status: "VALID" | "INVALID" | "NOT_CONFIGURED";
  missingHeaders: string[];
  topic?: string | null;
  shopDomain?: string | null;
  webhookId?: string | null;
  triggeredAt?: string | null;
  hmacConfigured: boolean;
}) {
  return {
    status: result.status,
    missing_headers: result.missingHeaders,
    topic: result.topic ?? null,
    shop_domain: result.shopDomain ?? null,
    webhook_id: result.webhookId ?? null,
    triggered_at: result.triggeredAt ?? null,
    hmac_configured: result.hmacConfigured
  };
}
