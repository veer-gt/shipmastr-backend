import type { Prisma, TrustTier } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { updateMerchantMetrics } from "./metrics.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export function tierFor(score: number, totalOrders: number): TrustTier {
  if (score < 25) return "SUSPENDED";
  if (score < 40) return "RISKY";
  if (score < 55) return "WATCHLIST";
  if (score >= 82 && totalOrders >= 100) return "PREFERRED";
  if (score >= 68 && totalOrders >= 15) return "TRUSTED";
  return "NEW";
}

export function calculateMerchantTrustTier(input: {
  trustScore: number;
  totalOrders: number;
  rtoRate: number;
  ndrRate: number;
  fraudSignalCount: number;
}) {
  let score = input.trustScore;
  const reasons: string[] = [];

  if (input.totalOrders < 5) {
    score = Math.min(score, 58);
    reasons.push("Limited order history");
  }
  if (input.rtoRate > 0.22) reasons.push("Elevated RTO rate");
  if (input.ndrRate > 0.28) reasons.push("Elevated NDR rate");
  if (input.fraudSignalCount > 0) reasons.push("Fraud signals present");
  if (input.rtoRate > 0.35) score -= 18;
  if (input.ndrRate > 0.35) score -= 10;
  if (input.fraudSignalCount > 2) score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    tier: tierFor(score, input.totalOrders),
    reasons
  };
}

export async function updateMerchantTrustProfile(merchantId: string, client: Db = prisma) {
  const previous = await client.merchantTrustProfile.findUnique({ where: { merchantId } });
  const metrics = await updateMerchantMetrics(merchantId, client);

  const trust = calculateMerchantTrustTier({
    trustScore: metrics.trustScore,
    totalOrders: metrics.totalOrders,
    rtoRate: Number(metrics.rtoRate),
    ndrRate: Number(metrics.ndrRate),
    fraudSignalCount: metrics.fraudSignalCount
  });
  const score = trust.score;
  const reasons = [...trust.reasons];
  if (Number(metrics.deliveryRate) > 0.85 && metrics.totalOrders >= 15) reasons.push("Reliable delivery history");
  const tier = trust.tier;

  const profile = await client.merchantTrustProfile.upsert({
    where: { merchantId },
    create: {
      merchantId,
      tier,
      trustScore: score,
      totalOrders: metrics.totalOrders,
      rtoRate: metrics.rtoRate,
      ndrRate: metrics.ndrRate,
      codExposure: metrics.codExposure,
      reliabilityScore: Math.max(0, Math.min(100, Math.round(Number(metrics.deliveryRate) * 100))),
      reasons
    },
    update: {
      tier,
      trustScore: score,
      totalOrders: metrics.totalOrders,
      rtoRate: metrics.rtoRate,
      ndrRate: metrics.ndrRate,
      codExposure: metrics.codExposure,
      reliabilityScore: Math.max(0, Math.min(100, Math.round(Number(metrics.deliveryRate) * 100))),
      reasons
    }
  });

  if (!previous || previous.tier !== tier || previous.trustScore !== score) {
    await client.merchantTrustEvent.create({
      data: {
        merchantId,
        tierBefore: previous?.tier || null,
        tierAfter: tier,
        scoreBefore: previous?.trustScore || null,
        scoreAfter: score,
        reason: reasons[0] || "Trust profile recalculated",
        metadata: { reasons }
      }
    });
  }

  return profile;
}
