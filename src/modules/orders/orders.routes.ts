import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { requireIdempotency } from "../../middleware/idempotency.js";
import { emitAutomationEvent } from "../automation/autopilot.service.js";
import { updateAddressFingerprint } from "../intelligence/address-intelligence.service.js";
import { approveAutonomousAction, handleOrderCreatedAutonomy, rejectAutonomousAction } from "../intelligence/autonomous-action.service.js";
import { decideCodEligibility } from "../intelligence/cod-decision.service.js";
import { getConsigneeDecision, updateConsigneeProfileFromOrder } from "../intelligence/consignee-intelligence.service.js";
import { recommendCourierForOrder } from "../intelligence/courier-performance.service.js";
import { updateMerchantTrustProfile } from "../intelligence/merchant-trust.service.js";
import { updateBuyerBehaviourProfile, updateCodBehaviourProfile, updateMerchantMetrics } from "../intelligence/metrics.service.js";
import {
  createOrderDataSignals,
  createOrderIntelligenceSnapshot,
  createShipmentDetailsForOrder
} from "../intelligence/order-intelligence.service.js";
import { createPredictionOutcome } from "../intelligence/prediction-outcome.service.js";
import { buildSellerSafeOrderDecision } from "../intelligence/seller-safe-decision.service.js";
import { scoreOrder } from "../risk/risk.service.js";

export const ordersRouter = Router();

const codDecisionRank = {
 ALLOW_COD: 0,
 REQUIRE_OTP: 1,
 PREPAID_ONLY: 2,
 MANUAL_REVIEW: 3
} as const;

type OrderAutomationDecision = Awaited<ReturnType<typeof buildSellerSafeOrderDecision>>;

function stricterCodDecision(left: keyof typeof codDecisionRank, right: keyof typeof codDecisionRank) {
 return codDecisionRank[left] >= codDecisionRank[right] ? left : right;
}

function riskReasons(value: unknown) {
 return Array.isArray(value) ? value.map((reason) => String(reason)) : [];
}

function codShieldRiskTier(decision: Pick<OrderAutomationDecision, "codDecision" | "shipmentDecision" | "automationStatus">) {
 if (decision.codDecision === "PREPAID_ONLY" || decision.shipmentDecision === "DO_NOT_SHIP") return "HIGH";
 if (decision.codDecision === "MANUAL_REVIEW" || decision.automationStatus === "INTERNAL_REVIEW") return "HIGH";
 if (decision.codDecision === "REQUIRE_OTP" || decision.automationStatus === "OTP_SENT") return "MEDIUM";
 if (decision.automationStatus === "ADDRESS_CORRECTION_SENT") return "MEDIUM";
 return "LOW";
}

function recommendedCodShieldAction(decision: Pick<OrderAutomationDecision, "codDecision" | "automationStatus" | "pendingRequiredAction">) {
 if (decision.pendingRequiredAction === "BUYER_ADDRESS_CONFIRMATION" || decision.automationStatus === "ADDRESS_CORRECTION_SENT") {
   return "Confirm buyer address before shipment.";
 }

 if (decision.codDecision === "PREPAID_ONLY" || decision.automationStatus === "PREPAID_LINK_SENT") {
   return "Request prepaid conversion before shipping this COD order.";
 }

 if (decision.codDecision === "REQUIRE_OTP" || decision.automationStatus === "OTP_SENT") {
   return "Confirm buyer intent before releasing the COD shipment.";
 }

 if (decision.pendingRequiredAction === "SELLER_APPROVAL_REQUIRED") {
   return "Ask the seller to approve this order before shipment.";
 }

 return "Monitor this order and proceed only after required checks clear.";
}

function sellerSafeRiskSummary(decision: Pick<OrderAutomationDecision, "sellerMessage" | "shortReasons">) {
 return [
   decision.sellerMessage,
   ...decision.shortReasons
 ].filter(Boolean).slice(0, 4);
}

