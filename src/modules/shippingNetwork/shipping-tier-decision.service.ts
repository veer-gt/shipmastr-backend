import { decimalToNumber, PUBLIC_SERVICE_LEVELS } from "./shipping-public-serializers.js";

export type ShippingTier = "smart" | "economy" | "express";

export type ShippingTierCandidate = {
  id: string;
  publicServiceName?: string | null;
  amountPaise: number;
  currency: string;
  estimatedDeliveryDays?: number | null;
  chargeableWeightKg?: unknown;
  codSupported?: boolean;
  pickupAvailable?: boolean;
  deliveryAvailable?: boolean;
  reliabilityScore?: number | null;
};

export type ShippingTierSelection = {
  tier: ShippingTier;
  label: typeof PUBLIC_SERVICE_LEVELS[ShippingTier];
  rateId: string;
  estimatedRate: number;
  currency: string;
  estimatedDeliveryDays: number | null;
  chargedWeightKg: number | null;
  recommended: boolean;
};

type ScoredCandidate = ShippingTierCandidate & {
  estimatedRate: number;
  estimatedDeliveryDays: number;
  reliabilityScoreSafe: number;
};

function clampReliability(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.75;
  return Math.min(1, Math.max(0, value));
}

function deliveryDays(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 99;
}

function isEligible(candidate: ShippingTierCandidate, paymentMode: string) {
  if (candidate.pickupAvailable === false || candidate.deliveryAvailable === false) return false;
  if (paymentMode === "cod" && candidate.codSupported === false) return false;
  return true;
}

function toScoredCandidate(candidate: ShippingTierCandidate): ScoredCandidate {
  return {
    ...candidate,
    estimatedRate: candidate.amountPaise,
    estimatedDeliveryDays: deliveryDays(candidate.estimatedDeliveryDays),
    reliabilityScoreSafe: clampReliability(candidate.reliabilityScore)
  };
}

function byCost(left: ScoredCandidate, right: ScoredCandidate) {
  return left.estimatedRate - right.estimatedRate || left.estimatedDeliveryDays - right.estimatedDeliveryDays;
}

function bySpeed(left: ScoredCandidate, right: ScoredCandidate) {
  return left.estimatedDeliveryDays - right.estimatedDeliveryDays || left.estimatedRate - right.estimatedRate;
}

function normalizedHighScore(value: number, min: number, max: number) {
  if (max === min) return 1;
  return 1 - (value - min) / (max - min);
}

function smartScore(candidate: ScoredCandidate, candidates: ScoredCandidate[]) {
  const rates = candidates.map((rate) => rate.estimatedRate);
  const days = candidates.map((rate) => rate.estimatedDeliveryDays);
  const costScore = normalizedHighScore(candidate.estimatedRate, Math.min(...rates), Math.max(...rates));
  const speedScore = normalizedHighScore(candidate.estimatedDeliveryDays, Math.min(...days), Math.max(...days));

  return costScore * 0.35 + speedScore * 0.35 + candidate.reliabilityScoreSafe * 0.30;
}

function toTierSelection(
  tier: ShippingTier,
  candidate: ScoredCandidate,
  recommended: boolean
): ShippingTierSelection {
  return {
    tier,
    label: PUBLIC_SERVICE_LEVELS[tier],
    rateId: candidate.id,
    estimatedRate: candidate.estimatedRate,
    currency: candidate.currency,
    estimatedDeliveryDays: candidate.estimatedDeliveryDays === 99 ? null : candidate.estimatedDeliveryDays,
    chargedWeightKg: decimalToNumber(candidate.chargeableWeightKg),
    recommended
  };
}

export function selectShippingTiers(
  candidates: ShippingTierCandidate[],
  paymentMode: string
): Record<ShippingTier, ShippingTierSelection> {
  const eligible = candidates.filter((candidate) => isEligible(candidate, paymentMode)).map(toScoredCandidate);

  if (!eligible.length) {
    throw new Error("NO_ELIGIBLE_SHIPPING_RATES");
  }

  const economy = [...eligible].sort(byCost)[0]!;
  const express = [...eligible].sort(bySpeed)[0]!;
  const smart = [...eligible].sort((left, right) => {
    const scoreDiff = smartScore(right, eligible) - smartScore(left, eligible);
    if (scoreDiff !== 0) return scoreDiff;
    return bySpeed(left, right);
  })[0]!;

  return {
    smart: toTierSelection("smart", smart, true),
    economy: toTierSelection("economy", economy, false),
    express: toTierSelection("express", express, false)
  };
}

export function shippingTierFromServiceCode(value: string | null | undefined): ShippingTier {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("economy")) return "economy";
  if (normalized.includes("express")) return "express";
  return "smart";
}

export function publicTierSummary(
  tiers: Record<ShippingTier, ShippingTierSelection>
) {
  return {
    smart: {
      tier: tiers.smart.tier,
      label: tiers.smart.label,
      estimatedRate: tiers.smart.estimatedRate,
      currency: tiers.smart.currency,
      estimatedDeliveryDays: tiers.smart.estimatedDeliveryDays,
      chargedWeightKg: tiers.smart.chargedWeightKg,
      recommended: tiers.smart.recommended
    },
    economy: {
      tier: tiers.economy.tier,
      label: tiers.economy.label,
      estimatedRate: tiers.economy.estimatedRate,
      currency: tiers.economy.currency,
      estimatedDeliveryDays: tiers.economy.estimatedDeliveryDays,
      chargedWeightKg: tiers.economy.chargedWeightKg,
      recommended: tiers.economy.recommended
    },
    express: {
      tier: tiers.express.tier,
      label: tiers.express.label,
      estimatedRate: tiers.express.estimatedRate,
      currency: tiers.express.currency,
      estimatedDeliveryDays: tiers.express.estimatedDeliveryDays,
      chargedWeightKg: tiers.express.chargedWeightKg,
      recommended: tiers.express.recommended
    }
  };
}
