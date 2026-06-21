import { HttpError } from "../../../lib/httpError.js";
import {
  commercialRateCardGroups,
  isReviewPast,
  normalizeCommercialGroupCode,
  normalizeOutcomeTierCode,
  normalizeProvisionalRateCardDefinition,
  normalizeRateCardZoneCode,
  provisionalRateCardTemplates,
  shipmastrOutcomeTiers
} from "./provisional-rate-card.rules.js";
import type {
  CommercialRateCardGroupCode,
  ProvisionalRateCardDefinition,
  ProvisionalRateCardSimulationInput,
  ProvisionalRateCardSimulationResult,
  ProvisionalRateCardZoneCode,
  ShipmastrOutcomeTierCode
} from "./provisional-rate-card.types.js";

function cloneCard(card: ProvisionalRateCardDefinition) {
  return normalizeProvisionalRateCardDefinition(JSON.parse(JSON.stringify(card)) as ProvisionalRateCardDefinition);
}

function displayNameForTier(outcomeCode: ShipmastrOutcomeTierCode) {
  return shipmastrOutcomeTiers.find((tier) => tier.outcomeCode === outcomeCode)?.displayName ?? "Shipmastr Smart";
}

function displayNameForGroup(groupCode: CommercialRateCardGroupCode) {
  return commercialRateCardGroups.find((group) => group.groupCode === groupCode)?.groupName ?? groupCode;
}

function zoneLabel(zoneCode: ProvisionalRateCardZoneCode) {
  return zoneCode
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

export function listCommercialRateCardGroups() {
  return commercialRateCardGroups.map((group) => ({
    ...group,
    defaultOutcomeTierCodes: [...group.defaultOutcomeTierCodes],
    internalNotes: [...group.internalNotes],
    marginPolicy: { ...group.marginPolicy }
  }));
}

export function getCommercialRateCardGroup(groupCode: string) {
  const normalized = normalizeCommercialGroupCode(groupCode);
  const group = listCommercialRateCardGroups().find((item) => item.groupCode === normalized);
  if (!group) throw new HttpError(404, "PROVISIONAL_RATE_CARD_GROUP_NOT_FOUND");
  return group;
}

export function listShipmastrOutcomeTiers() {
  return shipmastrOutcomeTiers.map((tier) => ({
    ...tier,
    eligibilityRules: { ...tier.eligibilityRules }
  }));
}

export function listProvisionalRateCards() {
  return provisionalRateCardTemplates.map(cloneCard);
}

export function getProvisionalRateCard(id: string) {
  const card = provisionalRateCardTemplates.find((item) => item.id === id);
  if (!card) throw new HttpError(404, "PROVISIONAL_RATE_CARD_NOT_FOUND");
  return cloneCard(card);
}

export function normalizeProvisionalRateCard(card: ProvisionalRateCardDefinition) {
  return normalizeProvisionalRateCardDefinition(card);
}

function matchingChargeCell(card: ProvisionalRateCardDefinition, input: ProvisionalRateCardSimulationInput) {
  return card.chargeCells.find((cell) => (
    cell.outcomeCode === input.outcomeCode &&
    cell.zoneCode === input.zoneCode &&
    cell.weightSlab.active &&
    input.weightKg >= cell.weightSlab.minWeightKg &&
    input.weightKg <= cell.weightSlab.maxWeightKg
  )) ?? null;
}

export function simulateProvisionalRateCard(
  id: string,
  input: ProvisionalRateCardSimulationInput,
  now = new Date()
): ProvisionalRateCardSimulationResult {
  const card = getProvisionalRateCard(id);
  const outcomeCode = normalizeOutcomeTierCode(input.outcomeCode);
  const zoneCode = normalizeRateCardZoneCode(input.zoneCode);

  if (!Number.isFinite(input.weightKg) || input.weightKg <= 0) {
    throw new HttpError(400, "PROVISIONAL_RATE_CARD_WEIGHT_INVALID");
  }

  const warnings = [
    ...(isReviewPast(card, now) ? ["PROVISIONAL_RATE_CARD_REVIEW_PAST"] : []),
    ...(card.sourceType === "MANUAL_BENCHMARK" ? ["MANUAL_BENCHMARK_NOT_OFFICIAL"] : []),
    ...(card.settlementAllowed ? [] : ["SETTLEMENT_BLOCKED"]),
    ...(card.reconciliationAllowed ? [] : ["RECONCILIATION_BLOCKED"])
  ];

  const blockedForSeller = input.sellerFacing === true
    && card.status === "BENCHMARK_ONLY"
    && card.publicSellerVisible === false;

  if (blockedForSeller) {
    return {
      status: "BLOCKED",
      blockerCode: "BENCHMARK_ONLY_NOT_PUBLIC_SELLER_VISIBLE",
      sellerSafeQuote: null,
      adminDiagnostics: {
        sourceType: card.sourceType,
        status: card.status,
        official: card.official,
        settlementAllowed: card.settlementAllowed,
        reconciliationAllowed: card.reconciliationAllowed,
        publicSellerVisible: card.publicSellerVisible,
        laneCode: null,
        chargeComponents: null,
        warnings
      }
    };
  }

  const cell = matchingChargeCell(card, { ...input, outcomeCode, zoneCode });
  if (!cell) {
    return {
      status: "NO_MATCH",
      blockerCode: "PROVISIONAL_RATE_CARD_CELL_NOT_CONFIGURED",
      sellerSafeQuote: null,
      adminDiagnostics: {
        sourceType: card.sourceType,
        status: card.status,
        official: card.official,
        settlementAllowed: card.settlementAllowed,
        reconciliationAllowed: card.reconciliationAllowed,
        publicSellerVisible: card.publicSellerVisible,
        laneCode: null,
        chargeComponents: null,
        warnings
      }
    };
  }

  return {
    status: "SIMULATED",
    blockerCode: null,
    sellerSafeQuote: card.publicSellerVisible ? {
      serviceTier: displayNameForTier(outcomeCode),
      priceEstimate: null,
      currency: "INR",
      weightSlab: `${cell.weightSlab.minWeightKg}-${cell.weightSlab.maxWeightKg} kg`,
      zoneLabel: zoneLabel(zoneCode),
      groupLabel: displayNameForGroup(card.groupCode)
    } : null,
    adminDiagnostics: {
      sourceType: card.sourceType,
      status: card.status,
      official: card.official,
      settlementAllowed: card.settlementAllowed,
      reconciliationAllowed: card.reconciliationAllowed,
      publicSellerVisible: card.publicSellerVisible,
      laneCode: cell.laneCode,
      chargeComponents: {
        chargeALabel: cell.chargeALabel,
        chargeAAmount: cell.chargeAAmount,
        chargeBLabel: cell.chargeBLabel,
        chargeBAmount: cell.chargeBAmount,
        codChargeA: cell.codChargeA,
        codChargeB: cell.codChargeB,
        codChargePolicy: cell.codChargePolicy
      },
      warnings
    }
  };
}
