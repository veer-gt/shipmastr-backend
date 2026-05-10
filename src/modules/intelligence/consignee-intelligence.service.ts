import type {
  CodDecision,
  ConsigneeProfile,
  ConsigneeTier,
  Order,
  OrderStatus,
  Prisma,
  RiskLevel,
  ShipmentDecision
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { scoreAddressConfidence } from "./address-intelligence.service.js";
import { addressHash, normalizePhone as normalizePhoneValue, phoneHash } from "./fingerprint.js";

type Db = Prisma.TransactionClient | typeof prisma;

type OrderLike = Pick<
  Order,
  | "id"
  | "merchantId"
  | "buyerPhone"
  | "addressLine1"
  | "addressLine2"
  | "city"
  | "state"
  | "pincode"
  | "orderValue"
  | "codAmount"
  | "paymentMode"
  | "weightGrams"
  | "status"
  | "createdAt"
>;

export const CONSIGNEE_TIER_LABELS: Record<ConsigneeTier, string> = {
  GOLD: "Gold Buyer — High delivery confidence",
  SILVER: "Silver Buyer — Normal confidence",
  BRONZE: "Bronze Buyer — Verify before shipping",
  IRON: "Iron Buyer — COD not recommended"
};

export type ConsigneeScoreInput = {
  totalOrders?: number;
  deliveredOrders?: number;
  rtoOrders?: number;
  ndrOrders?: number;
  codOrders?: number;
  prepaidOrders?: number;
  successfulCodOrders?: number;
  failedCodOrders?: number;
  repeatCodFailures?: number;
  avgOrderValue?: number;
  maxOrderValue?: number;
  currentOrderValue?: number;
  currentCodAmount?: number;
  paymentMode?: "COD" | "PREPAID";
  addressConfidenceScore?: number | null;
  addressCount?: number;
  highRiskAddressCount?: number;
  pincodeCount?: number;
  pincodeDeliveryRate?: number | null;
  pincodeRtoRate?: number | null;
  courierPincodeDeliveryRate?: number | null;
  courierPincodeScore?: number | null;
};

export type ConsigneeScoreResult = {
  score: number;
  tier: ConsigneeTier;
  riskLevel: RiskLevel;
  label: string;
  reasons: string[];
  components: {
    cod: number;
    delivery: number;
    address: number;
    pincode: number;
    payment: number;
    purchasingPower: number;
    courierPincodeFit: number;
  };
};

export type ConsigneeDecisionResult = ConsigneeScoreResult & {
  phoneHash: string;
  addressHash: string;
  codDecision: CodDecision;
  shipmentDecision: ShipmentDecision;
  addressConfidenceScore: number;
  pincodeRiskScore: number;
  codRiskScore: number;
  rtoRiskScore: number;
  fraudRiskScore: number;
  overallRiskScore: number;
  courierScore: number | null;
  courierReasons: string[];
  dataSnapshot: Prisma.InputJsonObject;
};

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function ratio(numerator: number, denominator: number, fallback = 0) {
  return denominator > 0 ? numerator / denominator : fallback;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function tierRiskLevel(tier: ConsigneeTier): RiskLevel {
  if (tier === "GOLD") return "LOW";
  if (tier === "SILVER") return "MEDIUM";
  if (tier === "BRONZE") return "HIGH";
  return "CRITICAL";
}

export function normalizePhone(value: string) {
  return normalizePhoneValue(value);
}

export function hashPhone(value: string) {
  return phoneHash(value);
}

export function categorizeConsignee(score: number) {
  const normalizedScore = clamp(score);
  const tier: ConsigneeTier = normalizedScore >= 80
    ? "GOLD"
    : normalizedScore >= 60
      ? "SILVER"
      : normalizedScore >= 40
        ? "BRONZE"
        : "IRON";

  return {
    score: normalizedScore,
    tier,
    riskLevel: tierRiskLevel(tier),
    label: CONSIGNEE_TIER_LABELS[tier]
  };
}

export function calculateConsigneeScore(input: ConsigneeScoreInput): ConsigneeScoreResult {
  const totalOrders = input.totalOrders ?? 0;
  const deliveredOrders = input.deliveredOrders ?? 0;
  const rtoOrders = input.rtoOrders ?? 0;
  const ndrOrders = input.ndrOrders ?? 0;
  const codOrders = input.codOrders ?? 0;
  const prepaidOrders = input.prepaidOrders ?? 0;
  const successfulCodOrders = input.successfulCodOrders ?? 0;
  const failedCodOrders = input.failedCodOrders ?? 0;
  const repeatCodFailures = input.repeatCodFailures ?? 0;
  const terminalOrders = deliveredOrders + rtoOrders + ndrOrders;
  const codTerminalOrders = successfulCodOrders + failedCodOrders;
  const deliveryRate = ratio(deliveredOrders, terminalOrders, 0.68);
  const rtoRate = ratio(rtoOrders, terminalOrders, 0);
  const ndrRate = ratio(ndrOrders, terminalOrders, 0);
  const codSuccessRate = ratio(successfulCodOrders, codTerminalOrders, 0.72);
  const prepaidRatio = ratio(prepaidOrders, totalOrders, 0);
  const codRatio = ratio(codOrders, totalOrders, input.paymentMode === "COD" ? 0.55 : 0.25);
  const addressConfidence = input.addressConfidenceScore ?? 72;
  const pincodeDeliveryRate = input.pincodeDeliveryRate ?? 0.72;
  const pincodeRtoRate = input.pincodeRtoRate ?? 0.1;
  const courierDeliveryRate = input.courierPincodeDeliveryRate ?? null;
  const courierScore = input.courierPincodeScore ?? (courierDeliveryRate === null ? 62 : courierDeliveryRate * 100);
  const reasons: string[] = [];

  if (totalOrders === 0) reasons.push("NEW_BUYER");
  if (rtoOrders > 0) reasons.push("PREVIOUS_RTO");
  if (repeatCodFailures > 0 || failedCodOrders >= 2) reasons.push("REPEAT_COD_FAILURE");
  if (addressConfidence < 60) reasons.push("LOW_ADDRESS_CONFIDENCE");
  if (pincodeRtoRate >= 0.2) reasons.push("HIGH_RTO_PINCODE");
  if ((input.currentCodAmount ?? 0) >= 2500) reasons.push("HIGH_COD_AMOUNT");
  if ((input.currentCodAmount ?? 0) > Math.max(1500, (input.avgOrderValue ?? 0) * 1.8) && codOrders > 0) reasons.push("COD_SPIKE");
  if ((input.addressCount ?? 0) >= 3) reasons.push("PHONE_SEEN_WITH_MULTIPLE_ADDRESSES");
  if (prepaidOrders >= 2 && prepaidRatio >= 0.5) reasons.push("GOOD_PREPAID_HISTORY");
  if (deliveryRate >= 0.85 && totalOrders >= 3) reasons.push("HIGH_DELIVERY_SUCCESS");
  if (courierScore < 45) reasons.push("LOW_COURIER_PINCODE_SUCCESS");

  const codComponent = clamp(
    (codOrders ? codSuccessRate : 0.72) * 25
      - repeatCodFailures * 5
      - (input.paymentMode === "COD" && (input.currentCodAmount ?? 0) >= 2500 ? 4 : 0),
    0,
    25
  );
  const deliveryComponent = clamp(deliveryRate * 25 - rtoRate * 16 - ndrRate * 7, 0, 25);
  const addressComponent = clamp((addressConfidence / 100) * 15 - (input.highRiskAddressCount ?? 0) * 2, 0, 15);
  const pincodeComponent = clamp(pincodeDeliveryRate * 15 - pincodeRtoRate * 12, 0, 15);
  const paymentComponent = clamp(5 + prepaidRatio * 5 - Math.max(0, codRatio - 0.75) * 6, 0, 10);
  const purchasingPowerComponent = clamp(
    3
      + Math.min(2, (input.avgOrderValue ?? input.currentOrderValue ?? 0) / 2500)
      - ((input.currentCodAmount ?? 0) >= 5000 ? 2 : 0),
    0,
    5
  );
  const courierComponent = clamp((courierScore / 100) * 5, 0, 5);
  const score = codComponent
    + deliveryComponent
    + addressComponent
    + pincodeComponent
    + paymentComponent
    + purchasingPowerComponent
    + courierComponent;
  const category = categorizeConsignee(score);

  return {
    ...category,
    reasons,
    components: {
      cod: codComponent,
      delivery: deliveryComponent,
      address: addressComponent,
      pincode: pincodeComponent,
      payment: paymentComponent,
      purchasingPower: purchasingPowerComponent,
      courierPincodeFit: courierComponent
    }
  };
}

export function getDecisionForConsigneeTier(tier: ConsigneeTier, score: number): Pick<ConsigneeDecisionResult, "codDecision" | "shipmentDecision"> {
  if (tier === "GOLD" || tier === "SILVER") {
    return { codDecision: "ALLOW_COD", shipmentDecision: "SHIP" };
  }

  if (tier === "BRONZE") {
    return { codDecision: "REQUIRE_OTP", shipmentDecision: "VERIFY_BEFORE_SHIP" };
  }

  return {
    codDecision: score < 25 ? "MANUAL_REVIEW" : "PREPAID_ONLY",
    shipmentDecision: score < 25 ? "DO_NOT_SHIP" : "HOLD"
  };
}

function profileInput(profile: ConsigneeProfile | null, order: OrderLike): ConsigneeScoreInput {
  if (!profile) {
    return {
      totalOrders: 0,
      currentOrderValue: order.orderValue,
      currentCodAmount: order.codAmount,
      paymentMode: order.paymentMode
    };
  }

  return {
    totalOrders: profile.totalOrders,
    deliveredOrders: profile.deliveredOrders,
    rtoOrders: profile.rtoOrders,
    ndrOrders: profile.ndrOrders,
    codOrders: profile.codOrders,
    prepaidOrders: profile.prepaidOrders,
    successfulCodOrders: profile.successfulCodOrders,
    failedCodOrders: profile.failedCodOrders,
    repeatCodFailures: profile.repeatCodFailures,
    avgOrderValue: Number(profile.avgOrderValue),
    maxOrderValue: Number(profile.maxOrderValue),
    currentOrderValue: order.orderValue,
    currentCodAmount: order.codAmount,
    paymentMode: order.paymentMode,
    addressCount: profile.addressCount,
    highRiskAddressCount: profile.highRiskAddressCount,
    pincodeCount: profile.pincodeCount
  };
}

export function buildOrderIntelligenceDataSnapshot(input: {
  order: OrderLike;
  phoneHash: string;
  addressHash: string;
  decision: Omit<ConsigneeDecisionResult, "dataSnapshot" | "phoneHash" | "addressHash">;
  pincodeIntelligence?: {
    deliveryRate: number | null;
    rtoRate: number | null;
    ndrRate?: number | null;
    addressConfidence?: number | null;
  } | null;
  profile?: Pick<ConsigneeProfile, "totalOrders" | "deliveredOrders" | "rtoOrders" | "ndrOrders" | "codOrders" | "prepaidOrders" | "trustScore" | "tier"> | null;
}): Prisma.InputJsonObject {
  return {
    source: "order_created",
    order: {
      id: input.order.id,
      merchantId: input.order.merchantId,
      pincode: input.order.pincode,
      orderValue: input.order.orderValue,
      codAmount: input.order.codAmount,
      paymentMode: input.order.paymentMode,
      weightGrams: input.order.weightGrams ?? null
    },
    hashes: {
      phoneHash: input.phoneHash,
      addressHash: input.addressHash
    },
    consignee: {
      score: input.decision.score,
      tier: input.decision.tier,
      label: input.decision.label,
      reasons: input.decision.reasons,
      profile: input.profile
        ? {
            totalOrders: input.profile.totalOrders,
            deliveredOrders: input.profile.deliveredOrders,
            rtoOrders: input.profile.rtoOrders,
            ndrOrders: input.profile.ndrOrders,
            codOrders: input.profile.codOrders,
            prepaidOrders: input.profile.prepaidOrders,
            trustScore: input.profile.trustScore,
            tier: input.profile.tier
          }
        : null
    },
    risk: {
      codDecision: input.decision.codDecision,
      shipmentDecision: input.decision.shipmentDecision,
      overallRiskScore: input.decision.overallRiskScore,
      addressConfidenceScore: input.decision.addressConfidenceScore,
      pincodeRiskScore: input.decision.pincodeRiskScore,
      codRiskScore: input.decision.codRiskScore,
      rtoRiskScore: input.decision.rtoRiskScore,
      fraudRiskScore: input.decision.fraudRiskScore,
      components: input.decision.components
    },
    pincode: input.pincodeIntelligence ?? null
  };
}

function statusCounts(orders: OrderLike[]) {
  const delivered = orders.filter((order) => order.status === "DELIVERED");
  const rto = orders.filter((order) => order.status === "RTO");
  const ndr = orders.filter((order) => order.status === "NDR");
  const cancelled = orders.filter((order) => order.status === "CANCELLED");
  const cod = orders.filter((order) => order.paymentMode === "COD");
  const prepaid = orders.filter((order) => order.paymentMode === "PREPAID");
  const successfulCod = cod.filter((order) => order.status === "DELIVERED");
  const failedCod = cod.filter((order) => order.status === "RTO" || order.status === "NDR" || order.status === "CANCELLED");
  const addressHashes = new Set(orders.map((order) => addressHash(order)));
  const pincodeSet = new Set(orders.map((order) => order.pincode));
  const highRiskAddressHashes = new Set(
    orders
      .filter((order) => scoreAddressConfidence(order).score < 55)
      .map((order) => addressHash(order))
  );
  const orderValues = orders.map((order) => order.orderValue);
  const codAmounts = cod.map((order) => order.codAmount);

  return {
    totalOrders: orders.length,
    deliveredOrders: delivered.length,
    rtoOrders: rto.length,
    ndrOrders: ndr.length,
    cancelledOrders: cancelled.length,
    codOrders: cod.length,
    prepaidOrders: prepaid.length,
    postpaidOrders: 0,
    successfulCodOrders: successfulCod.length,
    failedCodOrders: failedCod.length,
    repeatCodFailures: Math.max(0, failedCod.length - 1),
    avgOrderValue: average(orderValues),
    maxOrderValue: orderValues.length ? Math.max(...orderValues) : 0,
    avgCodAmount: average(codAmounts),
    maxCodAmount: codAmounts.length ? Math.max(...codAmounts) : 0,
    addressCount: addressHashes.size,
    highRiskAddressCount: highRiskAddressHashes.size,
    pincodeCount: pincodeSet.size
  };
}

export async function updateConsigneeProfileFromOrder(order: OrderLike, client: Db = prisma) {
  const pHash = hashPhone(order.buyerPhone);
  const normalized = normalizePhone(order.buyerPhone);
  const orders = await client.order.findMany({
    where: {
      buyerPhone: {
        in: [order.buyerPhone, normalized, `91${normalized}`, `+91${normalized}`]
      }
    }
  });
  const countedOrders = orders.some((existingOrder) => existingOrder.id === order.id)
    ? orders
    : [...orders, order];
  const counts = statusCounts(countedOrders);
  const deliverySuccessRate = ratio(counts.deliveredOrders, counts.totalOrders, 0);
  const rtoRate = ratio(counts.rtoOrders, counts.totalOrders, 0);
  const ndrRate = ratio(counts.ndrOrders, counts.totalOrders, 0);
  const codSuccessRate = ratio(counts.successfulCodOrders, counts.codOrders, 0);
  const prepaidRatio = ratio(counts.prepaidOrders, counts.totalOrders, 0);
  const codRatio = ratio(counts.codOrders, counts.totalOrders, 0);
  const score = calculateConsigneeScore({
    ...counts,
    currentOrderValue: order.orderValue,
    currentCodAmount: order.codAmount,
    paymentMode: order.paymentMode,
    addressConfidenceScore: scoreAddressConfidence(order).score
  });

  return client.consigneeProfile.upsert({
    where: { phoneHash: pHash },
    create: {
      phoneHash: pHash,
      ...counts,
      deliverySuccessRate,
      rtoRate,
      ndrRate,
      codSuccessRate,
      prepaidRatio,
      codRatio,
      trustScore: score.score,
      tier: score.tier,
      riskLevel: score.riskLevel,
      lastOrderAt: order.createdAt
    },
    update: {
      ...counts,
      deliverySuccessRate,
      rtoRate,
      ndrRate,
      codSuccessRate,
      prepaidRatio,
      codRatio,
      trustScore: score.score,
      tier: score.tier,
      riskLevel: score.riskLevel,
      lastOrderAt: order.createdAt
    }
  });
}

export async function updateConsigneeProfileFromWebhook(order: OrderLike, status: OrderStatus, client: Db = prisma) {
  return updateConsigneeProfileFromOrder({ ...order, status }, client);
}

export async function getConsigneeDecision(order: OrderLike, client: Db = prisma): Promise<ConsigneeDecisionResult> {
  const pHash = hashPhone(order.buyerPhone);
  const aHash = addressHash(order);
  const address = scoreAddressConfidence(order);
  const [profile, pincodeIntel] = await Promise.all([
    client.consigneeProfile.findUnique({ where: { phoneHash: pHash } }),
    client.pincodeIntelligence.findUnique({ where: { pincode: order.pincode } })
  ]);
  const baseInput = profileInput(profile, order);
  const score = calculateConsigneeScore({
    ...baseInput,
    addressConfidenceScore: address.score,
    pincodeDeliveryRate: pincodeIntel ? Number(pincodeIntel.deliveryRate) : null,
    pincodeRtoRate: pincodeIntel ? Number(pincodeIntel.rtoRate) : null
  });
  const decision = getDecisionForConsigneeTier(score.tier, score.score);
  const pincodeRiskScore = pincodeIntel ? clamp(Number(pincodeIntel.rtoRate) * 100) : 30;
  const codRiskScore = clamp(100 - (score.components.cod / 25) * 100);
  const rtoRiskScore = clamp(Math.max(pincodeRiskScore, profile ? profile.rtoRate * 100 : 30));
  const fraudRiskScore = clamp(score.reasons.includes("REPEAT_COD_FAILURE") ? 75 : score.reasons.includes("NEW_BUYER") ? 35 : 100 - score.score);
  const overallRiskScore = clamp(100 - score.score);
  const partialDecision = {
    ...score,
    ...decision,
    addressConfidenceScore: address.score,
    pincodeRiskScore,
    codRiskScore,
    rtoRiskScore,
    fraudRiskScore,
    overallRiskScore,
    courierScore: null,
    courierReasons: [] as string[]
  };

  return {
    ...partialDecision,
    phoneHash: pHash,
    addressHash: aHash,
    dataSnapshot: buildOrderIntelligenceDataSnapshot({
      order,
      phoneHash: pHash,
      addressHash: aHash,
      decision: partialDecision,
      pincodeIntelligence: pincodeIntel
        ? {
            deliveryRate: Number(pincodeIntel.deliveryRate),
            rtoRate: Number(pincodeIntel.rtoRate),
            ndrRate: Number(pincodeIntel.ndrRate),
            addressConfidence: pincodeIntel.addressConfidence
          }
        : null,
      profile
    })
  };
}
