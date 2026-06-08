import {
  OrderStatus,
  PaymentMode,
  PlatformImportItemStatus,
  PlatformOrderImportStatus,
  type Prisma
} from "@prisma/client";
import { HttpError } from "../../../lib/httpError.js";
import { prisma } from "../../../lib/prisma.js";
import { buildOrUpdateShipmentCandidate } from "../../shippingNetwork/shipping-candidate-builder.js";
import { normalizeStateName } from "../../shippingNetwork/shipping-indian-states.js";
import { validateOrder } from "../../shippingNetwork/shipping-order-validation.js";
import { toPrismaJson } from "../../shippingNetwork/shipping-public-serializers.js";
import type { ReconciliationItemsQueryInput } from "../reconciliation/platform-import-reconciliation.validation.js";
import {
  evaluatePlatformImportConversionEligibility,
  platformOrderExternalId,
  queueFromOrderStatus,
  safeOrderFieldsFromImportItem
} from "./platform-import-conversion.rules.js";
import {
  conversionNextActions,
  serializePlatformImportConversionRecord,
  serializePlatformImportConversionResult
} from "./platform-import-conversion.serializer.js";
import type {
  PlatformImportConversionReasonCode,
  PlatformImportConversionResult
} from "./platform-import-conversion.types.js";

type Db = Prisma.TransactionClient | typeof prisma;

const BULK_CONVERSION_LIMIT = 50;
const PLATFORM_IMPORT_SOURCE = "platform_import";
const PLACEHOLDER_PHONE = "0000000000";
const PLACEHOLDER_ADDRESS = "Address pending from platform import";

function asDate(value: string | undefined) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function inputJson(value: unknown) {
  return toPrismaJson(value);
}

function conversionResult(result: PlatformImportConversionResult) {
  return serializePlatformImportConversionResult(result);
}

async function findItem(merchantId: string, itemId: string, client: Db) {
  const item = await client.platformImportItem.findFirst({
    where: { id: itemId, merchantId }
  });
  if (!item) throw new HttpError(404, "PLATFORM_IMPORT_ITEM_NOT_FOUND");
  return item;
}

async function findJobForItem(item: { jobId: string; merchantId: string }, client: Db) {
  const job = await client.platformImportJob.findFirst({
    where: { id: item.jobId, merchantId: item.merchantId }
  });
  if (!job) throw new HttpError(409, "PLATFORM_IMPORT_JOB_NOT_FOUND_FOR_ITEM");
  return job;
}

async function defaultPickupLocation(merchantId: string, client: Db) {
  const pickups = await client.pickupLocation.findMany({
    where: { sellerId: merchantId, status: "active" },
    orderBy: { createdAt: "asc" }
  });
  const defaultPickup = pickups.find((pickup) => {
    const metadata = pickup.metadata && typeof pickup.metadata === "object" && !Array.isArray(pickup.metadata)
      ? pickup.metadata as Record<string, unknown>
      : {};
    return metadata.isDefault === true;
  });
  return defaultPickup ?? (pickups.length === 1 ? pickups[0]! : null);
}

async function existingConversionForItem(merchantId: string, itemId: string, client: Db) {
  return client.platformImportConversion.findFirst({
    where: { merchantId, importItemId: itemId }
  });
}

async function existingConvertedOrderForExternalId(
  merchantId: string,
  orderExternalId: string,
  client: Db
) {
  return client.order.findUnique({
    where: {
      merchantId_externalOrderId: {
        merchantId,
        externalOrderId: orderExternalId
      }
    }
  });
}

async function existingConvertedSibling(
  item: {
    id: string;
    merchantId: string;
    connectionId: string;
    platform: string;
    externalOrderId?: string | null;
  },
  client: Db
) {
  if (!item.externalOrderId) return null;
  const siblings = await client.platformImportItem.findMany({
    where: {
      merchantId: item.merchantId,
      connectionId: item.connectionId,
      platform: item.platform as any,
      externalOrderId: item.externalOrderId
    }
  });
  const siblingIds = siblings.filter((sibling) => sibling.id !== item.id).map((sibling) => sibling.id);
  if (!siblingIds.length) return null;
  return client.platformImportConversion.findFirst({
    where: {
      merchantId: item.merchantId,
      importItemId: { in: siblingIds },
      status: { in: ["CONVERTED", "NEEDS_ATTENTION"] }
    }
  });
}

