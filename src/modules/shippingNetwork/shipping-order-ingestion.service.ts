import { parse } from "csv-parse/sync";
import { OrderStatus, PaymentMode, Prisma, ShipmentStatus } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { parseAmountToPaise, paiseToExistingOrderAmount } from "./shipping-amounts.js";
import { buildOrUpdateShipmentCandidate } from "./shipping-candidate-builder.js";
import { normalizeStateName } from "./shipping-indian-states.js";
import { normalizeIndianPhone, validateOrder } from "./shipping-order-validation.js";
import { NEEDS_ATTENTION_REASONS } from "./shipping-order-foundation.types.js";
import {
  serializeShipment,
  toPrismaJson
} from "./shipping-public-serializers.js";
import type {
  CreateShippingOrderInput,
  ListShippingOrdersQueryInput
} from "./shipping-validation.js";

type Db = Prisma.TransactionClient | typeof prisma;
type PartialShippingOrderInput = {
  [K in keyof CreateShippingOrderInput]?: CreateShippingOrderInput[K] | undefined;
};

export type FieldValidationError = {
  field: string;
  message: string;
};

export class ShippingValidationError extends Error {
  fields: FieldValidationError[];

  constructor(message: string, fields: FieldValidationError[]) {
    super(message);
    this.fields = fields;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metadataRecord(value: unknown) {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

function optionalString(value: unknown) {
  const trimmed = stringValue(value);
  return trimmed ? trimmed : null;
}

function positiveOrNull(value: number | null | undefined) {
  return typeof value === "number" && value > 0 ? value : null;
}

function statusFromValidation(value: "ready_to_ship" | "needs_attention") {
  return value === "ready_to_ship" ? OrderStatus.READY_TO_SHIP : OrderStatus.NEEDS_ATTENTION;
}

function shippingPaymentMode(value: PaymentMode | string) {
  return String(value).toUpperCase() === "COD" ? "cod" : "prepaid";
}

function statusList(value: string | undefined) {
  if (!value) return undefined;
  return value
    .split(",")
    .map((status) => status.trim().toUpperCase())
    .filter((status): status is keyof typeof OrderStatus => status in OrderStatus)
    .map((status) => OrderStatus[status]);
}

function publicOrder(order: Record<string, any>) {
  const shipment = order.shipmentCandidate ?? order.shipment ?? null;
  const reasons = Array.isArray(order.needsAttentionReasons) ? order.needsAttentionReasons : [];
  const addressFlags = Array.isArray(order.addressQualityFlags) ? order.addressQualityFlags : [];

  return {
    order_id: order.id,
    external_order_id: order.externalOrderId,
    source: order.source,
    status: String(order.status).toLowerCase(),
    payment_mode: order.paymentMode,
    order_amount: order.orderValue,
    cod_amount: order.codAmount,
    declared_value: order.declaredValue || order.orderValue,
    buyer: {
      name: order.buyerName,
      phone: order.buyerPhone,
      email: order.buyerEmail ?? null,
      pincode: order.pincode,
      city: order.city,
      state: order.state
    },
    pickup_location_id: order.pickupLocationId ?? null,
    address_quality: {
      score: order.addressQualityScore ?? null,
      flags: addressFlags
    },
    needs_attention_reasons: reasons,
    package: {
      weight_grams: order.weightGrams ?? null,
      length_mm: order.packageLengthMm ?? null,
      width_mm: order.packageWidthMm ?? null,
      height_mm: order.packageHeightMm ?? null,
      volumetric_weight_grams: order.volumetricWeightGrams ?? null
    },
    shipment_candidate: shipment ? serializeShipment(shipment) : null,
    created_at: order.createdAt,
    updated_at: order.updatedAt
  };
}

function validationFields(input: {
  orderAmount: number;
  codAmount: number;
  paymentMode: PaymentMode;
  pincode: string;
  buyerPhone: string;
}) {
  const fields: FieldValidationError[] = [];
  if (input.orderAmount < 0) {
    fields.push({ field: "orderAmount", message: "Order amount must be non-negative." });
  }
  if (input.codAmount < 0) {
    fields.push({ field: "codAmount", message: "COD amount must be non-negative." });
  }
  if (input.codAmount > input.orderAmount) {
    fields.push({ field: "codAmount", message: "COD amount cannot exceed order amount." });
  }
  if (!/^[1-9][0-9]{5}$/.test(input.pincode)) {
    fields.push({ field: "pincode", message: "Pincode must be 6 digits." });
  }
  if (!/^[6-9][0-9]{9}$/.test(input.buyerPhone)) {
    fields.push({ field: "buyerPhone", message: "Phone number must be a valid 10-digit Indian mobile number." });
  }
  if (input.paymentMode === PaymentMode.PREPAID && input.codAmount !== 0) {
    fields.push({ field: "codAmount", message: "COD amount must be 0 for prepaid orders." });
  }
  return fields;
}

async function resolvePickupLocation(
  merchantId: string,
  pickupLocationId: string | null | undefined,
  client: Db
) {
  if (pickupLocationId) {
    return client.pickupLocation.findFirst({
      where: {
        id: pickupLocationId,
        sellerId: merchantId,
        status: "active"
      }
    });
  }

  const activePickups = await client.pickupLocation.findMany({
    where: {
      sellerId: merchantId,
      status: "active"
    },
    orderBy: { createdAt: "asc" }
  });
  const defaultPickup = activePickups.find((pickup) => metadataRecord(pickup.metadata).isDefault === true);

  return defaultPickup ?? (activePickups.length === 1 ? activePickups[0]! : null);
}

function buildOrderData(input: {
  merchantId: string;
  source: string;
  body: CreateShippingOrderInput;
  importBatchId?: string | null;
  pickupLocationId: string | null;
}) {
  const body = input.body;
  const paymentMode = body.paymentMode === "PREPAID" ? PaymentMode.PREPAID : PaymentMode.COD;
  const orderAmount = body.orderAmount;
  const codAmount = paymentMode === PaymentMode.COD ? body.codAmount ?? orderAmount : 0;
  const declaredValue = body.declaredValue ?? orderAmount;
  const buyerPhone = normalizeIndianPhone(body.buyerPhone);
  const state = normalizeStateName(body.state);
  const validation = validateOrder({
    buyerName: body.buyerName,
    buyerPhone,
    addressLine1: body.addressLine1,
    addressLine2: body.addressLine2 ?? null,
    city: body.city,
    state,
    pincode: body.pincode,
    landmark: body.landmark ?? null,
    packageWeightGrams: body.packageWeight,
    paymentMode,
    codAmountPaise: codAmount * 100,
    pickupLocationId: input.pickupLocationId
  }, {
    lengthMm: body.packageLength,
    widthMm: body.packageWidth,
    heightMm: body.packageHeight
  });
  const fields = validationFields({
    orderAmount,
    codAmount,
    paymentMode,
    pincode: body.pincode,
    buyerPhone
  });

  if (fields.length) {
    throw new ShippingValidationError("Order could not be created. Please fix the errors below.", fields);
  }

  return {
    merchantId: input.merchantId,
    externalOrderId: body.externalOrderId ?? `manual-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    source: input.source,
    importBatchId: input.importBatchId ?? null,
    buyerName: body.buyerName.trim(),
    buyerPhone,
    buyerEmail: body.buyerEmail ?? null,
    buyerAltPhone: body.buyerAltPhone ? normalizeIndianPhone(body.buyerAltPhone) : null,
    addressLine1: body.addressLine1.trim(),
    addressLine2: body.addressLine2 ?? null,
    landmark: body.landmark ?? null,
    city: body.city.trim(),
    state,
    pincode: body.pincode.trim(),
    country: "IN",
    orderValue: orderAmount,
    codAmount,
    declaredValue,
    paymentMode,
    weightGrams: body.packageWeight ?? null,
    packageLengthMm: body.packageLength ?? null,
    packageWidthMm: body.packageWidth ?? null,
    packageHeightMm: body.packageHeight ?? null,
    volumetricWeightGrams: validation.volumetricWeight,
    productDescription: body.productDescription ?? null,
    hsnCode: body.hsnCode ?? null,
    itemCount: body.itemCount ?? 1,
    tags: body.tags ? toPrismaJson(body.tags) : Prisma.JsonNull,
    sellerNotes: body.sellerNotes ?? null,
    pickupLocationId: input.pickupLocationId,
    status: statusFromValidation(validation.status),
    addressQualityScore: validation.addressQualityScore,
    addressQualityFlags: toPrismaJson(validation.addressQualityFlags),
    needsAttentionReasons: toPrismaJson(validation.needsAttentionReasons)
  } satisfies Prisma.OrderUncheckedCreateInput;
}

export async function createShippingOrder(
  merchantId: string,
  input: CreateShippingOrderInput,
  client: Db = prisma
) {
  const pickup = await resolvePickupLocation(merchantId, input.pickupLocationId, client);
  const orderData = buildOrderData({
    merchantId,
    source: "manual",
    body: input,
    pickupLocationId: pickup?.id ?? null
  });

  const existing = await client.order.findUnique({
    where: {
      merchantId_externalOrderId: {
        merchantId,
        externalOrderId: orderData.externalOrderId
      }
    }
  });

  if (existing) {
    throw new HttpError(409, "ORDER_ALREADY_EXISTS", { externalOrderId: orderData.externalOrderId });
  }

  const order = await client.order.create({ data: orderData });
  const shipmentCandidate = order.status === OrderStatus.READY_TO_SHIP
    ? await buildOrUpdateShipmentCandidate(order.id, client)
    : null;

  return publicOrder({ ...order, shipmentCandidate });
}

export async function listShippingOrders(
  merchantId: string,
  query: ListShippingOrdersQueryInput,
  client: Db = prisma
) {
  const statuses = statusList(query.status);
  const where: Prisma.OrderWhereInput = {
    merchantId,
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(query.paymentMode ? { paymentMode: query.paymentMode as PaymentMode } : {}),
    ...(query.dateFrom || query.dateTo ? {
      createdAt: {
        ...(query.dateFrom ? { gte: query.dateFrom } : {}),
        ...(query.dateTo ? { lte: query.dateTo } : {})
      }
    } : {}),
    ...(query.search ? {
      OR: [
        { externalOrderId: { contains: query.search, mode: "insensitive" } },
        { buyerName: { contains: query.search, mode: "insensitive" } },
        { buyerPhone: { contains: query.search, mode: "insensitive" } },
        { pincode: { contains: query.search, mode: "insensitive" } }
      ]
    } : {})
  };
  const [orders, total] = await Promise.all([
    client.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit
    }),
    client.order.count({ where })
  ]);
  const orderKeys = orders.flatMap((order) => [order.id, order.externalOrderId]);
  const shipments = orderKeys.length
    ? await client.shipment.findMany({
      where: {
        sellerId: merchantId,
        OR: [
          { orderId: { in: orderKeys } },
          { externalOrderId: { in: orderKeys } }
        ]
      }
    })
    : [];
  const byOrderKey = new Map<string, typeof shipments[number]>();
  for (const shipment of shipments) {
    if (shipment.orderId) byOrderKey.set(shipment.orderId, shipment);
    if (shipment.externalOrderId) byOrderKey.set(shipment.externalOrderId, shipment);
  }

  return {
    orders: orders.map((order) => publicOrder({
      ...order,
      shipmentCandidate: byOrderKey.get(order.id) ?? byOrderKey.get(order.externalOrderId) ?? null
    })),
    total,
    page: query.page,
    pages: Math.ceil(total / query.limit)
  };
}

export async function getShippingOrder(merchantId: string, orderId: string, client: Db = prisma) {
  const order = await client.order.findFirst({
    where: {
      merchantId,
      OR: [
        { id: orderId },
        { externalOrderId: orderId }
      ]
    },
    include: { pickupLocation: true }
  });
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND");
  const shipmentCandidate = await client.shipment.findFirst({
    where: {
      sellerId: merchantId,
      OR: [
        { orderId: order.id },
        { externalOrderId: order.externalOrderId }
      ]
    }
  });

  return {
    ...publicOrder({ ...order, shipmentCandidate }),
    pickup_location: order.pickupLocation ? {
      pickup_location_id: order.pickupLocation.id,
      name: order.pickupLocation.label,
      status: order.pickupLocation.status,
      city: order.pickupLocation.city,
      state: order.pickupLocation.state,
      pincode: order.pickupLocation.pincode,
      country: order.pickupLocation.country
    } : null
  };
}

export async function summarizeShippingOrders(merchantId: string, client: Db = prisma) {
  const orders = await client.order.findMany({
    where: { merchantId },
    select: { status: true, paymentMode: true }
  });
  const byStatus = new Map<string, number>();
  for (const order of orders) {
    byStatus.set(String(order.status), (byStatus.get(String(order.status)) ?? 0) + 1);
  }

  return {
    total: orders.length,
    readyToShip: byStatus.get(OrderStatus.READY_TO_SHIP) ?? 0,
    needsAttention: byStatus.get(OrderStatus.NEEDS_ATTENTION) ?? 0,
    processing: byStatus.get(OrderStatus.RISK_SCORED) ?? 0,
    shipped: byStatus.get(OrderStatus.SHIPPED) ?? 0,
    delivered: byStatus.get(OrderStatus.DELIVERED) ?? 0,
    rto: byStatus.get(OrderStatus.RTO) ?? 0,
    codOrders: orders.filter((order) => order.paymentMode === PaymentMode.COD).length,
    prepaidOrders: orders.filter((order) => order.paymentMode === PaymentMode.PREPAID).length
  };
}

export async function updateShippingOrder(
  merchantId: string,
  orderId: string,
  input: PartialShippingOrderInput,
  client: Db = prisma
) {
  const existing = await client.order.findFirst({
    where: { id: orderId, merchantId }
  });
  if (!existing) throw new HttpError(404, "ORDER_NOT_FOUND");

  const merged: CreateShippingOrderInput = {
    externalOrderId: input.externalOrderId ?? existing.externalOrderId,
    paymentMode: input.paymentMode ?? existing.paymentMode,
    orderAmount: input.orderAmount ?? existing.orderValue,
    codAmount: input.codAmount ?? existing.codAmount,
    declaredValue: input.declaredValue ?? existing.declaredValue,
    buyerName: input.buyerName ?? existing.buyerName,
    buyerPhone: input.buyerPhone ?? existing.buyerPhone,
    buyerEmail: input.buyerEmail ?? existing.buyerEmail ?? undefined,
    buyerAltPhone: input.buyerAltPhone ?? existing.buyerAltPhone ?? undefined,
    addressLine1: input.addressLine1 ?? existing.addressLine1,
    addressLine2: input.addressLine2 ?? existing.addressLine2 ?? undefined,
    landmark: input.landmark ?? existing.landmark ?? undefined,
    city: input.city ?? existing.city,
    state: input.state ?? existing.state,
    pincode: input.pincode ?? existing.pincode,
    packageWeight: input.packageWeight ?? existing.weightGrams ?? undefined,
    packageLength: input.packageLength ?? existing.packageLengthMm ?? undefined,
    packageWidth: input.packageWidth ?? existing.packageWidthMm ?? undefined,
    packageHeight: input.packageHeight ?? existing.packageHeightMm ?? undefined,
    productDescription: input.productDescription ?? existing.productDescription ?? undefined,
    hsnCode: input.hsnCode ?? existing.hsnCode ?? undefined,
    itemCount: input.itemCount ?? existing.itemCount,
    sellerNotes: input.sellerNotes ?? existing.sellerNotes ?? undefined,
    pickupLocationId: input.pickupLocationId ?? existing.pickupLocationId ?? undefined
  };
  const pickup = await resolvePickupLocation(merchantId, merged.pickupLocationId, client);
  const updateData = buildOrderData({
    merchantId,
    source: existing.source,
    body: merged,
    importBatchId: existing.importBatchId,
    pickupLocationId: pickup?.id ?? null
  });
  const updated = await client.order.update({
    where: { id: existing.id },
    data: updateData
  });
  const shipmentCandidate = updated.status === OrderStatus.READY_TO_SHIP
    ? await buildOrUpdateShipmentCandidate(updated.id, client)
    : await cancelDraftCandidateIfNeeded(merchantId, updated.id, client);

  return publicOrder({ ...updated, shipmentCandidate });
}

async function cancelDraftCandidateIfNeeded(merchantId: string, orderId: string, client: Db) {
  const existing = await client.shipment.findFirst({
    where: {
      sellerId: merchantId,
      orderId
    }
  });
  if (!existing || existing.status !== ShipmentStatus.draft) return existing;

  return client.shipment.update({
    where: { id: existing.id },
    data: { status: ShipmentStatus.cancelled }
  });
}

export async function cancelShippingOrder(merchantId: string, orderId: string, client: Db = prisma) {
  const order = await client.order.findFirst({
    where: {
      id: orderId,
      merchantId
    }
  });
  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND");
  const shipment = await client.shipment.findFirst({
    where: {
      sellerId: merchantId,
      orderId: order.id
    }
  });
  const inProgressStatuses = new Set<ShipmentStatus>([
    ShipmentStatus.manifested,
    ShipmentStatus.pickup_scheduled,
    ShipmentStatus.picked_up,
    ShipmentStatus.in_transit,
    ShipmentStatus.out_for_delivery,
    ShipmentStatus.delivered
  ]);
  if (shipment && inProgressStatuses.has(shipment.status)) {
    throw new HttpError(409, "ORDER_SHIPMENT_ALREADY_IN_PROGRESS");
  }

  const updated = await client.order.update({
    where: { id: order.id },
    data: { status: OrderStatus.CANCELLED }
  });
  const shipmentCandidate = shipment && shipment.status === ShipmentStatus.draft
    ? await client.shipment.update({
      where: { id: shipment.id },
      data: { status: ShipmentStatus.cancelled }
    })
    : shipment;

  return publicOrder({ ...updated, shipmentCandidate });
}

type CsvRow = Record<string, unknown>;

const CSV_HEADER_ALIASES: Record<string, keyof CreateShippingOrderInput> = {
  order_id: "externalOrderId",
  buyer_name: "buyerName",
  phone: "buyerPhone",
  email: "buyerEmail",
  address_line_1: "addressLine1",
  address_line_2: "addressLine2",
  landmark: "landmark",
  city: "city",
  state: "state",
  pincode: "pincode",
  payment_mode: "paymentMode",
  order_amount: "orderAmount",
  cod_amount: "codAmount",
  declared_value: "declaredValue",
  weight_g: "packageWeight",
  length_mm: "packageLength",
  width_mm: "packageWidth",
  height_mm: "packageHeight",
  product: "productDescription",
  hsn_code: "hsnCode",
  item_count: "itemCount",
  notes: "sellerNotes"
};

function normalizedHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseCsvRows(buffer: Buffer): Array<{ rowNumber: number; data: CsvRow }> {
  const records = parse(buffer, {
    bom: true,
    columns: (headers: string[]) => headers.map(normalizedHeader),
    skip_empty_lines: true,
    trim: true
  }) as CsvRow[];

  return records
    .map((data, index) => ({ rowNumber: index + 2, data }))
    .filter((row) => Object.values(row.data).some((value) => stringValue(value)));
}

function rowToOrderInput(row: CsvRow, pickupLocationId?: string | undefined): CreateShippingOrderInput {
  const result: Record<string, unknown> = {};
  for (const [header, field] of Object.entries(CSV_HEADER_ALIASES)) {
    if (row[header] !== undefined) {
      result[field] = row[header];
    }
  }
  const paymentMode = stringValue(result.paymentMode).toUpperCase() === "PREPAID" ? "PREPAID" : "COD";
  const orderAmountPaise = parseAmountToPaise(result.orderAmount as string | number | null | undefined);
  const codAmountPaise = result.codAmount === undefined || result.codAmount === ""
    ? (paymentMode === "COD" ? orderAmountPaise : 0)
    : parseAmountToPaise(result.codAmount as string | number | null | undefined);
  const declaredValuePaise = result.declaredValue === undefined || result.declaredValue === ""
    ? orderAmountPaise
    : parseAmountToPaise(result.declaredValue as string | number | null | undefined);

  return {
    externalOrderId: optionalString(result.externalOrderId) ?? undefined,
    buyerName: stringValue(result.buyerName),
    buyerPhone: stringValue(result.buyerPhone),
    buyerEmail: optionalString(result.buyerEmail) ?? undefined,
    addressLine1: stringValue(result.addressLine1),
    addressLine2: optionalString(result.addressLine2) ?? undefined,
    landmark: optionalString(result.landmark) ?? undefined,
    city: stringValue(result.city),
    state: stringValue(result.state),
    pincode: stringValue(result.pincode),
    paymentMode,
    orderAmount: paiseToExistingOrderAmount(orderAmountPaise),
    codAmount: paiseToExistingOrderAmount(codAmountPaise),
    declaredValue: paiseToExistingOrderAmount(declaredValuePaise),
    packageWeight: positiveOrNull(Number(result.packageWeight)) ?? undefined,
    packageLength: positiveOrNull(Number(result.packageLength)) ?? undefined,
    packageWidth: positiveOrNull(Number(result.packageWidth)) ?? undefined,
    packageHeight: positiveOrNull(Number(result.packageHeight)) ?? undefined,
    productDescription: optionalString(result.productDescription) ?? undefined,
    hsnCode: optionalString(result.hsnCode) ?? undefined,
    itemCount: positiveOrNull(Number(result.itemCount)) ?? undefined,
    sellerNotes: optionalString(result.sellerNotes) ?? undefined,
    pickupLocationId
  };
}

export async function importShippingOrdersCsv(input: {
  merchantId: string;
  filename: string;
  mimeType?: string | undefined;
  buffer: Buffer;
  pickupLocationId?: string | undefined;
}, client: Db = prisma) {
  if (input.buffer.length > 2 * 1024 * 1024) {
    throw new HttpError(413, "CSV_FILE_TOO_LARGE");
  }
  if (input.mimeType && !["text/csv", "text/plain", "application/csv"].includes(input.mimeType)) {
    throw new HttpError(400, "CSV_UNSUPPORTED_MIME_TYPE");
  }
  const rows = parseCsvRows(input.buffer);
  if (rows.length > 500) throw new HttpError(400, "CSV_ROW_LIMIT_EXCEEDED");
  const headers = Object.keys(rows[0]?.data ?? {});
  if (!headers.some((header) => header in CSV_HEADER_ALIASES)) {
    throw new HttpError(400, "CSV_HEADERS_UNRECOGNIZED");
  }
  const batch = await client.orderImportBatch.create({
    data: {
      merchantId: input.merchantId,
      filename: input.filename,
      totalRows: rows.length,
      status: "processing"
    }
  });
  const seenExternalIds = new Set<string>();
  const errors: Array<{ rowNumber: number; field: string; message: string }> = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const orderInput = rowToOrderInput(row.data, input.pickupLocationId);
      if (!orderInput.externalOrderId) {
        throw new ShippingValidationError("CSV row is missing required data.", [
          { field: "externalOrderId", message: "Order ID is required." }
        ]);
      }
      if (seenExternalIds.has(orderInput.externalOrderId)) {
        throw new ShippingValidationError("CSV row contains a duplicate order.", [
          { field: "externalOrderId", message: "Duplicate order ID in this CSV file." }
        ]);
      }
      seenExternalIds.add(orderInput.externalOrderId);
      const existing = await client.order.findUnique({
        where: {
          merchantId_externalOrderId: {
            merchantId: input.merchantId,
            externalOrderId: orderInput.externalOrderId
          }
        }
      });
      if (existing) {
        throw new ShippingValidationError("CSV row contains an existing order.", [
          { field: "externalOrderId", message: "Order ID already exists." }
        ]);
      }
      const pickup = await resolvePickupLocation(input.merchantId, orderInput.pickupLocationId, client);
      const orderData = buildOrderData({
        merchantId: input.merchantId,
        source: "csv",
        body: orderInput,
        importBatchId: batch.id,
        pickupLocationId: pickup?.id ?? null
      });
      const order = await client.order.create({ data: orderData });
      if (order.status === OrderStatus.READY_TO_SHIP) {
        await buildOrUpdateShipmentCandidate(order.id, client);
      }
      imported += 1;
    } catch (error) {
      failed += 1;
      if (error instanceof ShippingValidationError) {
        for (const fieldError of error.fields) {
          errors.push({ rowNumber: row.rowNumber, ...fieldError });
        }
      } else if (error instanceof HttpError && error.message === "ORDER_ALREADY_EXISTS") {
        errors.push({ rowNumber: row.rowNumber, field: "externalOrderId", message: "Order ID already exists." });
      } else {
        errors.push({ rowNumber: row.rowNumber, field: "row", message: error instanceof Error ? error.message : "Row could not be imported." });
      }
    }
  }

  if (!rows.length) skipped = 0;
  const status = imported > 0 ? "completed" : "failed";
  await client.orderImportBatch.update({
    where: { id: batch.id },
    data: {
      importedRows: imported,
      skippedRows: skipped,
      failedRows: failed,
      errorsJson: toPrismaJson(errors),
      status
    }
  });

  return {
    batchId: batch.id,
    imported,
    skipped,
    failed,
    errors
  };
}
