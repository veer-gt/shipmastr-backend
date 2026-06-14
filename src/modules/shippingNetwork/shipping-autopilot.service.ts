import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { decimalToNumber, toPrismaJson } from "./shipping-public-serializers.js";
import { getSellerShipment } from "./shipping-shipments.service.js";
import {
  DEFAULT_AUTOPILOT_PREFERENCES,
  getAutopilotPreferences,
  type PublicAutopilotPreference
} from "./shipping-autopilot-preferences.service.js";
import type { ShippingTier } from "./shipping-tier-decision.service.js";

type Db = Prisma.TransactionClient | typeof prisma;
type DecisionLevel = "safe" | "warning" | "blocked";

export type AutopilotBadge = {
  code: string;
  label: string;
  level: "info" | "warning" | "danger" | "success";
};

export type AutopilotRecommendation = {
  shipmentId: string;
  recommendedTier: ShippingTier;
  decisionLevel: DecisionLevel;
  canAutoShip: boolean;
  reasons: string[];
  badges: AutopilotBadge[];
};

type ShipmentLike = {
  id: string;
  orderId?: string | null;
  externalOrderId?: string | null;
  paymentMode?: string | null;
  codAmountPaise?: number | null;
  declaredValuePaise?: number | null;
  deadWeightKg?: unknown;
  metadata?: unknown;
};

type OrderLike = {
  id?: string | null;
  codRiskLevel?: string | null;
  rtoRiskLevel?: string | null;
  codRiskScore?: number | null;
  rtoRiskScore?: number | null;
};