function decimalToNumber(value: unknown) {
 if (value === null || value === undefined) return null;
 if (typeof value === "number") return Number.isFinite(value) ? value : null;
 if (typeof value === "string") {
   const numeric = Number(value);
   return Number.isFinite(numeric) ? numeric : null;
 }

 if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
   const numeric = value.toNumber();
   return Number.isFinite(numeric) ? numeric : null;
 }

 const numeric = Number(value);
 return Number.isFinite(numeric) ? numeric : null;
}

function kgFromGrams(value: unknown) {
 const grams = decimalToNumber(value);
 if (grams === null) return null;
 return Math.round((grams / 1000) * 100) / 100;
}

function shipmentWeightSummary(input: {
 weightGrams?: number | null;
 shipmentDetails?: {
   weightGrams?: number | null;
   volumetricWeight?: unknown;
 } | null;
}) {
 const deadWeightKg = kgFromGrams(input.shipmentDetails?.weightGrams ?? input.weightGrams);
 const volumetricWeightKg = decimalToNumber(input.shipmentDetails?.volumetricWeight);
 const chargeableWeightKg = [deadWeightKg, volumetricWeightKg]
   .filter((value): value is number => value !== null && Number.isFinite(value))
   .reduce<number | null>((max, value) => max === null ? value : Math.max(max, value), null);

 return {
   deadWeightKg,
   volumetricWeightKg,
   chargeableWeightKg
 };
}

type SellerOrderShipmentDetails = {
  courierId?: string | null;
  awb?: string | null;
  trackingNumber?: string | null;
  shipmentStatus?: string | null;
  weightGrams?: number | null;
  volumetricWeight?: unknown;
} | null;

type SellerOrderSource = {
  id: string;
  merchantId: string;
  externalOrderId: string;
  buyerName: string;
  city: string;
  state: string;
  pincode: string;
  orderValue: number;
  codAmount: number;
  paymentMode: string;
  weightGrams?: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  shipmentDetails?: SellerOrderShipmentDetails;
};

type SellerOrderCourier = {
  id?: string;
  name?: string | null;
  code?: string | null;
};

type SellerOrderCourierShipment = {
  id: string;
  orderId?: string | null;
  awbNumber: string;
  status: string;
  weightGrams?: number | null;
  trackingUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
  courier: SellerOrderCourier;
  firstShipmentRequest?: {
    merchantId: string;
  } | null;
};