async function ensurePlatformOrderImport(
  item: {
    orderImportId?: string | null;
    connectionId: string;
    merchantId: string;
    platform: any;
    externalOrderId?: string | null;
    externalOrderName?: string | null;
    payloadHash: string;
    safePayloadPreview?: unknown;
    mappingWarnings?: unknown;
  },
  orderId: string,
  client: Db
) {
  if (!item.externalOrderId) return null;
  const existing = item.orderImportId
    ? await client.platformOrderImport.findFirst({ where: { id: item.orderImportId, merchantId: item.merchantId } })
    : await client.platformOrderImport.findFirst({
      where: {
        connectionId: item.connectionId,
        merchantId: item.merchantId,
        platform: item.platform,
        externalOrderId: item.externalOrderId
      }
    });

  if (existing) {
    return client.platformOrderImport.update({
      where: { id: existing.id },
      data: { normalizedOrderId: orderId, status: PlatformOrderImportStatus.IMPORTED }
    });
  }

  return client.platformOrderImport.create({
    data: {
      connectionId: item.connectionId,
      merchantId: item.merchantId,
      platform: item.platform,
      externalOrderId: item.externalOrderId,
      externalOrderName: item.externalOrderName ?? null,
      status: PlatformOrderImportStatus.IMPORTED,
      normalizedOrderId: orderId,
      rawPayloadHash: item.payloadHash,
      rawPayloadPreview: inputJson(item.safePayloadPreview ?? null),
      mappingWarnings: inputJson(item.mappingWarnings ?? [])
    }
  });
}

function orderAttentionReasons(input: {
  validationReasons: string[];
  mappingWarnings: string[];
  requestedQueue: string | null;
}) {
  return Array.from(new Set([
    ...input.validationReasons,
    ...(input.mappingWarnings.length ? ["PLATFORM_MAPPING_WARNING"] : []),
    ...(input.requestedQueue === "NEEDS_ATTENTION" ? ["PLATFORM_IMPORT_REVIEW_REQUIRED"] : [])
  ]));
}

function publicWarnings(input: {
  mappingWarnings: string[];
  attentionReasons: string[];
  shipmentCandidateRequested: boolean;
  shipmentId?: string | null;
}) {
  return Array.from(new Set([
    ...input.mappingWarnings,
    ...input.attentionReasons,
    ...(input.shipmentCandidateRequested && !input.shipmentId ? ["Shipment candidate was not created because the order needs attention."] : [])
  ]));
}

function blockResult(itemId: string, reasonCodes: PlatformImportConversionReasonCode[], warnings: string[] = []) {
  return conversionResult({
    itemId,
    status: reasonCodes.includes("ALREADY_CONVERTED") ? "ALREADY_CONVERTED" : "BLOCKED",
    reasonCodes: Array.from(new Set(reasonCodes)),
    warnings,
    nextActions: ["REVIEW"]
  });
}

