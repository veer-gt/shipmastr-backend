import type { CodDecision, Order, Prisma, RiskDecisionType, RiskLevel } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { scoreAddressConfidence } from "./address-intelligence.service.js";
import { addressHash, phoneHash } from "./fingerprint.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type CodEligibilityResult = {
  decision: CodDecision;
  riskLevel: RiskLevel;
  riskDecision: RiskDecisionType;
  score: number;
  reasons: string[];
  phoneHash: string;
  addressHash: string;
};

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function level(score: number): RiskLevel {
  if (score >= 85) return "CRITICAL";
  if (score >= 65) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}

function decisions(score: number, isCod: boolean): Pick<CodEligibilityResult, "decision" | "riskDecision"> {
  if (!isCod) return { decision: "ALLOW_COD", riskDecision: "ALLOW" };
  if (score >= 85) return { decision: "PREPAID_ONLY", riskDecision: "BLOCK" };
  if (score >= 65) return { decision: "PREPAID_ONLY", riskDecision: "PREPAID_ONLY" };
  if (score >= 40) return { decision: "REQUIRE_OTP", riskDecision: "OTP_REQUIRED" };
  return { decision: "ALLOW_COD", riskDecision: "ALLOW" };
}

export function calculateCodDecisionForSignals(input: {
  isCod: boolean;
  codAmount: number;
  addressConfidence: number;
  buyerRtoOrders?: number;
  buyerNdrOrders?: number;
  codSuccessRate?: number | null;
  codOrderCount?: number;
  pincodeRtoRate?: number | null;
}) {
  let score = input.isCod ? 20 : 8;
  const reasons: string[] = [];

  if (input.isCod) reasons.push("COD order");
  if (input.codAmount >= 1500) {
    score += 15;
    reasons.push("High COD amount");
  }
  if (input.codAmount >= 3000) {
    score += 15;
    reasons.push("Very high COD amount");
  }
  if (input.addressConfidence < 60) {
    score += 18;
    reasons.push("Low address confidence");
  }
  if ((input.buyerRtoOrders || 0) > 0) {
    score += Math.min(25, (input.buyerRtoOrders || 0) * 10);
    reasons.push("Buyer has RTO history");
  }
  if ((input.buyerNdrOrders || 0) > 1) {
    score += Math.min(15, (input.buyerNdrOrders || 0) * 5);
    reasons.push("Buyer has repeated NDR history");
  }
  if ((input.codOrderCount || 0) >= 3 && input.codSuccessRate !== null && input.codSuccessRate !== undefined && input.codSuccessRate < 0.55) {
    score += 18;
    reasons.push("Weak COD delivery success");
  }
  if (input.pincodeRtoRate !== null && input.pincodeRtoRate !== undefined && input.pincodeRtoRate > 0.18) {
    score += 12;
    reasons.push("High RTO pincode");
  }

  score = clamp(score);
  return {
    ...decisions(score, input.isCod),
    riskLevel: level(score),
    score,
    reasons
  };
}

export async function decideCodEligibility(order: Order, client: Db = prisma): Promise<CodEligibilityResult> {
  const pHash = phoneHash(order.buyerPhone);
  const aHash = addressHash(order);
  const address = scoreAddressConfidence(order);
  const [buyer, codProfile, pincodeIntel] = await Promise.all([
    client.buyerBehaviourProfile.findUnique({
      where: { merchantId_phoneHash: { merchantId: order.merchantId, phoneHash: pHash } }
    }),
    client.codBehaviourProfile.findUnique({
      where: { merchantId_phoneHash: { merchantId: order.merchantId, phoneHash: pHash } }
    }),
    client.pincodeIntelligence.findUnique({ where: { pincode: order.pincode } })
  ]);

  const calculated = calculateCodDecisionForSignals({
    isCod: order.paymentMode === "COD",
    codAmount: order.codAmount,
    addressConfidence: address.score,
    buyerRtoOrders: buyer?.rtoOrders || 0,
    buyerNdrOrders: buyer?.ndrOrders || 0,
    codSuccessRate: codProfile ? Number(codProfile.codSuccessRate) : null,
    codOrderCount: codProfile?.totalCodOrders || 0,
    pincodeRtoRate: pincodeIntel ? Number(pincodeIntel.rtoRate) : null
  });

  if (order.paymentMode === "COD") {
    await client.codVerificationAttempt.create({
      data: {
        merchantId: order.merchantId,
        orderId: order.id,
        phoneHash: pHash,
        decision: calculated.decision,
        riskLevel: calculated.riskLevel,
        metadata: { score: calculated.score, reasons: calculated.reasons }
      }
    });

    if (calculated.decision === "REQUIRE_OTP") {
      await client.codBehaviourProfile.upsert({
        where: { merchantId_phoneHash: { merchantId: order.merchantId, phoneHash: pHash } },
        create: {
          merchantId: order.merchantId,
          phoneHash: pHash,
          totalCodOrders: 1,
          otpRequiredCount: 1,
          codExposure: order.codAmount,
          decision: calculated.decision
        },
        update: {
          otpRequiredCount: { increment: 1 },
          decision: calculated.decision
        }
      });
    }
  }

  if (calculated.score >= 65) {
    await client.fraudSignal.create({
      data: {
        merchantId: order.merchantId,
        orderId: order.id,
        phoneHash: pHash,
        addressHash: aHash,
        pincode: order.pincode,
        riskLevel: calculated.riskLevel,
        score: calculated.score,
        signalType: "COD_ELIGIBILITY",
        reasons: calculated.reasons
      }
    });
  }

  return {
    ...calculated,
    phoneHash: pHash,
    addressHash: aHash
  };
}
