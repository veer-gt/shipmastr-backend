import type { NormalizedPlatformOrder } from "./platform-types.js";

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function maskPhone(value: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `ending ${digits.slice(-4)}` : null;
}

export function serializePlatformConnection(connection: {
  id: string;
  platform: string;
  storeName?: string | null;
  storeUrl: string;
  status: string;
  syncDirection: string;
  credentialsRef?: string | null;
  lastOrderImportAt?: Date | string | null;
  lastTrackingSyncAt?: Date | string | null;
  disabledAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    connection_id: connection.id,
    platform: connection.platform,
    store_name: connection.storeName ?? null,
    store_url: connection.storeUrl,
    status: connection.status,
    sync_direction: connection.syncDirection,
    credential_status: connection.credentialsRef ? "configured_placeholder" : "not_configured",
    last_order_import_at: timestamp(connection.lastOrderImportAt),
    last_tracking_sync_at: timestamp(connection.lastTrackingSyncAt),
    disabled_at: timestamp(connection.disabledAt),
    created_at: timestamp(connection.createdAt),
    updated_at: timestamp(connection.updatedAt)
  };
}

export function serializeNormalizedPlatformOrder(order: NormalizedPlatformOrder) {
  return {
    platform: order.platform,
    external_order_id: order.externalOrderId,
    external_order_name: order.externalOrderName,
    order_created_at: order.orderCreatedAt,
    buyer: {
      name: order.buyerName,
      email: order.buyerEmail,
      phone: maskPhone(order.buyerPhone)
    },
    delivery: {
      city: order.shippingAddress.city,
      state: order.shippingAddress.state,
      postal_code: order.shippingAddress.postalCode,
      country: order.shippingAddress.country
    },
    payment_mode: order.paymentMode,
    currency: order.currency,
    order_amount_paise: order.orderAmountPaise,
    cod_amount_paise: order.codAmountPaise,
    dead_weight_grams: order.deadWeightGrams,
    dimensions: order.dimensions,
    tags: order.tags,
    notes: order.notes,
    item_count: order.items.length,
    items: order.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unit_price_paise: item.unitPricePaise,
      weight_grams: item.weightGrams,
      requires_shipping: item.requiresShipping
    })),
    pickup_location_id: order.pickupLocationId,
    raw_source_summary: order.rawSourceSummary,
    mapping_warnings: order.mappingWarnings
  };
}

export function buildRawPayloadPreview(order: NormalizedPlatformOrder) {
  return {
    platform: order.platform,
    external_order_id: order.externalOrderId,
    external_order_name: order.externalOrderName,
    payment_mode: order.paymentMode,
    currency: order.currency,
    order_amount_paise: order.orderAmountPaise,
    item_count: order.items.length,
    destination: {
      city: order.shippingAddress.city,
      state: order.shippingAddress.state,
      postal_code: order.shippingAddress.postalCode,
      country: order.shippingAddress.country
    }
  };
}

export function serializePlatformOrderImport(record: {
  id: string;
  connectionId: string;
  platform: string;
  externalOrderId: string;
  externalOrderName?: string | null;
  status: string;
  normalizedOrderId?: string | null;
  rawPayloadPreview?: unknown;
  mappingWarnings?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    import_id: record.id,
    connection_id: record.connectionId,
    platform: record.platform,
    external_order_id: record.externalOrderId,
    external_order_name: record.externalOrderName ?? null,
    status: record.status,
    normalized_order_id: record.normalizedOrderId ?? null,
    raw_payload_preview: record.rawPayloadPreview ?? null,
    mapping_warnings: record.mappingWarnings ?? [],
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}

export function serializePlatformTrackingSync(record: {
  id: string;
  connectionId: string;
  shipmentId: string;
  platform: string;
  externalOrderId?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  status: string;
  lastAttemptAt?: Date | string | null;
  syncedAt?: Date | string | null;
  errorMessage?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}) {
  return {
    sync_id: record.id,
    connection_id: record.connectionId,
    shipment_id: record.shipmentId,
    platform: record.platform,
    external_order_id: record.externalOrderId ?? null,
    tracking_number: record.trackingNumber ?? null,
    tracking_url: record.trackingUrl ?? null,
    status: record.status,
    last_attempt_at: timestamp(record.lastAttemptAt),
    synced_at: timestamp(record.syncedAt),
    error_message: record.errorMessage ?? null,
    created_at: timestamp(record.createdAt),
    updated_at: timestamp(record.updatedAt)
  };
}