export async function convertPlatformImportItem(
  merchantId: string,
  itemId: string,
  input: { createShipmentCandidate?: boolean | undefined } = {},
  client: Db = prisma
) {
  const item = await findItem(merchantId, itemId, client);
  const job = await findJobForItem(item, client);
  if (job.merchantId !== merchantId || item.merchantId !== merchantId) {
    return blockResult(item.id, ["MERCHANT_SCOPE_MISMATCH"]);
  }

  const existingConversion = await existingConversionForItem(merchantId, item.id, client);
  const eligibility = evaluatePlatformImportConversionEligibility(item, existingConversion);
  if (!eligibility.eligible) {
    if (existingConversion?.orderId) {
      return conversionResult({
        itemId: item.id,
        status: "ALREADY_CONVERTED",
        orderId: existingConversion.orderId,
        shipmentId: existingConversion.shipmentId ?? null,
        queue: existingConversion.queue as any,
        reasonCodes: ["ALREADY_CONVERTED"],
        warnings: eligibility.warnings,
        nextActions: conversionNextActions({
          status: "ALREADY_CONVERTED",
          queue: existingConversion.queue as any,
          orderId: existingConversion.orderId,
          shipmentId: existingConversion.shipmentId ?? null
        })
      });
    }
    return blockResult(item.id, eligibility.reasonCodes, eligibility.warnings);
  }

  const orderExternalId = platformOrderExternalId(item);
  if (!orderExternalId) return blockResult(item.id, ["MISSING_EXTERNAL_ORDER_ID"], eligibility.warnings);
  const existingOrder = await existingConvertedOrderForExternalId(merchantId, orderExternalId, client);
  const existingSibling = await existingConvertedSibling(item, client);
  if (existingOrder || existingSibling) {
    return blockResult(item.id, ["ALREADY_CONVERTED"], eligibility.warnings);
  }

  const pickup = await defaultPickupLocation(merchantId, client);
  const fields = safeOrderFieldsFromImportItem(item);
  const state = normalizeStateName(fields.state);
  const validation = validateOrder({
    buyerName: fields.buyerName,
    buyerPhone: null,
    addressLine1: null,
    city: fields.city,
    state,
    pincode: fields.pincode,
    packageWeightGrams: fields.packageWeight,
    paymentMode: fields.paymentMode,
    codAmountPaise: fields.codAmount * 100,
    pickupLocationId: pickup?.id ?? null
  });
  const attentionReasons = orderAttentionReasons({
    validationReasons: validation.needsAttentionReasons,
    mappingWarnings: eligibility.warnings,
    requestedQueue: eligibility.queue
  });
  const orderStatus = attentionReasons.length ? OrderStatus.NEEDS_ATTENTION : OrderStatus.READY_TO_SHIP;
  const order = await client.order.create({
    data: {
      merchantId,
      externalOrderId: orderExternalId,
      source: PLATFORM_IMPORT_SOURCE,
      importBatchId: null,
      buyerName: fields.buyerName,
      buyerPhone: PLACEHOLDER_PHONE,
      buyerEmail: null,
      buyerAltPhone: null,
      addressLine1: PLACEHOLDER_ADDRESS,
      addressLine2: null,
      landmark: null,
      city: fields.city,
      state,
      pincode: fields.pincode!,
      country: fields.country ?? "IN",
      orderValue: fields.orderValue,
      codAmount: fields.codAmount,
      declaredValue: fields.orderValue,
      paymentMode: fields.paymentMode === "COD" ? PaymentMode.COD : PaymentMode.PREPAID,
      weightGrams: fields.packageWeight,
      packageLengthMm: null,
      packageWidthMm: null,
      packageHeightMm: null,
      volumetricWeightGrams: validation.volumetricWeight,
      productDescription: fields.productDescription,
      hsnCode: null,
      itemCount: fields.itemCount,
      tags: inputJson({
        source: "platform_import",
        platform: item.platform,
        connection_id: item.connectionId,
        external_order_name: fields.displayOrderName
      }),
      sellerNotes: "Imported platform order prepared by Shipmastr. Review buyer contact and address before shipping.",
      pickupLocationId: pickup?.id ?? null,
      status: orderStatus,
      addressQualityScore: validation.addressQualityScore,
      addressQualityFlags: inputJson(validation.addressQualityFlags),
      needsAttentionReasons: inputJson(attentionReasons)
    }
  });

  let shipment: { id: string } | null = null;
  if (input.createShipmentCandidate !== false && order.status === OrderStatus.READY_TO_SHIP) {
    shipment = await buildOrUpdateShipmentCandidate(order.id, client) as { id: string } | null;
  }

  const orderImport = await ensurePlatformOrderImport(item, order.id, client);
  await client.platformImportItem.update({
    where: { id: item.id },
    data: {
      normalizedOrderId: order.id,
      orderImportId: orderImport?.id ?? item.orderImportId ?? null,
      status: item.status === PlatformImportItemStatus.MAPPED ? PlatformImportItemStatus.IMPORTED : item.status,
      lastAttemptAt: new Date(),
      nextAttemptAt: null
    }
  });

  const queue = queueFromOrderStatus(order.status);
  const warnings = publicWarnings({
    mappingWarnings: eligibility.warnings,
    attentionReasons,
    shipmentCandidateRequested: input.createShipmentCandidate !== false,
    shipmentId: shipment?.id ?? null
  });
  const status = order.status === OrderStatus.READY_TO_SHIP ? "CONVERTED" : "NEEDS_ATTENTION";
  const reasonCodes: PlatformImportConversionReasonCode[] = shipment || input.createShipmentCandidate === false
    ? []
    : ["SHIPMENT_CANDIDATE_NOT_READY"];
  const conversion = await client.platformImportConversion.create({
    data: {
      merchantId,
      importItemId: item.id,
      platformOrderImportId: orderImport?.id ?? null,
      orderId: order.id,
      shipmentId: shipment?.id ?? null,
      status,
      queue,
      warnings: inputJson(warnings),
      reasonCodes: inputJson(reasonCodes)
    }
  });

  return conversionResult({
    itemId: item.id,
    status,
    orderId: order.id,
    shipmentId: shipment?.id ?? null,
    queue,
    reasonCodes,
    warnings,
    nextActions: conversionNextActions({
      status,
      queue,
      orderId: order.id,
      shipmentId: shipment?.id ?? null
    })
  });
}

