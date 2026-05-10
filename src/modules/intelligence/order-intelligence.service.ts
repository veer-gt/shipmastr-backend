import type {
  CodDecision,
  ConsigneeTier,
  Order,
  OrderStatus,
  Prisma,
  ShipmentDecision,
  TrustTier
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { addressHash, phoneHash } from "./fingerprint.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type OrderCreateSignals = {
  skuId?: string | undefined;
  productCategory?: string | undefined;
  itemCount?: number | undefined;
  productTitle?: string | undefined;
  productTitleNormalized?: string | undefined;
  salesChannel?: string | undefined;
  storePlatform?: string | undefined;
  utmSource?: string | undefined;
  utmMedium?: string | undefined;
  utmCampaign?: string | undefined;
  campaignId?: string | undefined;
  couponCode?: string | undefined;
  discountAmount?: number | undefined;
  discountPercent?: number | undefined;
  otpVerified?: boolean | undefined;
  whatsappConfirmed?: boolean | undefined;
  callConfirmed?: boolean | undefined;
  failedOtpAttempts?: number | undefined;
  sellerProcessingTimeMinutes?: number | undefined;
  shippingChargeToSeller?: number | undefined;
  courierCostToShipmastr?: number | undefined;
  codFeeCharged?: number | undefined;
  codFeeCost?: number | undefined;
  rtoCost?: number | undefined;
  netMargin?: number | undefined;
  marginAfterRto?: number | undefined;
  promisedPickupDate?: Date | undefined;
  promisedDeliveryDate?: Date | undefined;
  declaredWeight?: number | undefined;
  chargedWeight?: number | undefined;
  courierMeasuredWeight?: number | undefined;
  weightDisputeRaised?: boolean | undefined;
  manualEditCount?: number | undefined;
  addressEditedAfterCreation?: boolean | undefined;
  paymentModeChangedAfterCreation?: boolean | undefined;
};

export type SnapshotInput = {
  order: Order;
  buyerPhoneHash: string;
  addressHash: string;
  consigneeScore: number;
  consigneeTier: ConsigneeTier;
  consigneeLabel: string;
  consigneeReasons: string[];
  merchantTrustScore: number;
  merchantTrustTier?: TrustTier | null;
  merchantReasons: string[];
  courierId?: string | null;
  courierScore?: number | null;
  courierReasons: string[];
  addressConfidenceScore?: number | null;
  pincodeRiskScore?: number | null;
  codRiskScore?: number | null;
  rtoRiskScore?: number | null;
  fraudRiskScore?: number | null;
  overallRiskScore?: number | null;
  codDecision: CodDecision;
  shipmentDecision: ShipmentDecision;
  riskReasons: string[];
  signals: OrderCreateSignals;
};

function normalizeTitle(value?: string) {
  return value
    ?.toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim() || undefined;
}

