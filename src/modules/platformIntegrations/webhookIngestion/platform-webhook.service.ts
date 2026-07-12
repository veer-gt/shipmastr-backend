import { createHash } from "node:crypto";
import {
  PlatformImportJobMode,
  PlatformImportSource,
  StorePlatform,
  type PlatformConnection,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { createPlatformImportJob } from "../importQueue/platform-import-queue.service.js";
import { validateMagentoWebhookFoundation } from "../magento/magento-webhook-validation.js";
import { validateShopifyWebhookFoundation } from "../shopify/shopify-webhook-validation.js";
import { validateWooCommerceWebhookFoundation } from "../woocommerce/woocommerce-webhook-validation.js";
import { PLATFORM_WEBHOOK_SIGNATURE_PURPOSE } from "../../credentialVault/platform-webhook-credential.crypto.js";
import { resolvePlatformWebhookCredentialCandidates } from "../../credentialVault/platform-webhook-credential.service.js";
import {
  sanitizePlatformWebhookValue,
  serializePlatformWebhookEvent,
  serializePlatformWebhookIngestionResult
} from "./platform-webhook.serializer.js";
import type {
  PlatformWebhookIngestionInput,
  PlatformWebhookStatus,
  PlatformWebhookTopic,
  PlatformWebhookVerifierOptions
} from "./platform-webhook.types.js";
import type { PlatformWebhookEventListQueryInput } from "./platform-webhook.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

function toStoredJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function headerValue(headers: Record<string, unknown>, name: string) {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  const value = entry?.[1];
  if (Array.isArray(value)) return stringValue(value[0]);
  return stringValue(value);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function numberOrNull(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(numeric) ? numeric : null;
}

function bodyHash(input: { platform: StorePlatform; topic: string; payload: unknown }) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

async function findConnection(merchantId: string, connectionId: string, client: Db) {
  const connection = await client.platformConnection.findFirst({
    where: { id: connectionId, merchantId }
  });
  if (!connection) throw new HttpError(404, "PLATFORM_CONNECTION_NOT_FOUND");
  return connection;
}

function assertPlatformMatches(connection: PlatformConnection, platform: StorePlatform) {
  if (connection.platform !== platform) {
    throw new HttpError(400, "PLATFORM_WEBHOOK_CONNECTION_PLATFORM_MISMATCH");
  }
}

function shopifyTopic(headers: Record<string, unknown>): PlatformWebhookTopic {
  const topic = headerValue(headers, "x-shopify-topic").toLowerCase();
  if (["orders/create", "orders/created", "order/create", "order/created"].includes(topic)) return "SHOPIFY_ORDER_CREATED";
  if (["orders/update", "orders/updated", "order/update", "order/updated"].includes(topic)) return "SHOPIFY_ORDER_UPDATED";
  return "UNKNOWN";
}

function wooCommerceTopic(headers: Record<string, unknown>): PlatformWebhookTopic {
  const topic = headerValue(headers, "x-wc-webhook-topic").toLowerCase();
  const resource = headerValue(headers, "x-wc-webhook-resource").toLowerCase();
  const event = headerValue(headers, "x-wc-webhook-event").toLowerCase();
  const combined = `${topic} ${resource}.${event}`;
  if (/order[._/-]?created/.test(combined) || (resource === "order" && event === "created")) return "WOOCOMMERCE_ORDER_CREATED";
  if (/order[._/-]?updated/.test(combined) || (resource === "order" && event === "updated")) return "WOOCOMMERCE_ORDER_UPDATED";
  return "UNKNOWN";
}

function magentoTopic(headers: Record<string, unknown>): PlatformWebhookTopic {
  const topic = headerValue(headers, "x-magento-topic").toLowerCase();
  const event = firstString(
    headerValue(headers, "x-magento-event"),
    headerValue(headers, "x-adobe-commerce-event")
  ).toLowerCase();
  const combined = `${topic} ${event}`;
  if (/order[._/-]?created|sales_order_save_after.*created/.test(combined)) return "MAGENTO_ORDER_CREATED";
  if (/order[._/-]?updated|sales_order_save_after|sales_order_place_after/.test(combined)) return "MAGENTO_ORDER_UPDATED";
  return "UNKNOWN";
}

function normalizeTopic(platform: StorePlatform, headers: Record<string, unknown>) {
  if (platform === StorePlatform.SHOPIFY) return shopifyTopic(headers);
  if (platform === StorePlatform.WOOCOMMERCE) return wooCommerceTopic(headers);
  if (platform === StorePlatform.MAGENTO) return magentoTopic(headers);
  return "UNKNOWN";
}

function externalEventId(platform: StorePlatform, headers: Record<string, unknown>) {
  if (platform === StorePlatform.SHOPIFY) return headerValue(headers, "x-shopify-webhook-id") || null;
  if (platform === StorePlatform.WOOCOMMERCE) {
    return headerValue(headers, "x-wc-webhook-delivery-id") || headerValue(headers, "x-wc-webhook-id") || null;
  }
  if (platform === StorePlatform.MAGENTO) {
    return headerValue(headers, "x-magento-webhook-id") || headerValue(headers, "x-adobe-commerce-webhook-id") || null;
  }
  return null;
}

async function verifierFor(
  merchantId: string,
  platform: StorePlatform,
  connectionId: string,
  headers: Record<string, unknown>,
  payload: unknown,
  rawBody: Buffer | undefined,
  options: PlatformWebhookVerifierOptions,
  client: Db
) {
  const body = rawBody ?? payload;
  const validate = (secret: string | undefined) => {
    if (platform === StorePlatform.SHOPIFY) {
      return validateShopifyWebhookFoundation({ headers, body, secret });
    }
    if (platform === StorePlatform.WOOCOMMERCE) {
      return validateWooCommerceWebhookFoundation({ headers, body, secret });
    }
    return validateMagentoWebhookFoundation({ headers, body, secret });
  };

  const candidates = options.credentialCandidates
    ?? (platform === StorePlatform.SHOPIFY || platform === StorePlatform.WOOCOMMERCE || platform === StorePlatform.MAGENTO
      ? Object.values(await resolvePlatformWebhookCredentialCandidates({
        merchantId,
        connectionId,
        platform: platform as "SHOPIFY" | "WOOCOMMERCE" | "MAGENTO",
        purpose: PLATFORM_WEBHOOK_SIGNATURE_PURPOSE
      }, client)).filter((value): value is string => Boolean(value))
      : []);

  if (!candidates.length) return validate(undefined);
  const results = candidates.map((secret) => validate(secret));
  return results.find((result) => validationStatus(result) === "VALID") ?? results[0];
}

function validationStatus(verification: unknown) {
  const record = asRecord(verification);
  return stringValue(record.status) as "VALID" | "INVALID" | "NOT_CONFIGURED" | "";
}

function eventStatus(topic: PlatformWebhookTopic, verification: unknown): PlatformWebhookStatus {
  const status = validationStatus(verification);
  if (status !== "VALID") return "REJECTED";
  if (topic === "UNKNOWN") return "IGNORED";
  return "VERIFIED";
}

function validationWarnings(topic: PlatformWebhookTopic, verification: unknown) {
  const record = asRecord(verification);
  const missingHeaders = Array.isArray(record.missing_headers) ? record.missing_headers.map(stringValue).filter(Boolean) : [];
  const warnings: string[] = [];
  if (missingHeaders.length) warnings.push("Webhook headers are incomplete.");
  if (validationStatus(verification) === "NOT_CONFIGURED") warnings.push("Connection is not ready for webhook signature verification.");
  if (topic === "UNKNOWN") warnings.push("Webhook topic is not mapped to an order import event yet.");
  return warnings;
}

function validationErrors(verification: unknown) {
  const status = validationStatus(verification);
  if (status === "VALID") return [];
  if (status === "NOT_CONFIGURED") return ["WEBHOOK_SIGNATURE_NOT_CONFIGURED"];
  return ["WEBHOOK_SIGNATURE_INVALID"];
}

function lineItemsPreview(value: unknown) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((raw) => {
    const item = asRecord(raw);
    return {
      name: firstString(item.name, item.title, "Imported item"),
      sku: firstString(item.sku) || null,
      quantity: numberOrNull(item.quantity ?? item.qty_ordered ?? item.qty) ?? 1,
      grams: numberOrNull(item.grams ?? item.weight_grams ?? item.weight) ?? null,
      requires_shipping: item.requires_shipping === false || item.virtual === true ? false : true,
      price: firstString(item.price, item.total, item.base_price) || null
    };
  });
}

function shopifyStagedPayload(payload: Record<string, unknown>) {
  const shipping = asRecord(payload.shipping_address);
  const billing = asRecord(payload.billing_address);
  const customer = asRecord(payload.customer);
  return {
    id: firstString(payload.id, payload.admin_graphql_api_id, payload.order_number),
    name: firstString(payload.name, payload.order_number) || null,
    order_number: firstString(payload.order_number) || null,
    created_at: firstString(payload.created_at) || null,
    updated_at: firstString(payload.updated_at) || null,
    total_price: firstString(payload.total_price, payload.current_total_price) || "0",
    currency: firstString(payload.currency, "INR"),
    financial_status: firstString(payload.financial_status) || null,
    fulfillment_status: firstString(payload.fulfillment_status) || null,
    tags: firstString(payload.tags) || null,
    payment_gateway_names: Array.isArray(payload.payment_gateway_names) ? payload.payment_gateway_names.map(stringValue) : [],
    test: payload.test === true,
    cancelled_at: firstString(payload.cancelled_at) || null,
    customer: {
      first_name: firstString(customer.first_name) || null,
      last_name: firstString(customer.last_name) || null
    },
    shipping_address: {
      name: firstString(shipping.name) || null,
      city: firstString(shipping.city) || null,
      province: firstString(shipping.province, shipping.province_code) || null,
      province_code: firstString(shipping.province_code) || null,
      zip: firstString(shipping.zip, shipping.postal_code) || null,
      country_code: firstString(shipping.country_code) || null,
      country: firstString(shipping.country) || null
    },
    billing_address: {
      name: firstString(billing.name) || null,
      city: firstString(billing.city) || null,
      province: firstString(billing.province, billing.province_code) || null,
      zip: firstString(billing.zip, billing.postal_code) || null,
      country_code: firstString(billing.country_code) || null,
      country: firstString(billing.country) || null
    },
    line_items: lineItemsPreview(payload.line_items)
  };
}

function wooStagedPayload(payload: Record<string, unknown>) {
  const shipping = asRecord(payload.shipping);
  const billing = asRecord(payload.billing);
  return {
    id: firstString(payload.id),
    number: firstString(payload.number) || null,
    date_created: firstString(payload.date_created) || null,
    date_modified: firstString(payload.date_modified) || null,
    status: firstString(payload.status) || null,
    total: firstString(payload.total) || "0",
    currency: firstString(payload.currency, "INR"),
    payment_method: firstString(payload.payment_method) || null,
    payment_method_title: firstString(payload.payment_method_title) || null,
    created_via: firstString(payload.created_via) || null,
    billing: {
      first_name: firstString(billing.first_name) || null,
      last_name: firstString(billing.last_name) || null,
      city: firstString(billing.city) || null,
      state: firstString(billing.state) || null,
      postcode: firstString(billing.postcode) || null,
      country: firstString(billing.country) || null
    },
    shipping: {
      first_name: firstString(shipping.first_name) || null,
      last_name: firstString(shipping.last_name) || null,
      city: firstString(shipping.city) || null,
      state: firstString(shipping.state) || null,
      postcode: firstString(shipping.postcode) || null,
      country: firstString(shipping.country) || null
    },
    line_items: lineItemsPreview(payload.line_items)
  };
}

function magentoStagedPayload(payload: Record<string, unknown>) {
  const billing = asRecord(payload.billing_address);
  const extension = asRecord(payload.extension_attributes);
  const assignment = asRecord(Array.isArray(extension.shipping_assignments) ? extension.shipping_assignments[0] : null);
  const shipping = asRecord(asRecord(assignment.shipping).address);
  const safeShipping = {
    firstname: firstString(shipping.firstname) || null,
    lastname: firstString(shipping.lastname) || null,
    city: firstString(shipping.city) || null,
    region: firstString(shipping.region, shipping.region_code) || null,
    postcode: firstString(shipping.postcode, shipping.postal_code) || null,
    country_id: firstString(shipping.country_id) || null
  };
  const items = lineItemsPreview(payload.items).map((item) => ({
    name: item.name,
    sku: item.sku,
    qty_ordered: item.quantity,
    weight: item.grams,
    price: item.price,
    product_type: "simple"
  }));
  return {
    entity_id: firstString(payload.entity_id, payload.id),
    increment_id: firstString(payload.increment_id) || null,
    created_at: firstString(payload.created_at) || null,
    updated_at: firstString(payload.updated_at) || null,
    status: firstString(payload.status) || null,
    grand_total: firstString(payload.grand_total) || "0",
    order_currency_code: firstString(payload.order_currency_code, "INR"),
    store_name: firstString(payload.store_name, payload.store_code, payload.store_id) || null,
    billing_address: {
      firstname: firstString(billing.firstname) || null,
      lastname: firstString(billing.lastname) || null,
      city: firstString(billing.city) || null,
      region: firstString(billing.region, billing.region_code) || null,
      postcode: firstString(billing.postcode) || null,
      country_id: firstString(billing.country_id) || null
    },
    extension_attributes: {
      shipping_assignments: [{
        shipping: { address: safeShipping },
        items
      }]
    },
    payment: { method: firstString(asRecord(payload.payment).method) || null },
    items
  };
}

function stagedOrderPayload(platform: StorePlatform, payload: unknown) {
  const record = asRecord(payload);
  if (platform === StorePlatform.SHOPIFY) return shopifyStagedPayload(record);
  if (platform === StorePlatform.WOOCOMMERCE) return wooStagedPayload(record);
  return magentoStagedPayload(record);
}

function orderSafePreview(platform: StorePlatform, stagedPayload: Record<string, unknown>) {
  if (platform === StorePlatform.SHOPIFY) {
    const shipping = asRecord(stagedPayload.shipping_address);
    return {
      external_order_id: stagedPayload.id,
      external_order_name: stagedPayload.name,
      city: shipping.city ?? null,
      state: shipping.province ?? null,
      pincode: shipping.zip ?? null,
      country: shipping.country_code ?? shipping.country ?? null,
      total_amount: numberOrNull(stagedPayload.total_price),
      currency: stagedPayload.currency ?? null,
      item_count: Array.isArray(stagedPayload.line_items) ? stagedPayload.line_items.length : 0
    };
  }
  if (platform === StorePlatform.WOOCOMMERCE) {
    const shipping = asRecord(stagedPayload.shipping);
    return {
      external_order_id: stagedPayload.id,
      external_order_name: stagedPayload.number,
      city: shipping.city ?? null,
      state: shipping.state ?? null,
      pincode: shipping.postcode ?? null,
      country: shipping.country ?? null,
      total_amount: numberOrNull(stagedPayload.total),
      currency: stagedPayload.currency ?? null,
      item_count: Array.isArray(stagedPayload.line_items) ? stagedPayload.line_items.length : 0
    };
  }
  const extension = asRecord(stagedPayload.extension_attributes);
  const assignment = asRecord(Array.isArray(extension.shipping_assignments) ? extension.shipping_assignments[0] : null);
  const shipping = asRecord(asRecord(assignment.shipping).address);
  return {
    external_order_id: stagedPayload.entity_id,
    external_order_name: stagedPayload.increment_id,
    city: shipping.city ?? null,
    state: shipping.region ?? null,
    pincode: shipping.postcode ?? null,
    country: shipping.country_id ?? null,
    total_amount: numberOrNull(stagedPayload.grand_total),
    currency: stagedPayload.order_currency_code ?? null,
    item_count: Array.isArray(stagedPayload.items) ? stagedPayload.items.length : 0
  };
}

function safeSummary(platform: StorePlatform, topic: PlatformWebhookTopic, payload: unknown, verification: unknown) {
  const verificationStatus = validationStatus(verification);
  if (verificationStatus !== "VALID" || topic === "UNKNOWN") {
    return {
      platform,
      topic,
      verification_status: verificationStatus,
      raw_payload_stored: false,
      raw_headers_stored: false,
      store_mutation: false,
      order_created: false,
      shipment_created: false
    };
  }
  const stagedPayload = stagedOrderPayload(platform, payload);
  return {
    platform,
    topic,
    verification_status: verificationStatus,
    order_preview: orderSafePreview(platform, stagedPayload),
    staged_payload: stagedPayload,
    raw_payload_stored: false,
    raw_headers_stored: false,
    store_mutation: false,
    order_created: false,
    shipment_created: false
  };
}

function dedupeKey(input: {
  platform: StorePlatform;
  connectionId: string;
  topic: PlatformWebhookTopic;
  externalEventId: string | null;
  eventHash: string;
}) {
  return [
    input.platform,
    input.connectionId,
    input.topic,
    input.externalEventId || input.eventHash
  ].join(":");
}

export async function ingestPlatformWebhookEvent(
  merchantId: string,
  input: PlatformWebhookIngestionInput,
  client: Db = prisma,
  verifierOptions: PlatformWebhookVerifierOptions = {}
) {
  const connection = await findConnection(merchantId, input.connectionId, client);
  assertPlatformMatches(connection, input.platform);
  const topic = normalizeTopic(input.platform, input.headers);
  const verification = await verifierFor(
    merchantId,
    input.platform,
    connection.id,
    input.headers,
    input.payload,
    input.rawBody,
    verifierOptions,
    client
  );
  const status = eventStatus(topic, verification);
  const eventHash = bodyHash({ platform: input.platform, topic, payload: sanitizePlatformWebhookValue(input.payload) });
  const externalId = status === "VERIFIED" ? externalEventId(input.platform, input.headers) : null;
  const key = dedupeKey({
    platform: input.platform,
    connectionId: connection.id,
    topic,
    externalEventId: externalId,
    eventHash
  });

  const existing = await client.platformWebhookEvent.findFirst({
    where: { merchantId, dedupeKey: key }
  });
  if (existing) {
    return serializePlatformWebhookIngestionResult({
      event: existing,
      duplicate: true,
      verification
    });
  }

  const warnings = validationWarnings(topic, verification);
  const errors = validationErrors(verification);
  const event = await client.platformWebhookEvent.create({
    data: {
      merchantId,
      connectionId: connection.id,
      platform: input.platform,
      topic,
      externalEventId: externalId,
      eventHash,
      status,
      safeSummary: toStoredJson(safeSummary(input.platform, topic, input.payload, verification)),
      warnings: toStoredJson(warnings),
      errors: toStoredJson(errors),
      dedupeKey: key
    }
  });

  return serializePlatformWebhookIngestionResult({
    event,
    duplicate: false,
    verification
  });
}

export async function listPlatformWebhookEvents(
  merchantId: string,
  query: PlatformWebhookEventListQueryInput,
  client: Db = prisma
) {
  const where: Prisma.PlatformWebhookEventWhereInput = {
    merchantId,
    ...(query.platform ? { platform: query.platform as StorePlatform } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.connectionId ? { connectionId: query.connectionId } : {}),
    ...(query.topic ? { topic: query.topic } : {})
  };
  const [events, total] = await Promise.all([
    client.platformWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformWebhookEvent.count({ where })
  ]);
  return {
    events: events.map(serializePlatformWebhookEvent),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getPlatformWebhookEvent(merchantId: string, eventId: string, client: Db = prisma) {
  const event = await client.platformWebhookEvent.findFirst({
    where: { id: eventId, merchantId }
  });
  if (!event) throw new HttpError(404, "PLATFORM_WEBHOOK_EVENT_NOT_FOUND");
  return serializePlatformWebhookEvent(event);
}

export async function stagePlatformWebhookEventImport(merchantId: string, eventId: string, client: Db = prisma) {
  const event = await client.platformWebhookEvent.findFirst({
    where: { id: eventId, merchantId }
  });
  if (!event) throw new HttpError(404, "PLATFORM_WEBHOOK_EVENT_NOT_FOUND");
  if (event.status === "STAGED_FOR_IMPORT" && event.importJobId) {
    return {
      event: serializePlatformWebhookEvent(event),
      import_job: null,
      import_items: []
    };
  }
  if (event.status !== "VERIFIED") {
    throw new HttpError(409, "PLATFORM_WEBHOOK_EVENT_NOT_STAGEABLE");
  }
  if (!event.connectionId) {
    throw new HttpError(409, "PLATFORM_WEBHOOK_EVENT_CONNECTION_MISSING");
  }
  const summary = asRecord(event.safeSummary);
  const stagedPayload = asRecord(summary.staged_payload);
  if (!Object.keys(stagedPayload).length) {
    const failed = await client.platformWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: "FAILED",
        processedAt: new Date(),
        errors: toStoredJson(["WEBHOOK_SAFE_PAYLOAD_MISSING"])
      }
    });
    return {
      event: serializePlatformWebhookEvent(failed),
      import_job: null,
      import_items: []
    };
  }

  const staged = await createPlatformImportJob(merchantId, {
    connectionId: event.connectionId,
    mode: PlatformImportJobMode.DRY_RUN,
    source: PlatformImportSource.WEBHOOK_PAYLOAD,
    requestedBy: "platform_webhook_ingestion",
    orders: [stagedPayload]
  }, client);
  const firstItem = staged.items[0] ?? null;
  const updated = await client.platformWebhookEvent.update({
    where: { id: event.id },
    data: {
      status: "STAGED_FOR_IMPORT",
      processedAt: new Date(),
      importJobId: staged.job.job_id,
      importItemId: firstItem?.item_id ?? null,
      safeSummary: toStoredJson({
        ...summary,
        staged_payload: summary.staged_payload,
        import_job_id: staged.job.job_id,
        import_item_id: firstItem?.item_id ?? null,
        order_created: false,
        shipment_created: false,
        store_mutation: false
      })
    }
  });
  return {
    event: serializePlatformWebhookEvent(updated),
    import_job: staged.job,
    import_items: staged.items
  };
}
