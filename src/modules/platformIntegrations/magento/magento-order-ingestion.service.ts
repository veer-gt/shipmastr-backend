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
  serializeMagentoOrderImport,
  serializeMagentoOrderPreview,
  serializeMagentoWebhookValidation
} from "./magento.serializers.js";
import { getMagentoConnectionRecord } from "./magento-connection.service.js";
import { validateMagentoWebhookFoundation } from "./magento-webhook-validation.js";
import type {
  ListMagentoRecordsQueryInput,
  MagentoOrderWebhookInput
} from "./magento.validation.js";

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

function webhookValidationFor(input: MagentoOrderWebhookInput) {
  return input.headers
    ? validateMagentoWebhookFoundation({ headers: input.headers, body: input.payload })
    : serializeMagentoWebhookValidation({
      status: "NOT_CONFIGURED",
      missingHeaders: [],
      signatureConfigured: false
    });
}

function webhookId(input: MagentoOrderWebhookInput) {
  if (!input.headers) return null;
  const entry = Object.entries(input.headers).find(([key]) => (
    key.toLowerCase() === "x-magento-webhook-id" ||
    key.toLowerCase() === "x-adobe-commerce-webhook-id"
  ));
  const value = entry?.[1];
  if (Array.isArray(value)) return String(value[0] ?? "") || null;
  return typeof value === "string" ? value : value === undefined || value === null ? null : String(value);
}

export async function previewMagentoOrderWebhook(
  merchantId: string,
  connectionId: string,
  input: MagentoOrderWebhookInput,
  client: Db = prisma
) {
  const { connection, state } = await getMagentoConnectionRecord(merchantId, connectionId, client);
  const normalizedOrder = await mapPlatformOrder(StorePlatform.MAGENTO, input.payload, {
    pickupLocationId: input.pickupLocationId ?? null
  });

  return serializeMagentoOrderPreview({
    connection,
    state,
    normalizedOrder,
    webhookValidation: webhookValidationFor(input)
  });
}

export async function importMagentoOrderWebhookFoundation(
  merchantId: string,
  connectionId: string,
  input: MagentoOrderWebhookInput,
  client: Db = prisma
) {
  const { connection, state } = await getMagentoConnectionRecord(merchantId, connectionId, client);
  const normalizedOrder = await mapPlatformOrder(StorePlatform.MAGENTO, input.payload, {
    pickupLocationId: input.pickupLocationId ?? null
  });
  const record = await client.platformOrderImport.create({
    data: {
      connectionId: connection.id,
      merchantId,
      platform: StorePlatform.MAGENTO,
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
  await client.magentoConnectionState.update({
    where: { connectionId: connection.id },
    data: {
      lastWebhookReceivedAt: now,
      lastOrderWebhookId: webhookId(input)
    }
  });

  return {
    import: serializeMagentoOrderImport(record),
    normalized_order: serializeNormalizedPlatformOrder(normalizedOrder),
    webhook_validation: webhookValidationFor(input),
    order_creation: {
      status: "deferred",
      message: "Magento order payload mapped and recorded. Full Shipmastr order creation remains behind the seller API foundation."
    },
    connection: {
      connection_id: connection.id,
      base_url: state?.baseUrl ?? null
    }
  };
}

export async function listMagentoOrderImports(
  merchantId: string,
  connectionId: string,
  query: ListMagentoRecordsQueryInput = { page: 1, per_page: 20 },
  client: Db = prisma
) {
  const { connection } = await getMagentoConnectionRecord(merchantId, connectionId, client);
  const where: Prisma.PlatformOrderImportWhereInput = {
    merchantId,
    connectionId: connection.id,
    platform: StorePlatform.MAGENTO,
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
    imports: imports.map(serializeMagentoOrderImport),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function getMagentoOrderImport(
  merchantId: string,
  importId: string,
  client: Db = prisma
) {
  const record = await client.platformOrderImport.findFirst({
    where: { id: importId, merchantId, platform: StorePlatform.MAGENTO }
  });
  if (!record) throw new HttpError(404, "MAGENTO_ORDER_IMPORT_NOT_FOUND");
  return serializeMagentoOrderImport(record);
}
