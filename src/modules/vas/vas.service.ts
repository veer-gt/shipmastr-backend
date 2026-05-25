import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function money(value: unknown) {
  return Math.round(numberValue(value) * 100) / 100;
}

function paise(value: unknown) {
  return Math.round(numberValue(value) * 100);
}

function capitalBand(value: unknown) {
  const normalized = String(value || "NEW").trim().toLowerCase();
  return normalized || "new";
}

function capitalRecommendation(score: number, eligible: boolean) {
  if (eligible) {
    return "Capital products can be reviewed once lender-side products are enabled for this merchant.";
  }

  if (score >= 60) {
    return "Build more delivered-order and settlement history to unlock capital products.";
  }

  return "Settlement, insurance, and capital products will appear here once enabled for your account.";
}

export async function getVasActionCenter(
  merchantId: string,
  client: Db = prisma
) {
  if (!merchantId) {
    throw new HttpError(403, "MERCHANT_SCOPE_REQUIRED");
  }

  const [merchant, trustProfile, latestWalletEntry] = await Promise.all([
    client.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        name: true,
        onboardingStatus: true
      }
    }),
    client.merchantTrustProfile.findUnique({
      where: { merchantId },
      select: {
        merchantId: true,
        tier: true,
        trustScore: true,
        totalOrders: true,
        codExposure: true,
        reliabilityScore: true
      }
    }),
    client.sellerWalletLedger.findFirst({
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      select: {
        balanceAfter: true
      }
    })
  ]);

  if (!merchant || merchant.id !== merchantId) {
    throw new HttpError(403, "MERCHANT_SCOPE_REQUIRED");
  }

  const score = clamp(Math.round(numberValue(trustProfile?.trustScore)), 0, 100);
  const totalOrders = Math.max(0, Math.round(numberValue(trustProfile?.totalOrders)));
  const codExposure = money(trustProfile?.codExposure);
  const walletBalance = money(latestWalletEntry?.balanceAfter);
  const eligible = score >= 70 && totalOrders >= 50;
  const maxEligibleAmount = eligible
    ? money(Math.max(0, codExposure * 0.25 + walletBalance * 0.1))
    : 0;

  const settlementProducts: unknown[] = [];
  const insuranceProducts: unknown[] = [];
  const capitalProducts: unknown[] = [];
  const recommendations = eligible
    ? [{
      id: "capital-review-ready",
      title: "Capital review ready",
      description: capitalRecommendation(score, eligible),
      action: "review"
    }]
    : [];

  return {
    summary: {
      settlementProducts: settlementProducts.length,
      insurancePlans: insuranceProducts.length,
      capitalProducts: capitalProducts.length,
      capitalScore: score,
      capitalEnvelope: maxEligibleAmount,
      capitalEnvelopePaise: paise(maxEligibleAmount)
    },
    settlementProducts,
    insuranceProducts,
    capitalProducts,
    recommendations,
    capitalProfile: {
      score,
      band: capitalBand(trustProfile?.tier),
      eligible,
      maxEligibleAmount,
      maxEligibleAmountPaise: paise(maxEligibleAmount),
      recommendation: capitalRecommendation(score, eligible)
    },
    merchant: {
      name: merchant.name,
      onboardingStatus: merchant.onboardingStatus
    }
  };
}
