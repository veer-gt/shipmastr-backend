import type { RateCard } from "@prisma/client";

export function rateCardToReconciliationInput(rateCard: RateCard) {
  return {
    courierId: rateCard.courierId,
    zone: rateCard.zone,
    minWeight: rateCard.minWeight,
    maxWeight: rateCard.maxWeight,
    baseRate: rateCard.baseRate,
    additionalRate: rateCard.additionalRate,
    codFee: rateCard.codFee,
    fuelSurcharge: rateCard.fuelSurcharge,
    rtoCharge: rateCard.rtoCharge,
    gstPercent: Number(rateCard.gstPercent)
  };
}
