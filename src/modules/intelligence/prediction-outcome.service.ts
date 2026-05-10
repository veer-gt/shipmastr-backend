import type { ActualOutcome, CodDecision, ConsigneeTier, Prisma, ShipmentDecision } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type PredictionInput = {
  orderId: string;
  merchantId: string;
  predictedConsigneeTier: ConsigneeTier;
  predictedCodDecision: CodDecision;
  predictedShipmentDecision: ShipmentDecision;
  predictedRtoRiskScore?: number | null;
  predictedCourierId?: string | null;
};

function predictedRisky(input: Pick<PredictionInput, "predictedConsigneeTier" | "predictedCodDecision" | "predictedShipmentDecision" | "predictedRtoRiskScore">) {
  return input.predictedConsigneeTier === "BRONZE"
    || input.predictedConsigneeTier === "IRON"
    || input.predictedCodDecision !== "ALLOW_COD"
    || input.predictedShipmentDecision !== "SHIP"
    || (input.predictedRtoRiskScore ?? 0) >= 45;
}

function actualBad(outcome: ActualOutcome) {
  return outcome === "NDR"
    || outcome === "RTO"
    || outcome === "CANCELLED"
    || outcome === "RETURNED"
    || outcome === "LOST";
}

export function evaluatePredictionFlags(input: Pick<PredictionInput, "predictedConsigneeTier" | "predictedCodDecision" | "predictedShipmentDecision" | "predictedRtoRiskScore"> & {
  actualOutcome: ActualOutcome;
}) {
  if (input.actualOutcome === "PENDING") {
    return {
      predictionCorrect: null,
      falsePositive: null,
      falseNegative: null,
      reasonMismatch: [] as string[]
    };
  }

  const risky = predictedRisky(input);
  const bad = actualBad(input.actualOutcome);
  const falsePositive = risky && input.actualOutcome === "DELIVERED";
  const falseNegative = !risky && bad;
  const predictionCorrect = risky === bad;
  const reasonMismatch: string[] = [];

  if (falsePositive) reasonMismatch.push("PREDICTED_RISK_BUT_DELIVERED");
  if (falseNegative) reasonMismatch.push("PREDICTED_SAFE_BUT_BAD_OUTCOME");
  if (input.actualOutcome === "NDR" && !risky) reasonMismatch.push("NDR_NOT_ANTICIPATED");
  if (input.actualOutcome === "RTO" && !risky) reasonMismatch.push("RTO_NOT_ANTICIPATED");

  return {
    predictionCorrect,
    falsePositive,
    falseNegative,
    reasonMismatch
  };
}

export function actualOutcomeFromCarrier(eventType: string): ActualOutcome {
  const normalized = eventType.toLowerCase();
  if (normalized.includes("delivered") && !normalized.includes("rto")) return "DELIVERED";
  if (normalized.includes("ndr")) return "NDR";
  if (normalized.includes("rto")) return "RTO";
  if (normalized.includes("cancel")) return "CANCELLED";
  if (normalized.includes("return")) return "RETURNED";
  if (normalized.includes("lost")) return "LOST";
  return "PENDING";
}

export async function createPredictionOutcome(input: PredictionInput, client: Db = prisma) {
  return client.predictionOutcome.create({
    data: {
      orderId: input.orderId,
      merchantId: input.merchantId,
      predictedConsigneeTier: input.predictedConsigneeTier,
      predictedCodDecision: input.predictedCodDecision,
      predictedShipmentDecision: input.predictedShipmentDecision,
      predictedRtoRiskScore: input.predictedRtoRiskScore ?? null,
      predictedCourierId: input.predictedCourierId ?? null
    }
  });
}

export async function evaluatePredictionOutcome(orderId: string, actualOutcome: ActualOutcome, client: Db = prisma) {
  const current = await client.predictionOutcome.findUnique({ where: { orderId } });
  if (!current) return null;

  const flags = evaluatePredictionFlags({
    predictedConsigneeTier: current.predictedConsigneeTier,
    predictedCodDecision: current.predictedCodDecision,
    predictedShipmentDecision: current.predictedShipmentDecision,
    predictedRtoRiskScore: current.predictedRtoRiskScore,
    actualOutcome
  });

  return client.predictionOutcome.update({
    where: { orderId },
    data: {
      actualOutcome,
      predictionCorrect: flags.predictionCorrect,
      falsePositive: flags.falsePositive,
      falseNegative: flags.falseNegative,
      reasonMismatch: flags.reasonMismatch,
      evaluatedAt: actualOutcome === "PENDING" ? null : new Date()
    }
  });
}