function asMoney(value?: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactUndefined<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function orderTimeParts(date: Date) {
  const orderHour = date.getUTCHours();
  const orderDayOfWeek = date.getUTCDay();

  return {
    orderHour,
    orderDayOfWeek,
    isLateNightOrder: orderHour >= 22 || orderHour < 5,
    isWeekendOrder: orderDayOfWeek === 0 || orderDayOfWeek === 6
  };
}

export function buildOrderDataSignalsInput(order: Order, signals: OrderCreateSignals = {}) {
  const title = normalizeTitle(signals.productTitleNormalized || signals.productTitle);
  const time = orderTimeParts(order.createdAt);

  return {
    merchantId: order.merchantId,
    skuId: signals.skuId,
    productCategory: signals.productCategory,
    itemCount: signals.itemCount,
    productTitleNormalized: title,
    salesChannel: signals.salesChannel,
    storePlatform: signals.storePlatform,
    utmSource: signals.utmSource,
    utmMedium: signals.utmMedium,
    utmCampaign: signals.utmCampaign,
    campaignId: signals.campaignId,
    couponCode: signals.couponCode,
    discountAmount: asMoney(signals.discountAmount),
    discountPercent: signals.discountPercent,
    otpVerified: signals.otpVerified ?? false,
    whatsappConfirmed: signals.whatsappConfirmed ?? false,
    callConfirmed: signals.callConfirmed ?? false,
    failedOtpAttempts: signals.failedOtpAttempts ?? 0,
    ...time,
    sellerProcessingTimeMinutes: signals.sellerProcessingTimeMinutes,
    shippingChargeToSeller: asMoney(signals.shippingChargeToSeller),
    courierCostToShipmastr: asMoney(signals.courierCostToShipmastr),
    codFeeCharged: asMoney(signals.codFeeCharged),
    codFeeCost: asMoney(signals.codFeeCost),
    rtoCost: asMoney(signals.rtoCost),
    netMargin: asMoney(signals.netMargin),
    marginAfterRto: asMoney(signals.marginAfterRto),
    promisedPickupDate: signals.promisedPickupDate,
    promisedDeliveryDate: signals.promisedDeliveryDate,
    declaredWeight: asMoney(signals.declaredWeight),
    chargedWeight: asMoney(signals.chargedWeight),
    courierMeasuredWeight: asMoney(signals.courierMeasuredWeight),
    weightDisputeRaised: signals.weightDisputeRaised ?? false,
    manualEditCount: signals.manualEditCount ?? 0,
    addressEditedAfterCreation: signals.addressEditedAfterCreation ?? false,
    paymentModeChangedAfterCreation: signals.paymentModeChangedAfterCreation ?? false
  };
}

export function buildEnrichedSnapshot(input: SnapshotInput): Prisma.InputJsonObject {
  const signalInput = buildOrderDataSignalsInput(input.order, input.signals);

  return {
    source: "order_created",
    order: {
      id: input.order.id,
      merchantId: input.order.merchantId,
      externalOrderId: input.order.externalOrderId,
      pincode: input.order.pincode,
      orderValue: input.order.orderValue,
      codAmount: input.order.codAmount,
      paymentMode: input.order.paymentMode,
      weightGrams: input.order.weightGrams ?? null
    },
    hashes: {
      phoneHash: input.buyerPhoneHash,
      addressHash: input.addressHash
    },
    product: {
      skuId: signalInput.skuId ?? null,
      productCategory: signalInput.productCategory ?? null,
      productTitleNormalized: signalInput.productTitleNormalized ?? null,
      itemCount: signalInput.itemCount ?? null
    },
    campaign: {
      salesChannel: signalInput.salesChannel ?? null,
      storePlatform: signalInput.storePlatform ?? null,
      utmSource: signalInput.utmSource ?? null,
      utmMedium: signalInput.utmMedium ?? null,
      utmCampaign: signalInput.utmCampaign ?? null,
      campaignId: signalInput.campaignId ?? null,
      couponCode: signalInput.couponCode ?? null,
      discountAmount: signalInput.discountAmount ?? null,
      discountPercent: signalInput.discountPercent ?? null
    },
    verification: {
      otpVerified: signalInput.otpVerified,
      whatsappConfirmed: signalInput.whatsappConfirmed,
      callConfirmed: signalInput.callConfirmed,
      failedOtpAttempts: signalInput.failedOtpAttempts
    },
    time: {
      orderHour: signalInput.orderHour,
      orderDayOfWeek: signalInput.orderDayOfWeek,
      isLateNightOrder: signalInput.isLateNightOrder,
      isWeekendOrder: signalInput.isWeekendOrder,
      sellerProcessingTimeMinutes: signalInput.sellerProcessingTimeMinutes ?? null
    },
    profitability: {
      shippingChargeToSeller: signalInput.shippingChargeToSeller ?? null,
      courierCostToShipmastr: signalInput.courierCostToShipmastr ?? null,
      codFeeCharged: signalInput.codFeeCharged ?? null,
      codFeeCost: signalInput.codFeeCost ?? null,
      rtoCost: signalInput.rtoCost ?? null,
      netMargin: signalInput.netMargin ?? null,
      marginAfterRto: signalInput.marginAfterRto ?? null
    },
    promise: {
      promisedPickupDate: signalInput.promisedPickupDate?.toISOString() ?? null,
      promisedDeliveryDate: signalInput.promisedDeliveryDate?.toISOString() ?? null
    },
    weight: {
      declaredWeight: signalInput.declaredWeight ?? null,
      chargedWeight: signalInput.chargedWeight ?? null,
      courierMeasuredWeight: signalInput.courierMeasuredWeight ?? null,
      weightDisputeRaised: signalInput.weightDisputeRaised
    },
    consignee: {
      score: input.consigneeScore,
      tier: input.consigneeTier,
      label: input.consigneeLabel,
      reasons: input.consigneeReasons
    },
    merchant: {
      trustScore: input.merchantTrustScore,
      trustTier: input.merchantTrustTier ?? null,
      reasons: input.merchantReasons
    },
    courier: {
      courierId: input.courierId ?? null,
      courierScore: input.courierScore ?? null,
      reasons: input.courierReasons
    },
    risk: {
      codDecision: input.codDecision,
      shipmentDecision: input.shipmentDecision,
      addressConfidenceScore: input.addressConfidenceScore ?? null,
      pincodeRiskScore: input.pincodeRiskScore ?? null,
      codRiskScore: input.codRiskScore ?? null,
      rtoRiskScore: input.rtoRiskScore ?? null,
      fraudRiskScore: input.fraudRiskScore ?? null,
      overallRiskScore: input.overallRiskScore ?? null,
      reasons: input.riskReasons
    }
  };
}

export async function createShipmentDetailsForOrder(order: Order, client: Db = prisma) {
  return client.shipmentDetails.create({
    data: {
      orderId: order.id,
      merchantId: order.merchantId,
      pincode: order.pincode,
      city: order.city,
      state: order.state,
      addressHash: addressHash(order),
      shipmentStatus: "CREATED",
      weightGrams: order.weightGrams ?? null
    }
  });
}

export async function createOrderDataSignals(order: Order, signals: OrderCreateSignals = {}, client: Db = prisma) {
  return client.orderDataSignals.create({
    data: compactUndefined({
      orderId: order.id,
      ...buildOrderDataSignalsInput(order, signals)
    }) as Prisma.OrderDataSignalsUncheckedCreateInput
  });
}

export async function createOrderIntelligenceSnapshot(input: SnapshotInput, client: Db = prisma) {
  return client.orderIntelligence.create({
    data: {
      orderId: input.order.id,
      merchantId: input.order.merchantId,
      buyerPhoneHash: input.buyerPhoneHash,
      addressHash: input.addressHash,
      pincode: input.order.pincode,
      consigneeScore: input.consigneeScore,
      consigneeTier: input.consigneeTier,
      consigneeReasons: input.consigneeReasons,
      merchantTrustScore: input.merchantTrustScore,
      merchantTrustTier: input.merchantTrustTier ?? null,
      merchantReasons: input.merchantReasons,
      courierId: input.courierId ?? null,
      courierScore: input.courierScore ?? null,
      courierReasons: input.courierReasons,
      addressConfidenceScore: input.addressConfidenceScore ?? null,
      pincodeRiskScore: input.pincodeRiskScore ?? null,
      codRiskScore: input.codRiskScore ?? null,
      rtoRiskScore: input.rtoRiskScore ?? null,
      fraudRiskScore: input.fraudRiskScore ?? null,
      overallRiskScore: input.overallRiskScore ?? null,
      codDecision: input.codDecision,
      shipmentDecision: input.shipmentDecision,
      riskReasons: input.riskReasons,
      dataSnapshot: buildEnrichedSnapshot(input)
    }
  });
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalDate(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function shipmentPatchFromWebhook(input: {
  order: Order;
  payload: Record<string, unknown>;
  status: OrderStatus;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const awb = optionalString(input.payload.awbNumber) ?? optionalString(input.payload.awb);
  const trackingNumber = optionalString(input.payload.trackingNumber);
  const courierId = optionalString(input.payload.courierId);
  const estimatedDeliveryDate = optionalDate(input.payload.estimatedDeliveryDate);

  return {
    ...(courierId ? { courierId } : {}),
    ...(awb ? { awb } : {}),
    ...(trackingNumber ? { trackingNumber } : {}),
    ...(estimatedDeliveryDate ? { estimatedDeliveryDate } : {}),
    shipmentStatus: input.status,
    ...(input.status === "SHIPPED" ? { pickupStatus: "PICKED_UP" } : {}),
    ...(input.status === "DELIVERED" ? { deliveryStatus: "DELIVERED", actualDeliveryDate: now, deliveredAt: now } : {}),
    ...(input.status === "NDR" ? { deliveryStatus: "NDR", ndrStatus: "OPEN", firstAttemptAt: now } : {}),
    ...(input.status === "RTO" ? { deliveryStatus: "RTO", rtoStatus: "INITIATED", rtoInitiatedAt: now } : {}),
    ...(input.status === "CANCELLED" ? { deliveryStatus: "CANCELLED" } : {})
  };
}

export async function updateShipmentDetailsFromWebhook(input: {
  order: Order;
  payload: Record<string, unknown>;
  status: OrderStatus;
}, client: Db = prisma) {
  const patch = shipmentPatchFromWebhook(input);

  return client.shipmentDetails.upsert({
    where: { orderId: input.order.id },
    create: {
      orderId: input.order.id,
      merchantId: input.order.merchantId,
      pincode: input.order.pincode,
      city: input.order.city,
      state: input.order.state,
      addressHash: addressHash(input.order),
      weightGrams: input.order.weightGrams ?? null,
      ...patch
    },
    update: patch
  });
}

export async function updateOrderDataSignalsFromWebhook(input: {
  orderId: string;
  status: OrderStatus;
  payload: Record<string, unknown>;
  now?: Date;
}, client: Db = prisma) {
  const now = input.now ?? new Date();
  const ndrRaisedAt = optionalDate(input.payload.ndrRaisedAt) ?? (input.status === "NDR" ? now : null);
  const sellerActionAt = optionalDate(input.payload.sellerActionAt);
  const actualPickupDate = optionalDate(input.payload.actualPickupDate);
  const actualDeliveryDate = optionalDate(input.payload.actualDeliveryDate) ?? (input.status === "DELIVERED" ? now : null);
  const promisedDeliveryDate = optionalDate(input.payload.promisedDeliveryDate);
  const ndrActionDelayMinutes = ndrRaisedAt && sellerActionAt
    ? Math.max(0, Math.round((sellerActionAt.getTime() - ndrRaisedAt.getTime()) / 60000))
    : undefined;
  const promiseBreached = promisedDeliveryDate && actualDeliveryDate
    ? actualDeliveryDate.getTime() > promisedDeliveryDate.getTime()
    : undefined;

  return client.orderDataSignals.updateMany({
    where: { orderId: input.orderId },
    data: {
      ...(ndrActionDelayMinutes !== undefined ? { ndrActionDelayMinutes } : {}),
      ...(actualPickupDate ? { actualPickupDate } : {}),
      ...(actualDeliveryDate ? { actualDeliveryDate } : {}),
      ...(promisedDeliveryDate ? { promisedDeliveryDate } : {}),
      ...(promiseBreached !== undefined ? { promiseBreached } : {})
    }
  });
}

export function sellerSafeOrderIntelligenceSummary(input: {
  shipmentStatus: string;
  consigneeLabel: string;
  codDecision: CodDecision;
  courierRecommendation?: unknown;
  reasons: string[];
}) {
  return {
    shipmentStatus: input.shipmentStatus,
    buyerTierLabel: input.consigneeLabel,
    codDecision: input.codDecision,
    courierRecommendation: input.courierRecommendation ?? null,
    reasons: input.reasons.slice(0, 5)
  };
}
