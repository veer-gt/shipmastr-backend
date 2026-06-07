import crypto from "crypto";
import {
  PlatformOrderImportStatus,
  StorePlatform,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import {
  buildRawPayloadPreview,
  serializeNormalizedPlatformOrder
} from "../platform-integrations.serializers.js";
import { mapPlatformOrder } from "../platform-integrations.service.js";
import {
  serializeShopifyOrderImport,
  serializeShopifyOrderPreview,
  serializeShopifyWebhookValidation
} from "./shopify.serializers.js";
import { getShopifyConnectionRecord } from "./shopify-connection.service.js";
import { validateShopifyWebhookFoundation } from "./shopify-webhook-validation.js";
import type {
  ListShopifyRecordsQueryInput,
  ShopifyOrderWebhookInput
} from "./shopify.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function payloadHash(payload: unknown) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload) ?? "null")
    .digest("hex");
}

function webhookValidationFor(input: ShopifyOrderWebhookInput) {
  return input.headers
    ? validateShopifyWebhookFoundation({ headers: input.headers, body: input.payload })
    : serializeShopifyWebhookValidation({
      status: "NOT_CONFIGURED",
      missingHeaders: [],
      hmacConfigured: false
    });
}

function webhookId(input: ShopifyOrderWebhookInput) {
  if (!input.headers) return null;
  const entry = Object.entries(input.headers).find(([key]) => key.toLowerCase() === "x-shopify-webhook-id");
  const value = entry?.[1];
  if (Array.isArray(value)) return String(value[0] ?? "") || null;
  return typeof value === "string" ? value : value === undefined || value === null ? null : String(value);
}

export async function previewShopifyOrderWebhook(
  merchantId: string,
  connectionId: string,
  input: ShopifyOrderWebhookInput,
  client: Db = prisma
) {
  const { connection, state } = await getShopifyConnectionRecord(merchantId, connectionId, client);
  const normalizedOrder = await mapPlatformOrder(StorePlatform.SHOPIFY, input.payload, {
    pickupLocationId: input.pickupLocationId ?? null
  });

  return serializeShopifyOrderPreview({
    connection,
    state,
    normalizedOrder,
    webhookValidation: webhookValidationFor(input)
  });
}

export async function importShopifyOrderWebhookFoundation(
  merchantId: string,
  connectionId: string,
  input: ShopifyOrderWebhookInput,
  client: Db = prisma
) {
  const { connection, state } = await getShopifyConnectionRecord(merchantId, connectionId, client);
  const normalizedOrder = await mapPlatformOrder(StorePlatform.SHOPIFY, input.payload, {
    pickupLocationId: input.pickupLocationId ?? null
  });
  const record = await client.platformOrderImport.create({
    data: {
      connectionId: connection.id,
      merchantId,
      platform: StorePlatform.SHOPIFY,
      externalOrderId: normalizedOrder.externalOrderId,
      externalOrderName: normalizedOrder.externalOrderName,
      status: PlatformOrderImportStatus.MAPPED,
      rawPayloadHash: payloadHash(input.payload),
      rawPayloadPreview: toJson(buildRawPayloadPreview(normalizedOrder)),
      mappingWarnings: toJson(normalizedOrder.mappingWarnings)
    }
  });
  const now = new Date();

  await client.platformConnection.update({
    where: { id: connection.id },
    data: { lastOrderImportAt: now }
  });
  await client.shopifyConnectionState.update({
    where: { connectionId: connection.id },
    data: {
      lastWebhookReceivedAt: now,
      lastOrderWebhookId: webhookId(input)
    }
  });

  return {
    import: serializeShopifyOrderImport(record),
    normalized_order: serializeNormalizedPlatformOrder(normalizedOrder),
    webhook_validation: webhookValidationFor(input),
    order_creation: {
      status: "deferred",
      message: "Shopify order payload mapped and recorded. Full Shipmastr order creation remains behind the seller API foundation."
    },
    connection: {
      connection_id: connection.id,
      shop_domain: state?.shopDomain ?? null
    }
  };
}

export async function listShopifyOrderImports(
  merchantId: string,
  connectionId: string,
  query: ListShopifyRecordsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const { connection } = await getShopifyConnectionRecord(merchantId, connectionId, client);
  const where: Prisma.PlatformOrderImportWhereInput = {
    merchantId,
    connectionId: connection.id,
    platform: StorePlatform.SHOPIFY,
    ...(query.status ? { status: query.status as PlatformOrderImportStatus } : {})
  };
  const [imports, total] = await Promise.all([
    client.platformOrderImport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.platformOrderImport.count({ where })
  ]);

  return {
    imports: imports.map(serializeShopifyOrderImport),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getShopifyOrderImport(
  merchantId: string,
  importId: string,
  client: Db = prisma
) {
  const record = await client.platformOrderImport.findFirst({
    where: { id: importId, merchantId, platform: StorePlatform.SHOPIFY }
  });
  if (!record) throw new HttpError(404, "SHOPIFY_ORDER_IMPORT_NOT_FOUND");
  return serializeShopifyOrderImport(record);
}