type RecommendationBuildInput = {
  shipment: ShipmentLike;
  order?: OrderLike | null;
  preferences?: PublicAutopilotPreference;
  rates?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nestedRecord(value: unknown, key: string) {
  if (!isRecord(value)) return {};
  const nested = value[key];
  return isRecord(nested) ? nested : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function kgToGrams(value: unknown) {
  const kg = decimalToNumber(value);
  return kg === null ? null : Math.round(kg * 1000);
}

function highRiskLevel(value: unknown) {
  const normalized = stringValue(value).toLowerCase();
  return normalized === "high" || normalized === "critical";
}

function highRiskScore(value: unknown) {
  const score = numberValue(value);
  return score !== null && score >= 75;
}

function publicTier(value: unknown): ShippingTier {
  return value === "economy" || value === "express" ? value : "smart";
}

function tierLabel(tier: ShippingTier) {
  return tier === "economy" ? "Economy" : tier === "express" ? "Express" : "Smart";
}

function rateSummaryFromUnknown(value: unknown) {
  if (!isRecord(value)) return {};
  const tiers = isRecord(value.tiers) ? value.tiers : value;
  return {
    smart: isRecord(tiers.smart) ? tiers.smart : null,
    economy: isRecord(tiers.economy) ? tiers.economy : null,
    express: isRecord(tiers.express) ? tiers.express : null
  };
}

function estimatedRate(value: unknown) {
  return numberValue(isRecord(value) ? value.estimatedRate : null);
}

function appendBadge(badges: AutopilotBadge[], badge: AutopilotBadge) {
  if (!badges.some((item) => item.code === badge.code)) badges.push(badge);
}

export function buildAutopilotRecommendation(input: RecommendationBuildInput): AutopilotRecommendation {
  const preferences = input.preferences ?? DEFAULT_AUTOPILOT_PREFERENCES;
  const preferredTier = publicTier(preferences.preferredTier);
  const reasons: string[] = [`Preferred tier ${preferredTier} selected.`];
  const badges: AutopilotBadge[] = [{
    code: `AUTOPILOT_RECOMMENDS_${preferredTier.toUpperCase()}`,
    label: `Autopilot recommends ${tierLabel(preferredTier)}`,
    level: "success"
  }];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const metadata = isRecord(input.shipment.metadata) ? input.shipment.metadata : {};
  const protection = {
    ...nestedRecord(metadata, "protection"),
    ...nestedRecord(metadata, "phase9"),
    ...nestedRecord(metadata, "codShield"),
    ...nestedRecord(metadata, "weightGuard")
  };

  const codRiskHigh = highRiskLevel(input.order?.codRiskLevel)
    || highRiskScore(input.order?.codRiskScore)
    || highRiskLevel(protection.codRiskLevel)
    || highRiskScore(protection.codRiskScore);
  const weightRiskHigh = highRiskLevel(protection.weightRiskLevel)
    || highRiskLevel(protection.weightGuardRiskLevel)
    || highRiskScore(protection.weightRiskScore)
    || highRiskScore(protection.weightGuardScore);
  const rtoRiskHigh = highRiskLevel(input.order?.rtoRiskLevel)
    || highRiskScore(input.order?.rtoRiskScore)
    || highRiskLevel(protection.rtoRiskLevel)
    || highRiskScore(protection.rtoRiskScore);

  if (preferences.requireManualReviewHigh && (codRiskHigh || weightRiskHigh || rtoRiskHigh)) {
    blockers.push("High risk shipments require manual review.");
  }

  if (codRiskHigh && !preferences.allowCodHighRisk) {
    blockers.push("COD Shield high risk requires manual review.");
  }

  if (weightRiskHigh && !preferences.allowWeightHighRisk) {
    blockers.push("Weight Guard high risk requires manual review.");
  }

  const orderAmount = input.shipment.declaredValuePaise ?? null;
  if (preferences.maxOrderAmount !== null && orderAmount !== null && orderAmount > preferences.maxOrderAmount) {
    blockers.push("Order amount exceeds Autopilot limit.");
  }

  const codAmount = input.shipment.codAmountPaise ?? 0;
  if (preferences.maxCodAmount !== null && codAmount > preferences.maxCodAmount) {
    blockers.push("COD amount exceeds Autopilot limit.");
  }

  const weightGrams = kgToGrams(input.shipment.deadWeightKg);
  if (preferences.maxWeightGrams !== null && weightGrams !== null && weightGrams > preferences.maxWeightGrams) {
    blockers.push("Package weight exceeds Autopilot limit.");
  }

  if (preferredTier === "express") {
    const rates = rateSummaryFromUnknown(input.rates);
    const express = estimatedRate(rates.express);
    const smart = estimatedRate(rates.smart);
    const economy = estimatedRate(rates.economy);
    const baseline = Math.min(...[smart, economy].filter((value): value is number => value !== null));
    if (express !== null && Number.isFinite(baseline) && express > baseline * 1.5) {
      warnings.push("Express is materially costlier than other eligible options.");
    }
  }

  for (const reason of blockers) reasons.push(reason);
  for (const reason of warnings) reasons.push(reason);

  if (blockers.length) {
    appendBadge(badges, {
      code: "AUTOPILOT_REQUIRES_REVIEW",
      label: "Manual review required",
      level: "danger"
    });
  } else if (warnings.length) {
    appendBadge(badges, {
      code: "AUTOPILOT_WARNING",
      label: "Review recommended",
      level: "warning"
    });
  } else {
    appendBadge(badges, {
      code: "AUTOPILOT_SAFE_TO_SHIP",
      label: "Safe for Autopilot",
      level: "success"
    });
  }

  const decisionLevel: DecisionLevel = blockers.length ? "blocked" : warnings.length ? "warning" : "safe";

  return {
    shipmentId: input.shipment.id,
    recommendedTier: preferredTier,
    decisionLevel,
    canAutoShip: preferences.isEnabled && preferences.defaultMode === "auto_ship_with_limits" && decisionLevel !== "blocked",
    reasons,
    badges
  };
}

async function findShipmentOrder(merchantId: string, shipment: ShipmentLike, client: Db) {
  if (!shipment.orderId && !shipment.externalOrderId) return null;

  return client.order.findFirst({
    where: {
      merchantId,
      OR: [
        ...(shipment.orderId ? [{ id: shipment.orderId }] : []),
        ...(shipment.externalOrderId ? [{ externalOrderId: shipment.externalOrderId }] : [])
      ]
    }
  });
}

async function existingRateSummary(merchantId: string, shipmentId: string, client: Db) {
  const rates = await client.shipmentRate.findMany({
    where: {
      sellerId: merchantId,
      shipmentId
    },
    orderBy: { createdAt: "desc" }
  });

  return rates.length ? { count: rates.length } : null;
}

export async function recommendAutopilotForShipment(
  merchantId: string,
  shipmentId: string,
  options: {
    client?: Db;
    preferences?: PublicAutopilotPreference;
    rates?: unknown;
  } = {}
) {
  const client = options.client ?? prisma;
  const shipment = await getSellerShipment(merchantId, shipmentId, client);
  const [preferences, order, rates] = await Promise.all([
    options.preferences ? Promise.resolve(options.preferences) : getAutopilotPreferences(merchantId, client),
    findShipmentOrder(merchantId, shipment, client),
    options.rates ? Promise.resolve(options.rates) : existingRateSummary(merchantId, shipment.id, client)
  ]);

  return buildAutopilotRecommendation({
    shipment,
    order,
    preferences,
    rates
  });
}

export async function recordAutopilotDecision(input: {
  merchantId: string;
  shipmentId: string;
  orderId?: string | null;
  mode: string;
  recommendedTier: ShippingTier;
  selectedTier?: ShippingTier | null;
  decisionLevel: DecisionLevel;
  reasons: string[];
  badges?: AutopilotBadge[];
  rates?: unknown;
  applied: boolean;
  blockedReason?: string | null;
  client?: Db;
}) {
  const client = input.client ?? prisma;

  return client.autopilotDecision.create({
    data: {
      merchantId: input.merchantId,
      shipmentId: input.shipmentId,
      orderId: input.orderId ?? null,
      mode: input.mode,
      recommendedTier: input.recommendedTier,
      selectedTier: input.selectedTier ?? null,
      decisionLevel: input.decisionLevel,
      reasonsJson: toPrismaJson(input.reasons),
      protectionJson: toPrismaJson({ badges: input.badges ?? [] }),
      rateSnapshotJson: toPrismaJson(input.rates ?? null),
      applied: input.applied,
      blockedReason: input.blockedReason ?? null
    }
  });
}