type SellerOrderCodRemittance = {
  id: string;
  merchantId: string;
  awb?: string | null;
  orderId?: string | null;
  externalOrderId?: string | null;
  remittedAmount?: unknown;
  remittedAt?: Date | null;
  utr?: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type SellerOrderSettlement = {
  merchantId: string;
  orderId?: string | null;
  awb?: string | null;
  status: string;
  sellerPayable?: unknown;
  approvedAt?: Date | null;
  settledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function latestTimestamp(value: { updatedAt: Date; createdAt: Date }) {
  return Math.max(value.updatedAt.getTime(), value.createdAt.getTime());
}

function courierShipmentMatchesOrder(shipment: SellerOrderCourierShipment, order: SellerOrderSource) {
  if (!shipment.orderId) return false;
  if (shipment.firstShipmentRequest?.merchantId && shipment.firstShipmentRequest.merchantId !== order.merchantId) {
    return false;
  }

  return shipment.orderId === order.id || shipment.orderId === order.externalOrderId;
}

function findCourierShipmentForOrder(order: SellerOrderSource, shipmentsByOrderKey: Map<string, SellerOrderCourierShipment[]>) {
  const candidates = [
    ...(shipmentsByOrderKey.get(order.id) ?? []),
    ...(shipmentsByOrderKey.get(order.externalOrderId) ?? [])
  ];
  const seen = new Set<string>();

  return candidates
    .filter((shipment) => {
      if (seen.has(shipment.id)) return false;
      seen.add(shipment.id);
      return courierShipmentMatchesOrder(shipment, order);
    })
    .sort((left, right) => latestTimestamp(right) - latestTimestamp(left))[0] ?? null;
}

function buildCourierShipmentMap(courierShipments: SellerOrderCourierShipment[]) {
  const shipmentsByOrderKey = new Map<string, SellerOrderCourierShipment[]>();

  for (const shipment of courierShipments) {
    if (!shipment.orderId) continue;
    const shipments = shipmentsByOrderKey.get(shipment.orderId) ?? [];
    shipments.push(shipment);
    shipmentsByOrderKey.set(shipment.orderId, shipments);
  }

  for (const shipments of shipmentsByOrderKey.values()) {
    shipments.sort((left, right) => latestTimestamp(right) - latestTimestamp(left));
  }

  return shipmentsByOrderKey;
}

function shipmentWeightFromCourierShipment(
  courierShipment: SellerOrderCourierShipment | null,
  fallback: ReturnType<typeof shipmentWeightSummary>
) {
  if (!courierShipment) return fallback;

  const courierWeightKg = kgFromGrams(courierShipment.weightGrams);
  return {
    deadWeightKg: courierWeightKg ?? fallback.deadWeightKg,
    volumetricWeightKg: fallback.volumetricWeightKg,
    chargeableWeightKg: courierWeightKg ?? fallback.chargeableWeightKg
  };
}

function trackingUrlForAwb(awbNumber: string | null) {
  return awbNumber ? `/tracking/?awb=${encodeURIComponent(awbNumber)}` : null;
}

function normalizedStatus(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isDeliveredShipmentStatus(value: unknown) {
  return normalizedStatus(value) === "delivered";
}

function isCodPaymentMode(value: unknown) {
  return String(value || "").trim().toUpperCase() === "COD";
}

function codRemittanceMatchesOrder(
  remittance: SellerOrderCodRemittance,
  order: SellerOrderSource,
  awbNumber: string | null
) {
  if (remittance.merchantId !== order.merchantId) return false;
  if (awbNumber && remittance.awb === awbNumber) return true;
  if (remittance.orderId === order.id || remittance.orderId === order.externalOrderId) return true;
  return remittance.externalOrderId === order.externalOrderId;
}

function findCodRemittanceForOrder(
  order: SellerOrderSource,
  awbNumber: string | null,
  codRemittances: SellerOrderCodRemittance[]
) {
  return codRemittances
    .filter((remittance) => codRemittanceMatchesOrder(remittance, order, awbNumber))
    .filter((remittance) => decimalToNumber(remittance.remittedAmount) !== null || Boolean(remittance.remittedAt))
    .sort((left, right) => latestTimestamp(right) - latestTimestamp(left))[0] ?? null;
}

function sellerSettlementMatchesOrder(
  settlement: SellerOrderSettlement,
  order: SellerOrderSource,
  awbNumber: string | null
) {
  if (settlement.merchantId !== order.merchantId) return false;
  if (awbNumber && settlement.awb === awbNumber) return true;
  return settlement.orderId === order.id || settlement.orderId === order.externalOrderId;
}

function findSellerSettlementForOrder(
  order: SellerOrderSource,
  awbNumber: string | null,
  sellerSettlements: SellerOrderSettlement[]
) {
  return sellerSettlements
    .filter((settlement) => sellerSettlementMatchesOrder(settlement, order, awbNumber))
    .sort((left, right) => latestTimestamp(right) - latestTimestamp(left))[0] ?? null;
}

export function buildSellerSafeOrders(input: {
  orders: SellerOrderSource[];
  courierById?: Map<string, SellerOrderCourier>;
  courierShipments?: SellerOrderCourierShipment[];
  codRemittances?: SellerOrderCodRemittance[];
  sellerSettlements?: SellerOrderSettlement[];
}) {
  const courierById = input.courierById ?? new Map<string, SellerOrderCourier>();
  const shipmentsByOrderKey = buildCourierShipmentMap(input.courierShipments ?? []);
  const codRemittances = input.codRemittances ?? [];
  const sellerSettlements = input.sellerSettlements ?? [];

  return input.orders.map((order) => {
    const shipmentDetails = order.shipmentDetails ?? null;
    const courierShipment = findCourierShipmentForOrder(order, shipmentsByOrderKey);
    const shipmentDetailsCourier = shipmentDetails?.courierId ? courierById.get(shipmentDetails.courierId) : null;
    const fallbackWeight = shipmentWeightSummary(order);
    const shipmentWeight = shipmentWeightFromCourierShipment(courierShipment, fallbackWeight);
    const awbNumber = courierShipment?.awbNumber ?? shipmentDetails?.awb ?? null;
    const carrier = courierShipment?.courier.name
      ?? courierShipment?.courier.code
      ?? shipmentDetailsCourier?.name
      ?? shipmentDetailsCourier?.code
      ?? shipmentDetails?.courierId
      ?? null;
    const shipmentStatus = courierShipment?.status ?? shipmentDetails?.shipmentStatus ?? order.status;
    const isDelivered = isDeliveredShipmentStatus(shipmentStatus) || isDeliveredShipmentStatus(order.status);
    const codRemittance = isCodPaymentMode(order.paymentMode) && isDelivered
      ? findCodRemittanceForOrder(order, awbNumber, codRemittances)
      : null;
    const codRemittanceStatus = isCodPaymentMode(order.paymentMode) && isDelivered
      ? codRemittance ? "reconciled" : "pending_reconciliation"
      : null;
    const codRemittanceReadiness = codRemittanceStatus === "reconciled"
      ? "reconciled"
      : codRemittanceStatus === "pending_reconciliation"
        ? "tracking_started"
        : null;
    const sellerSettlement = codRemittanceStatus === "reconciled"
      ? findSellerSettlementForOrder(order, awbNumber, sellerSettlements)
      : null;
    const sellerSettlementStatus = sellerSettlement?.status ?? null;
    const sellerPayoutReadiness = sellerSettlementStatus === "APPROVED"
      ? "approved_for_review"
      : sellerSettlementStatus === "SETTLED"
        ? "paid"
        : codRemittanceStatus === "reconciled"
          ? "ready_for_review"
          : null;
    const sellerPayoutApprovalStatus = sellerSettlementStatus === "APPROVED"
      ? "approved_not_paid"
      : sellerSettlementStatus === "SETTLED"
        ? "paid"
        : sellerSettlementStatus === "PENDING"
          ? "pending_review"
          : null;

    return {
      id: order.id,
      merchantId: order.merchantId,
      externalOrderId: order.externalOrderId,
      orderId: order.externalOrderId,
      customerName: order.buyerName,
      buyerName: order.buyerName,
      city: order.city,
      state: order.state,
      pincode: order.pincode,
      shippingPincode: order.pincode,
      declaredValue: order.orderValue,
      orderValue: order.orderValue,
      codAmount: order.codAmount,
      paymentMode: order.paymentMode,
      weightGrams: order.weightGrams ?? null,
      status: order.status,
      isDelivered,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      awb: awbNumber,
      awbNumber,
      carrier,
      shipmentStatus,
      trackingNumber: courierShipment?.awbNumber ?? shipmentDetails?.trackingNumber ?? null,
      trackingUrl: courierShipment?.trackingUrl ?? trackingUrlForAwb(awbNumber),
      deadWeightKg: shipmentWeight.deadWeightKg,
      volumetricWeightKg: shipmentWeight.volumetricWeightKg,
      chargeableWeightKg: shipmentWeight.chargeableWeightKg,
      shipmentWeight: {
        deadWeightKg: shipmentWeight.deadWeightKg,
        volumetricWeightKg: shipmentWeight.volumetricWeightKg,
        chargeableWeightKg: shipmentWeight.chargeableWeightKg
      },
      codRemittanceStatus,
      codRemittanceReadiness,
      codRemittedAmount: codRemittance ? decimalToNumber(codRemittance.remittedAmount) : null,
      codRemittedAt: codRemittance?.remittedAt ?? null,
      sellerPayoutReadiness,
      sellerPayoutApprovalStatus,
      sellerPayoutApprovedAmount: sellerSettlementStatus === "APPROVED"
        ? decimalToNumber(sellerSettlement?.sellerPayable)
        : null,
      sellerPayoutApprovedAt: sellerSettlementStatus === "APPROVED" ? sellerSettlement?.approvedAt ?? null : null,
      sellerPayoutPaid: sellerSettlementStatus === "SETTLED"
    };
  });
}

export function buildOrderAutomationPayloads(
 order: {
   id: string;
   merchantId: string;
   externalOrderId: string;
   buyerName: string;
   buyerPhone: string;
   addressLine1: string;
   addressLine2: string | null;
   city: string;
   state: string;
   pincode: string;
   orderValue: number;
   codAmount: number;
   paymentMode: string;
 },
 decision: OrderAutomationDecision
) {
 const basePayload = {
   orderId: order.id,
   externalOrderId: order.externalOrderId,
   orderValue: order.orderValue,
   codAmount: order.codAmount,
   paymentMode: order.paymentMode,
   buyerContact: {
     name: order.buyerName,
     phone: order.buyerPhone
   },
   destination: {
     city: order.city,
     state: order.state,
     pincode: order.pincode
   },
   codDecision: decision.codDecision,
   shipmentDecision: decision.shipmentDecision,
   automationStatus: decision.automationStatus,
   pendingRequiredAction: decision.pendingRequiredAction,
   riskTier: codShieldRiskTier(decision),
   sellerSafeRiskSummary: sellerSafeRiskSummary(decision),
   recommendedAction: recommendedCodShieldAction(decision)
 };

 return {
   orderCreated: basePayload,
   codRiskHigh: {
     ...basePayload,
     eventIntent: "COD_SHIELD_REVIEW"
   },
   addressConfirmation: {
     ...basePayload,
     eventIntent: "ADDRESS_CONFIRMATION",
     shippingAddress: {
       line1: order.addressLine1,
       line2: order.addressLine2,
       city: order.city,
       state: order.state,
       pincode: order.pincode
     }
   }
 };
}

export function buildOrderAutomationEvents(order: Parameters<typeof buildOrderAutomationPayloads>[0], decision: OrderAutomationDecision) {
 const payloads = buildOrderAutomationPayloads(order, decision);
 const events = [
   {
     merchantId: order.merchantId,
     eventKey: "order.created",
     source: "orders-api",
     sourceId: order.id,
     idempotencyKey: `order.created:${order.id}`,
     payload: payloads.orderCreated
   }
 ];

 if (decision.codDecision !== "ALLOW_COD") {
   events.push({
     merchantId: order.merchantId,
     eventKey: "order.cod_risk_high",
     source: "orders-api",
     sourceId: order.id,
     idempotencyKey: `order.cod_risk_high:${order.id}`,
     payload: payloads.codRiskHigh
   });
 }

 if (decision.automation.timeline.some((action) => action.actionType === "SEND_ADDRESS_CORRECTION_LINK")) {
   events.push({
     merchantId: order.merchantId,
     eventKey: "order.address_confirmation_required",
     source: "orders-api",
     sourceId: order.id,
     idempotencyKey: `order.address_confirmation_required:${order.id}`,
     payload: payloads.addressConfirmation
   });
 }

 return events;
}

const createOrderSchema = z.object({
 externalOrderId:z.string(),
 buyerName:z.string(),
 buyerPhone:z.string(),
 addressLine1:z.string(),
 addressLine2:z.string().optional(),
 city:z.string(),
 state:z.string(),
 pincode:z.string(),
 orderValue:z.number(),
 codAmount:z.number().default(0),
 paymentMode:z.enum(["PREPAID","COD"]),
 weightGrams:z.number().optional(),
 skuId:z.string().optional(),
 productCategory:z.string().optional(),
 itemCount:z.number().int().positive().optional(),
 productTitle:z.string().optional(),
 productTitleNormalized:z.string().optional(),
 salesChannel:z.string().optional(),
 storePlatform:z.string().optional(),
 utmSource:z.string().optional(),
 utmMedium:z.string().optional(),
 utmCampaign:z.string().optional(),
 campaignId:z.string().optional(),
 couponCode:z.string().optional(),
 discountAmount:z.number().optional(),
 discountPercent:z.number().optional(),
 otpVerified:z.boolean().optional(),
 whatsappConfirmed:z.boolean().optional(),
 callConfirmed:z.boolean().optional(),
 failedOtpAttempts:z.number().int().nonnegative().optional(),
 sellerProcessingTimeMinutes:z.number().int().nonnegative().optional(),
 shippingChargeToSeller:z.number().optional(),
 courierCostToShipmastr:z.number().optional(),
 codFeeCharged:z.number().optional(),
 codFeeCost:z.number().optional(),
 rtoCost:z.number().optional(),
 netMargin:z.number().optional(),
 marginAfterRto:z.number().optional(),
 promisedPickupDate:z.coerce.date().optional(),
 promisedDeliveryDate:z.coerce.date().optional(),
 declaredWeight:z.number().optional(),
 chargedWeight:z.number().optional(),
 courierMeasuredWeight:z.number().optional(),
 weightDisputeRaised:z.boolean().optional(),
 manualEditCount:z.number().int().nonnegative().optional(),
 addressEditedAfterCreation:z.boolean().optional(),
 paymentModeChangedAfterCreation:z.boolean().optional()
});

ordersRouter.post(
"/",
requireIdempotency,
async(req,res)=>{
 const body=createOrderSchema.parse(req.body);

 try {
   const result = await prisma.$transaction(async (tx) => {
     const order = await tx.order.create({
       data: {
        merchantId: req.auth!.merchantId,
        externalOrderId: body.externalOrderId,
        buyerName: body.buyerName,
        buyerPhone: body.buyerPhone,
        addressLine1: body.addressLine1,
        addressLine2: body.addressLine2 ?? null,
        city: body.city,
        state: body.state,
        pincode: body.pincode,
        orderValue: body.orderValue,
        codAmount: body.codAmount,
        paymentMode: body.paymentMode,
        weightGrams: body.weightGrams ?? null
       }
     });

     const risk = await scoreOrder(order.id, tx);
     const scoredOrder = { ...order, status: "RISK_SCORED" as const };
     const codDecision = await decideCodEligibility(order, tx);

     await updateAddressFingerprint(order, tx);
     await updateBuyerBehaviourProfile(order, tx);
     await updateCodBehaviourProfile(order, tx);
     await updateConsigneeProfileFromOrder(scoredOrder, tx);

     const [consigneeDecision, metrics, merchantTrust] = await Promise.all([
       getConsigneeDecision(scoredOrder, tx),
       updateMerchantMetrics(order.merchantId, tx),
       updateMerchantTrustProfile(order.merchantId, tx)
     ]);
     const finalCodDecision = stricterCodDecision(consigneeDecision.codDecision, codDecision.decision);
     const shipmentDecision = risk.decision === "BLOCK"
       ? "DO_NOT_SHIP"
       : risk.decision === "HOLD"
         ? "HOLD"
         : risk.decision === "VERIFY" && consigneeDecision.shipmentDecision === "SHIP"
           ? "VERIFY_BEFORE_SHIP"
           : consigneeDecision.shipmentDecision;
     const combinedReasons = [
       ...riskReasons(risk.reasons),
       ...codDecision.reasons,
       ...consigneeDecision.reasons
     ];

     const merchantReasons = Array.isArray(merchantTrust.reasons) ? merchantTrust.reasons.map((reason) => String(reason)) : [];
     const overallRiskScore = Math.max(consigneeDecision.overallRiskScore, codDecision.score, risk.score);
     const [shipmentDetails, courierRecommendation] = await Promise.all([
       createShipmentDetailsForOrder(order, tx),
       recommendCourierForOrder(order.id, tx)
     ]);

     await createOrderDataSignals(order, body, tx);
     await createOrderIntelligenceSnapshot({
       order,
       buyerPhoneHash: consigneeDecision.phoneHash,
       addressHash: consigneeDecision.addressHash,
       consigneeScore: consigneeDecision.score,
       consigneeTier: consigneeDecision.tier,
       consigneeLabel: consigneeDecision.label,
       consigneeReasons: consigneeDecision.reasons,
       merchantTrustScore: merchantTrust.trustScore,
       merchantTrustTier: merchantTrust.tier,
       merchantReasons,
       courierId: courierRecommendation?.courierId ?? null,
       courierScore: courierRecommendation?.score ?? null,
       courierReasons: Array.isArray(courierRecommendation?.reasons)
         ? courierRecommendation.reasons.map((reason) => String(reason))
         : [],
       addressConfidenceScore: consigneeDecision.addressConfidenceScore,
       pincodeRiskScore: consigneeDecision.pincodeRiskScore,
       codRiskScore: consigneeDecision.codRiskScore,
       rtoRiskScore: consigneeDecision.rtoRiskScore,
       fraudRiskScore: consigneeDecision.fraudRiskScore,
       overallRiskScore,
       codDecision: finalCodDecision,
       shipmentDecision,
       riskReasons: combinedReasons,
       signals: body
     }, tx);
     await createPredictionOutcome({
       orderId: order.id,
       merchantId: order.merchantId,
       predictedConsigneeTier: consigneeDecision.tier,
       predictedCodDecision: finalCodDecision,
       predictedShipmentDecision: shipmentDecision,
       predictedRtoRiskScore: consigneeDecision.rtoRiskScore,
       predictedCourierId: courierRecommendation?.courierId ?? null
     }, tx);
     await handleOrderCreatedAutonomy(order.id, tx);

     await tx.riskDecision.create({
       data: {
        merchantId: order.merchantId,
        orderId: order.id,
        phoneHash: codDecision.phoneHash,
        addressHash: codDecision.addressHash,
        riskLevel: codDecision.riskLevel,
        decision: codDecision.riskDecision,
        codDecision: codDecision.decision,
        riskScore: codDecision.score,
        addressConfidence: risk.addressConfidence,
        reasons: codDecision.reasons,
        metadata: {
          source: "order_created",
          legacyRiskDecision: risk.decision
        }
       }
     });

     await tx.auditLog.create({
       data: {
        merchantId: req.auth!.merchantId,
        actorId: req.auth!.userId,
        action: "ORDER_CREATED_AND_RISK_SCORED",
        entityType: "Order",
        entityId: order.id,
        metadata: {
          externalOrderId: order.externalOrderId,
          riskScore: risk.score,
          riskDecision: risk.decision,
          codDecision: codDecision.decision
        }
       }
     });

     return {
       order,
       decision: await buildSellerSafeOrderDecision(order.id, order.merchantId, tx)
     };
   });

   const eventsToEmit = buildOrderAutomationEvents(result.order, result.decision)
     .map((event) => emitAutomationEvent(event));

   void Promise.all(eventsToEmit).catch((error) =>
     prisma.auditLog.create({
       data: {
         merchantId: result.order.merchantId,
         actorId: req.auth!.userId,
         action: "automation.order_event_emit_failed",
         entityType: "Order",
         entityId: result.order.id,
         metadata: {
           error: error instanceof Error ? error.message : "Unknown automation event failure"
         }
       }
     }).catch(() => undefined)
   );

   res.status(201).json(result);
 } catch (err) {
   if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
     throw new HttpError(409, "ORDER_ALREADY_EXISTS", {
       externalOrderId: body.externalOrderId
     });
   }

   throw err;
 }
});

ordersRouter.get("/:orderId/automation", async (req, res) => {
 const decision = await buildSellerSafeOrderDecision(req.params.orderId, req.auth!.merchantId);

 res.json({ automation: decision.automation });
});

ordersRouter.get("/:orderId/communications", async (req, res) => {
 const decision = await buildSellerSafeOrderDecision(req.params.orderId, req.auth!.merchantId);

 res.json({ communications: decision.communications });
});

ordersRouter.get("/:orderId/decision", async (req, res) => {
 const decision = await buildSellerSafeOrderDecision(req.params.orderId, req.auth!.merchantId);

 res.json({ decision });
});

ordersRouter.get("/:orderId/intelligence-summary", async (req, res) => {
 const decision = await buildSellerSafeOrderDecision(req.params.orderId, req.auth!.merchantId);

 res.json({
   intelligenceSummary: {
    shipmentStatus: decision.shipmentStatus,
    awb: decision.awb,
    trackingNumber: decision.trackingNumber,
    buyerTierLabel: decision.buyerTierLabel,
    codDecision: decision.codDecision,
    shipmentDecision: decision.shipmentDecision,
    automationStatus: decision.automationStatus,
    pendingRequiredAction: decision.pendingRequiredAction,
    courierRecommendation: decision.courierRecommendation,
    shortReasons: decision.shortReasons,
    sellerMessage: decision.sellerMessage
   }
 });
});

ordersRouter.post("/:orderId/automation/:actionId/approve", async (req, res) => {
 const action = await approveAutonomousAction({
   orderId: req.params.orderId,
   actionId: req.params.actionId,
   merchantId: req.auth!.merchantId,
   approvedBy: req.auth!.userId
 });

 res.json({ action });
});

ordersRouter.post("/:orderId/automation/:actionId/reject", async (req, res) => {
 const result = await rejectAutonomousAction({
   orderId: req.params.orderId,
   actionId: req.params.actionId,
   merchantId: req.auth!.merchantId,
   actorId: req.auth!.userId
 });

 res.json({ rejected: result.count });
});

ordersRouter.get("/",async(req,res)=>{
 const orders=await prisma.order.findMany({
   where:{
    merchantId:req.auth!.merchantId
   },
   orderBy:{
     createdAt:"desc"
   },
   include:{
     shipmentDetails:true
   }
 });

 const orderKeys = Array.from(new Set(
   orders.flatMap((order) => [order.id, order.externalOrderId]).filter(Boolean)
 ));
 const courierShipments = orderKeys.length
   ? await prisma.courierShipment.findMany({
     where: { orderId: { in: orderKeys } },
     orderBy: [
       { updatedAt: "desc" },
       { createdAt: "desc" }
     ],
     include: {
       courier: { select: { id: true, name: true, code: true } },
       firstShipmentRequest: { select: { merchantId: true } }
     }
   })
   : [];
 const courierIds = Array.from(new Set(
   orders
     .map((order) => order.shipmentDetails?.courierId)
     .filter((courierId): courierId is string => Boolean(courierId))
 ));
 const couriers = courierIds.length
   ? await prisma.courierPartner.findMany({
     where: { id: { in: courierIds } },
     select: { id: true, name: true, code: true }
   })
   : [];
 const courierById = new Map(couriers.map((courier) => [courier.id, courier]));
 const awbKeys = Array.from(new Set([
   ...courierShipments.map((shipment) => shipment.awbNumber).filter(Boolean),
   ...orders.map((order) => order.shipmentDetails?.awb).filter((awb): awb is string => Boolean(awb))
 ]));
 const codRemittanceClauses = [
   orderKeys.length ? { orderId: { in: orderKeys } } : null,
   orderKeys.length ? { externalOrderId: { in: orderKeys } } : null,
   awbKeys.length ? { awb: { in: awbKeys } } : null
 ].filter((clause): clause is NonNullable<typeof clause> => Boolean(clause));
 const codRemittances = codRemittanceClauses.length
   ? await prisma.codRemittance.findMany({
     where: {
       merchantId: req.auth!.merchantId,
       OR: codRemittanceClauses
     },
     orderBy: [
       { updatedAt: "desc" },
       { createdAt: "desc" }
     ]
   })
   : [];
 const sellerSettlementClauses = [
   orderKeys.length ? { orderId: { in: orderKeys } } : null,
   awbKeys.length ? { awb: { in: awbKeys } } : null
 ].filter((clause): clause is NonNullable<typeof clause> => Boolean(clause));
 const sellerSettlements = sellerSettlementClauses.length
   ? await prisma.sellerSettlement.findMany({
     where: {
       merchantId: req.auth!.merchantId,
       OR: sellerSettlementClauses
     },
     orderBy: [
       { updatedAt: "desc" },
       { createdAt: "desc" }
     ]
   })
   : [];

 const sellerSafeOrders = buildSellerSafeOrders({ orders, courierById, courierShipments, codRemittances, sellerSettlements });

 res.json({orders:sellerSafeOrders});
});

ordersRouter.get("/:id",async(req,res)=>{
 const order=await prisma.order.findFirstOrThrow({
   where:{
    id:req.params.id,
    merchantId:req.auth!.merchantId
   }
 });
 const decision = await buildSellerSafeOrderDecision(order.id, order.merchantId);

 res.json({order, decision});
});
