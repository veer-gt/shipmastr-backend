import type { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { fetchShipmentRates } from "./shipping-rates.service.js";
import { shipNowShipment } from "./shipping-ship-now.service.js";
import { toPrismaJson } from "./shipping-public-serializers.js";
import {
  recommendAutopilotForShipment,
  recordAutopilotDecision,
  type AutopilotRecommendation
} from "./shipping-autopilot.service.js";
import {
  getAutopilotPreferences,
  type PublicAutopilotPreference
} from "./shipping-autopilot-preferences.service.js";
import type { ShippingTier } from "./shipping-tier-decision.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

type BulkOptions = {
  client?: Db;
  adapter?: InternalCourierProviderAdapter;
};

export type BulkRatesInput = {
  shipmentIds: string[];
  refresh?: boolean;
};

export type BulkShipNowInput = {
  shipmentIds: string[];
  tier: ShippingTier;
  useAutopilot?: boolean;
  acknowledgeProtectionWarnings?: boolean;
};

function uniqueIds(ids: string[]) {
  return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
}

function safeError(error: unknown, fallbackCode: string) {
  if (error instanceof HttpError) {
    return {
      code: error.message,
      message: safeMessage(error.message)
    };
  }

  return {
    code: fallbackCode,
    message: safeMessage(fallbackCode)
  };
}

function safeMessage(code: string) {
  const messages: Record<string, string> = {
    BULK_RATE_LIMIT_EXCEEDED: "Bulk rate fetch supports up to 50 shipments at a time.",
    BULK_SHIP_NOW_LIMIT_EXCEEDED: "Bulk Ship Now supports up to 25 shipments at a time.",
    SHIPMENT_NOT_ELIGIBLE: "Shipment is not eligible for this action.",
    AUTOPILOT_BLOCKED: "Autopilot requires manual review.",
    PROTECTION_ACK_REQUIRED: "Protection warnings require acknowledgement before bulk shipping.",
    SHIPMENT_CREATION_FAILED: "Shipment could not be created right now. Please try again or contact support.",
    BULK_RATES_FAILED: "Rates could not be fetched for this shipment.",
    BULK_SHIP_NOW_FAILED: "Shipment could not be created for this item."
  };

  return messages[code] ?? "Shipping action could not be completed for this item.";
}

function finalBatchStatus(counts: { successCount: number; failedCount: number; skippedCount: number }) {
  if (counts.successCount > 0 && (counts.failedCount > 0 || counts.skippedCount > 0)) return "completed_with_errors";
  if (counts.successCount > 0) return "completed";
  return "failed";
}

async function createBatch(client: Db, input: {
  merchantId: string;
  action: "fetch_rates" | "ship_now";
  totalItems: number;
  requestedTier?: ShippingTier | null;
}) {
  return client.bulkShippingBatch.create({
    data: {
      merchantId: input.merchantId,
      action: input.action,
      status: "processing",
      totalItems: input.totalItems,
      requestedTier: input.requestedTier ?? null
    }
  });
}

async function createItem(client: Db, input: {
  batchId: string;
  merchantId: string;
  shipmentId: string;
  status: "success" | "failed" | "skipped";
  result?: unknown;
  error?: { code: string; message: string } | null;
}) {
  const data: Prisma.BulkShippingItemUncheckedCreateInput = {
    batchId: input.batchId,
    merchantId: input.merchantId,
    shipmentId: input.shipmentId,
    status: input.status,
    errorCode: input.error?.code ?? null,
    errorMessage: input.error?.message ?? null
  };
  if (input.result !== undefined) data.resultJson = toPrismaJson(input.result);

  return client.bulkShippingItem.create({
    data
  });
}

async function finishBatch(client: Db, batchId: string, counts: {
  successCount: number;
  failedCount: number;
  skippedCount: number;
}, errors: unknown[]) {
  const data: Prisma.BulkShippingBatchUncheckedUpdateInput = {
    status: finalBatchStatus(counts),
    successCount: counts.successCount,
    failedCount: counts.failedCount,
    skippedCount: counts.skippedCount
  };
  if (errors.length) data.errorsJson = toPrismaJson(errors);

  return client.bulkShippingBatch.update({
    where: { id: batchId },
    data
  });
}

export async function bulkFetchRates(
  merchantId: string,
  input: BulkRatesInput,
  options: BulkOptions = {}
) {
  const client = options.client ?? prisma;
  const adapter = options.adapter;
  const shipmentIds = uniqueIds(input.shipmentIds);

  if (shipmentIds.length > 50) {
    throw new HttpError(400, "BULK_RATE_LIMIT_EXCEEDED");
  }

  const batch = await createBatch(client, {
    merchantId,
    action: "fetch_rates",
    totalItems: shipmentIds.length
  });
  const items = [];
  const errors = [];
  const counts = { successCount: 0, failedCount: 0, skippedCount: 0 };

  for (const shipmentId of shipmentIds) {
    try {
      const rateOptions = {
        client,
        ...(adapter ? { adapter } : {}),
        ...(input.refresh === undefined ? {} : { refresh: input.refresh })
      };
      const result = await fetchShipmentRates(merchantId, shipmentId, {
        ...rateOptions
      });
      counts.successCount += 1;
      const publicItem = {
        shipmentId,
        status: "success" as const,
        tiers: result.tiers
      };
      items.push(publicItem);
      await createItem(client, {
        batchId: batch.id,
        merchantId,
        shipmentId,
        status: "success",
        result: publicItem
      });
    } catch (error) {
      const safe = safeError(error, "BULK_RATES_FAILED");
      counts.failedCount += 1;
      errors.push({ shipmentId, ...safe });
      const publicItem = {
        shipmentId,
        status: "failed" as const,
        error: safe
      };
      items.push(publicItem);
      await createItem(client, {
        batchId: batch.id,
        merchantId,
        shipmentId,
        status: "failed",
        error: safe
      });
    }
  }

  const finished = await finishBatch(client, batch.id, counts, errors);

  return {
    batchId: batch.id,
    status: finished.status,
    totalItems: shipmentIds.length,
    ...counts,
    items
  };
}

async function blockedAutopilotItem(input: {
  merchantId: string;
  shipmentId: string;
  recommendation: AutopilotRecommendation;
  preferences: PublicAutopilotPreference;
  client: Db;
  reasonCode: "AUTOPILOT_BLOCKED" | "PROTECTION_ACK_REQUIRED";
}) {
  await recordAutopilotDecision({
    merchantId: input.merchantId,
    shipmentId: input.shipmentId,
    mode: input.preferences.defaultMode,
    recommendedTier: input.recommendation.recommendedTier,
    selectedTier: input.recommendation.recommendedTier,
    decisionLevel: input.recommendation.decisionLevel,
    reasons: input.recommendation.reasons,
    badges: input.recommendation.badges,
    applied: false,
    blockedReason: input.reasonCode,
    client: input.client
  });

  return {
    shipmentId: input.shipmentId,
    status: "skipped" as const,
    autopilot: input.recommendation,
    error: {
      code: input.reasonCode,
      message: safeMessage(input.reasonCode)
    }
  };
}

export async function bulkShipNow(
  merchantId: string,
  input: BulkShipNowInput,
  options: BulkOptions = {}
) {
  const client = options.client ?? prisma;
  const adapter = options.adapter;
  const shipmentIds = uniqueIds(input.shipmentIds);

  if (shipmentIds.length > 25) {
    throw new HttpError(400, "BULK_SHIP_NOW_LIMIT_EXCEEDED");
  }

  const batch = await createBatch(client, {
    merchantId,
    action: "ship_now",
    totalItems: shipmentIds.length,
    requestedTier: input.tier
  });
  const preferences = await getAutopilotPreferences(merchantId, client);
  const items = [];
  const errors = [];
  const counts = { successCount: 0, failedCount: 0, skippedCount: 0 };

  for (const shipmentId of shipmentIds) {
    try {
      let tier = input.tier;
      let recommendation: AutopilotRecommendation | null = null;

      if (input.useAutopilot) {
        recommendation = await recommendAutopilotForShipment(merchantId, shipmentId, {
          client,
          preferences
        });
        tier = recommendation.recommendedTier;

        if (recommendation.decisionLevel === "blocked") {
          const skipped = await blockedAutopilotItem({
            merchantId,
            shipmentId,
            recommendation,
            preferences,
            client,
            reasonCode: "AUTOPILOT_BLOCKED"
          });
          counts.skippedCount += 1;
          errors.push({ shipmentId, ...skipped.error });
          items.push(skipped);
          await createItem(client, {
            batchId: batch.id,
            merchantId,
            shipmentId,
            status: "skipped",
            result: { autopilot: recommendation },
            error: skipped.error
          });
          continue;
        }

        if (recommendation.decisionLevel === "warning" && !input.acknowledgeProtectionWarnings) {
          const skipped = await blockedAutopilotItem({
            merchantId,
            shipmentId,
            recommendation,
            preferences,
            client,
            reasonCode: "PROTECTION_ACK_REQUIRED"
          });
          counts.skippedCount += 1;
          errors.push({ shipmentId, ...skipped.error });
          items.push(skipped);
          await createItem(client, {
            batchId: batch.id,
            merchantId,
            shipmentId,
            status: "skipped",
            result: { autopilot: recommendation },
            error: skipped.error
          });
          continue;
        }
      }

      const result = await shipNowShipment(merchantId, shipmentId, tier, {
        client,
        ...(adapter ? { adapter } : {})
      });
      if (recommendation) {
        await recordAutopilotDecision({
          merchantId,
          shipmentId,
          mode: preferences.defaultMode,
          recommendedTier: recommendation.recommendedTier,
          selectedTier: tier,
          decisionLevel: recommendation.decisionLevel,
          reasons: recommendation.reasons,
          badges: recommendation.badges,
          applied: true,
          client
        });
      }

      counts.successCount += 1;
      const publicItem = {
        shipmentId,
        status: "success" as const,
        tier,
        awbNumber: result.awbNumber ?? null,
        labelUrl: result.labelUrl ?? null,
        trackingPublicUrl: result.trackingPublicUrl ?? null,
        autopilot: recommendation
      };
      items.push(publicItem);
      await createItem(client, {
        batchId: batch.id,
        merchantId,
        shipmentId,
        status: "success",
        result: publicItem
      });
    } catch (error) {
      const safe = safeError(error, "BULK_SHIP_NOW_FAILED");
      counts.failedCount += 1;
      errors.push({ shipmentId, ...safe });
      const publicItem = {
        shipmentId,
        status: "failed" as const,
        error: safe
      };
      items.push(publicItem);
      await createItem(client, {
        batchId: batch.id,
        merchantId,
        shipmentId,
        status: "failed",
        error: safe
      });
    }
  }

  const finished = await finishBatch(client, batch.id, counts, errors);

  return {
    batchId: batch.id,
    status: finished.status,
    totalItems: shipmentIds.length,
    ...counts,
    items
  };
}
