import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { toPrismaJson } from "./shipping-public-serializers.js";
import type { ShippingTier } from "./shipping-tier-decision.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type AutopilotMode = "recommend_only" | "auto_ship_with_limits";

export type PublicAutopilotPreference = {
  isEnabled: boolean;
  defaultMode: AutopilotMode;
  preferredTier: ShippingTier;
  maxCodAmount: number | null;
  maxOrderAmount: number | null;
  maxWeightGrams: number | null;
  allowCodHighRisk: boolean;
  allowWeightHighRisk: boolean;
  requireManualReviewHigh: boolean;
  rulesJson: Record<string, unknown> | null;
};

export type AutopilotPreferenceInput = Partial<PublicAutopilotPreference>;

export const DEFAULT_AUTOPILOT_PREFERENCES: PublicAutopilotPreference = {
  isEnabled: false,
  defaultMode: "recommend_only",
  preferredTier: "smart",
  maxCodAmount: null,
  maxOrderAmount: null,
  maxWeightGrams: null,
  allowCodHighRisk: false,
  allowWeightHighRisk: false,
  requireManualReviewHigh: true,
  rulesJson: null
};

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function tier(value: unknown): ShippingTier {
  return value === "economy" || value === "express" ? value : "smart";
}

function mode(value: unknown): AutopilotMode {
  return value === "auto_ship_with_limits" ? "auto_ship_with_limits" : "recommend_only";
}

function nonNegativeOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(400, "AUTOPILOT_PREFERENCE_INVALID");
  }
  return value;
}

export function serializeAutopilotPreference(row: unknown): PublicAutopilotPreference {
  if (!row || typeof row !== "object") return DEFAULT_AUTOPILOT_PREFERENCES;
  const value = row as Record<string, unknown>;

  return {
    isEnabled: Boolean(value.isEnabled),
    defaultMode: mode(value.defaultMode),
    preferredTier: tier(value.preferredTier),
    maxCodAmount: nonNegativeOrNull(value.maxCodAmount),
    maxOrderAmount: nonNegativeOrNull(value.maxOrderAmount),
    maxWeightGrams: nonNegativeOrNull(value.maxWeightGrams),
    allowCodHighRisk: Boolean(value.allowCodHighRisk),
    allowWeightHighRisk: Boolean(value.allowWeightHighRisk),
    requireManualReviewHigh: value.requireManualReviewHigh !== false,
    rulesJson: jsonObject(value.rulesJson)
  };
}

export function validateAutopilotPreferenceInput(input: AutopilotPreferenceInput) {
  if (input.defaultMode && !["recommend_only", "auto_ship_with_limits"].includes(input.defaultMode)) {
    throw new HttpError(400, "AUTOPILOT_MODE_INVALID");
  }

  if (input.preferredTier && !["smart", "economy", "express"].includes(input.preferredTier)) {
    throw new HttpError(400, "AUTOPILOT_TIER_INVALID");
  }

  nonNegativeOrNull(input.maxCodAmount);
  nonNegativeOrNull(input.maxOrderAmount);
  nonNegativeOrNull(input.maxWeightGrams);
}

export async function getAutopilotPreferences(
  merchantId: string,
  client: Db = prisma
): Promise<PublicAutopilotPreference> {
  const row = await client.autopilotPreference.findUnique({
    where: { merchantId }
  });

  return row ? serializeAutopilotPreference(row) : DEFAULT_AUTOPILOT_PREFERENCES;
}

export async function upsertAutopilotPreferences(
  merchantId: string,
  input: AutopilotPreferenceInput,
  client: Db = prisma
) {
  validateAutopilotPreferenceInput(input);
  const current = await getAutopilotPreferences(merchantId, client);
  const next: PublicAutopilotPreference = {
    ...current,
    ...input,
    defaultMode: input.defaultMode ?? current.defaultMode,
    preferredTier: input.preferredTier ?? current.preferredTier,
    maxCodAmount: input.maxCodAmount === undefined ? current.maxCodAmount : input.maxCodAmount,
    maxOrderAmount: input.maxOrderAmount === undefined ? current.maxOrderAmount : input.maxOrderAmount,
    maxWeightGrams: input.maxWeightGrams === undefined ? current.maxWeightGrams : input.maxWeightGrams,
    rulesJson: input.rulesJson === undefined ? current.rulesJson : input.rulesJson
  };

  const row = await client.autopilotPreference.upsert({
    where: { merchantId },
    create: {
      merchantId,
      isEnabled: next.isEnabled,
      defaultMode: next.defaultMode,
      preferredTier: next.preferredTier,
      maxCodAmount: next.maxCodAmount,
      maxOrderAmount: next.maxOrderAmount,
      maxWeightGrams: next.maxWeightGrams,
      allowCodHighRisk: next.allowCodHighRisk,
      allowWeightHighRisk: next.allowWeightHighRisk,
      requireManualReviewHigh: next.requireManualReviewHigh,
      rulesJson: toPrismaJson(next.rulesJson)
    },
    update: {
      isEnabled: next.isEnabled,
      defaultMode: next.defaultMode,
      preferredTier: next.preferredTier,
      maxCodAmount: next.maxCodAmount,
      maxOrderAmount: next.maxOrderAmount,
      maxWeightGrams: next.maxWeightGrams,
      allowCodHighRisk: next.allowCodHighRisk,
      allowWeightHighRisk: next.allowWeightHighRisk,
      requireManualReviewHigh: next.requireManualReviewHigh,
      rulesJson: toPrismaJson(next.rulesJson)
    }
  });

  return serializeAutopilotPreference(row);
}
