import type { Order, Prisma, RiskLevel } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { addressHash, normalizedAddress } from "./fingerprint.js";

type Db = Prisma.TransactionClient | typeof prisma;

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function levelFromConfidence(confidence: number): RiskLevel {
  if (confidence < 35) return "CRITICAL";
  if (confidence < 55) return "HIGH";
  if (confidence < 72) return "MEDIUM";
  return "LOW";
}

export function scoreAddressConfidence(order: Pick<Order, "addressLine1" | "addressLine2" | "city" | "state" | "pincode">) {
  const address = normalizedAddress({
    buyerPhone: "",
    addressLine1: order.addressLine1,
    addressLine2: order.addressLine2,
    city: order.city,
    state: order.state,
    pincode: order.pincode
  });

  let score = 88;
  const reasons: string[] = [];

  if (!/^\d{6}$/.test(order.pincode)) {
    score -= 28;
    reasons.push("Invalid pincode format");
  }

  if (address.length < 35) {
    score -= 20;
    reasons.push("Short address");
  }

  if (!order.city || !order.state) {
    score -= 14;
    reasons.push("Missing city or state");
  }

  if (/(test|dummy|unknown|na|n\/a)/i.test(address)) {
    score -= 20;
    reasons.push("Placeholder address terms");
  }

  if (/(near|opposite|behind|landmark)/i.test(address)) {
    score -= 6;
    reasons.push("Landmark-heavy address");
  }

  return {
    score: clamp(score),
    riskLevel: levelFromConfidence(clamp(score)),
    addressHash: addressHash({
      buyerPhone: "",
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      city: order.city,
      state: order.state,
      pincode: order.pincode
    }),
    reasons
  };
}

export async function updateAddressFingerprint(order: Order, client: Db = prisma) {
  const confidence = scoreAddressConfidence(order);
  const isRto = order.status === "RTO";
  const isNdr = order.status === "NDR";
  const isDelivered = order.status === "DELIVERED";

  const fingerprint = await client.addressFingerprint.upsert({
    where: {
      merchantId_addressHash: {
        merchantId: order.merchantId,
        addressHash: confidence.addressHash
      }
    },
    create: {
      merchantId: order.merchantId,
      addressHash: confidence.addressHash,
      pincode: order.pincode,
      totalOrders: 1,
      deliveredOrders: isDelivered ? 1 : 0,
      ndrOrders: isNdr ? 1 : 0,
      rtoOrders: isRto ? 1 : 0,
      confidenceScore: confidence.score,
      riskLevel: confidence.riskLevel,
      metadata: { reasons: confidence.reasons }
    },
    update: {
      pincode: order.pincode,
      totalOrders: { increment: 1 },
      ...(isDelivered ? { deliveredOrders: { increment: 1 } } : {}),
      ...(isNdr ? { ndrOrders: { increment: 1 } } : {}),
      ...(isRto ? { rtoOrders: { increment: 1 } } : {}),
      confidenceScore: confidence.score,
      riskLevel: confidence.riskLevel,
      metadata: { reasons: confidence.reasons }
    }
  });

  await client.pincodeIntelligence.upsert({
    where: { pincode: order.pincode },
    create: {
      pincode: order.pincode,
      totalOrders: 1,
      deliveredOrders: isDelivered ? 1 : 0,
      ndrOrders: isNdr ? 1 : 0,
      rtoOrders: isRto ? 1 : 0,
      addressConfidence: confidence.score
    },
    update: {
      totalOrders: { increment: 1 },
      ...(isDelivered ? { deliveredOrders: { increment: 1 } } : {}),
      ...(isNdr ? { ndrOrders: { increment: 1 } } : {}),
      ...(isRto ? { rtoOrders: { increment: 1 } } : {}),
      addressConfidence: confidence.score
    }
  });

  return fingerprint;
}