function itemWhereFromFilters(
  merchantId: string,
  filters: {
    platform?: string | undefined;
    connectionId?: string | undefined;
    jobId?: string | undefined;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    hasWarnings?: boolean | undefined;
  } | undefined
): Prisma.PlatformImportItemWhereInput {
  const from = asDate(filters?.dateFrom);
  const to = asDate(filters?.dateTo);
  const where: Prisma.PlatformImportItemWhereInput = {
    merchantId,
    ...(filters?.platform ? { platform: filters.platform as any } : {}),
    ...(filters?.connectionId ? { connectionId: filters.connectionId } : {}),
    ...(filters?.jobId ? { jobId: filters.jobId } : {})
  };
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {})
    };
  }
  return where;
}

export async function bulkConvertPlatformImportItems(
  merchantId: string,
  input: {
    itemIds?: string[] | undefined;
    filters?: Partial<ReconciliationItemsQueryInput> | undefined;
    createShipmentCandidates?: boolean | undefined;
    limit?: number | undefined;
  },
  client: Db = prisma
) {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), BULK_CONVERSION_LIMIT);
  const itemIds = input.itemIds?.length
    ? input.itemIds.slice(0, limit)
    : [];
  const items = itemIds.length
    ? await client.platformImportItem.findMany({
      where: { merchantId, id: { in: itemIds } },
      orderBy: { updatedAt: "desc" },
      take: limit
    })
    : await client.platformImportItem.findMany({
      where: itemWhereFromFilters(merchantId, input.filters),
      orderBy: { updatedAt: "desc" },
      take: limit * 4
    });
  const filtered = (input.filters?.status
    ? items.filter((item) => evaluatePlatformImportConversionEligibility(item).reconciliationStatus === input.filters?.status)
    : items).slice(0, limit);

  const results = [];
  for (const item of filtered) {
    results.push(await convertPlatformImportItem(merchantId, item.id, {
      createShipmentCandidate: input.createShipmentCandidates ?? true
    }, client));
  }

  return {
    requested_count: filtered.length,
    converted_count: results.filter((result) => result.status === "CONVERTED").length,
    blocked_count: results.filter((result) => result.status === "BLOCKED").length,
    already_converted_count: results.filter((result) => result.status === "ALREADY_CONVERTED").length,
    needs_attention_count: results.filter((result) => result.status === "NEEDS_ATTENTION").length,
    results
  };
}

export async function getPlatformImportItemConversionStatus(
  merchantId: string,
  itemId: string,
  client: Db = prisma
) {
  await findItem(merchantId, itemId, client);
  const conversion = await existingConversionForItem(merchantId, itemId, client);
  return {
    item_id: itemId,
    conversion: serializePlatformImportConversionRecord(conversion)
  };
}
