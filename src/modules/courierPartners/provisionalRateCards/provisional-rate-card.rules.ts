import { HttpError } from "../../../lib/httpError.js";
import {
  courierProviderLaneCodes,
  type CourierProviderLaneCode
} from "../providerRegistry/courier-provider-registry.types.js";
import {
  commercialRateCardGroupCodes,
  provisionalRateCardSourceTypes,
  provisionalRateCardStatuses,
  provisionalRateCardZoneCodes,
  shipmastrOutcomeTierCodes,
  type CommercialRateCardGroup,
  type CommercialRateCardGroupCode,
  type ProvisionalRateCardDefinition,
  type ProvisionalRateCardSourceType,
  type ProvisionalRateCardStatus,
  type ProvisionalRateCardZoneCode,
  type ShipmastrOutcomeTier,
  type ShipmastrOutcomeTierCode
} from "./provisional-rate-card.types.js";

const groupSet = new Set<string>(commercialRateCardGroupCodes);
const tierSet = new Set<string>(shipmastrOutcomeTierCodes);
const sourceSet = new Set<string>(provisionalRateCardSourceTypes);
const statusSet = new Set<string>(provisionalRateCardStatuses);
const zoneSet = new Set<string>(provisionalRateCardZoneCodes);
const laneSet = new Set<string>(courierProviderLaneCodes);

export const commercialRateCardGroups: CommercialRateCardGroup[] = [
  {
    groupCode: "PILOT",
    groupName: "Pilot",
    groupLevel: 10,
    description: "Internal pilot pricing group for controlled merchant onboarding.",
    sellerSegment: "pilot",
    defaultOutcomeTierCodes: ["SHIPMASTR_SMART", "SHIPMASTR_ECONOMY"],
    marginPolicy: { strategy: "INTERNAL_REVIEW", settlementAllowed: false, reconciliationAllowed: false },
    active: true,
    internalNotes: ["Use for controlled pilot simulation only."]
  },
  {
    groupCode: "SILVER",
    groupName: "Silver",
    groupLevel: 20,
    description: "Entry commercial group for early seller pricing simulations.",
    sellerSegment: "standard",
    defaultOutcomeTierCodes: ["SHIPMASTR_SMART", "SHIPMASTR_ECONOMY", "SHIPMASTR_EXPRESS"],
    marginPolicy: { strategy: "INTERNAL_REVIEW", settlementAllowed: false, reconciliationAllowed: false },
    active: true,
    internalNotes: ["Do not treat benchmark examples as official courier pricing."]
  },
  {
    groupCode: "GOLD",
    groupName: "Gold",
    groupLevel: 30,
    description: "Commercial group that can expose COD protection once pricing is approved.",
    sellerSegment: "growth",
    defaultOutcomeTierCodes: [
      "SHIPMASTR_SMART",
      "SHIPMASTR_ECONOMY",
      "SHIPMASTR_EXPRESS",
      "SHIPMASTR_COD_SHIELD"
    ],
    marginPolicy: { strategy: "INTERNAL_REVIEW", settlementAllowed: false, reconciliationAllowed: false },
    active: true,
    internalNotes: []
  },
  {
    groupCode: "PLATINUM",
    groupName: "Platinum",
    groupLevel: 40,
    description: "Advanced commercial group for broad outcome-tier evaluation.",
    sellerSegment: "scale",
    defaultOutcomeTierCodes: [...shipmastrOutcomeTierCodes],
    marginPolicy: { strategy: "INTERNAL_REVIEW", settlementAllowed: false, reconciliationAllowed: false },
    active: true,
    internalNotes: []
  },
  {
    groupCode: "ENTERPRISE",
    groupName: "Enterprise",
    groupLevel: 50,
    description: "Custom commercial group for negotiated enterprise terms.",
    sellerSegment: "enterprise",
    defaultOutcomeTierCodes: [...shipmastrOutcomeTierCodes],
    marginPolicy: { strategy: "CUSTOM", settlementAllowed: false, reconciliationAllowed: false },
    active: true,
    internalNotes: ["Requires explicit commercial approval before settlement-grade use."]
  },
  {
    groupCode: "CUSTOM",
    groupName: "Custom",
    groupLevel: 60,
    description: "Internal custom group for operator-defined pricing experiments.",
    sellerSegment: null,
    defaultOutcomeTierCodes: [],
    marginPolicy: { strategy: "CUSTOM", settlementAllowed: false, reconciliationAllowed: false },
    active: true,
    internalNotes: ["No seller-facing tiers are enabled by default."]
  }
];

export const shipmastrOutcomeTiers: ShipmastrOutcomeTier[] = [
  {
    outcomeCode: "SHIPMASTR_SMART",
    displayName: "Shipmastr Smart",
    description: "Balanced Shipmastr shipping outcome.",
    priority: 10,
    sellerVisible: true,
    active: true,
    eligibilityRules: { mode: "balanced" }
  },
  {
    outcomeCode: "SHIPMASTR_ECONOMY",
    displayName: "Shipmastr Economy",
    description: "Cost-sensitive Shipmastr shipping outcome.",
    priority: 20,
    sellerVisible: true,
    active: true,
    eligibilityRules: { mode: "cost" }
  },
  {
    outcomeCode: "SHIPMASTR_EXPRESS",
    displayName: "Shipmastr Express",
    description: "Speed-sensitive Shipmastr shipping outcome.",
    priority: 30,
    sellerVisible: true,
    active: true,
    eligibilityRules: { mode: "speed" }
  },
  {
    outcomeCode: "SHIPMASTR_COD_SHIELD",
    displayName: "Shipmastr COD Shield",
    description: "COD/RTO protection-oriented Shipmastr shipping outcome.",
    priority: 40,
    sellerVisible: true,
    active: true,
    eligibilityRules: { cod: true }
  },
  {
    outcomeCode: "SHIPMASTR_WEIGHT_GUARD",
    displayName: "Shipmastr Weight Guard",
    description: "Weight-dispute-aware Shipmastr shipping outcome.",
    priority: 50,
    sellerVisible: true,
    active: true,
    eligibilityRules: { weightReview: true }
  },
  {
    outcomeCode: "SHIPMASTR_AUTOPILOT",
    displayName: "Shipmastr Autopilot",
    description: "Automated Shipmastr outcome selection.",
    priority: 60,
    sellerVisible: true,
    active: true,
    eligibilityRules: { autopilot: true }
  }
];

export const provisionalRateCardTemplates: ProvisionalRateCardDefinition[] = [
  {
    id: "silver-benchmark-template",
    name: "Silver Benchmark Template",
    groupCode: "SILVER",
    sourceType: "MANUAL_BENCHMARK",
    status: "BENCHMARK_ONLY",
    official: false,
    officialContractRef: null,
    settlementAllowed: false,
    reconciliationAllowed: false,
    publicSellerVisible: false,
    effectiveFrom: null,
    effectiveTo: null,
    reviewBy: null,
    allowedOutcomeTierCodes: ["SHIPMASTR_SMART", "SHIPMASTR_ECONOMY", "SHIPMASTR_EXPRESS"],
    providerLaneMappings: [
      {
        outcomeCode: "SHIPMASTR_SMART",
        laneCodes: ["SHIPROCKET", "BIGSHIP"]
      },
      {
        outcomeCode: "SHIPMASTR_ECONOMY",
        laneCodes: ["DELHIVERY_B2C_SURFACE", "XPRESSBEES_SURFACE", "EKART"]
      },
      {
        outcomeCode: "SHIPMASTR_EXPRESS",
        laneCodes: ["DELHIVERY_B2C_AIR", "XPRESSBEES_AIR"]
      }
    ],
    chargeCells: [],
    internalNotes: [
      "Template only. No external benchmark numbers are loaded automatically.",
      "Do not use for settlement, courier billing, courier reconciliation, or disputes."
    ]
  }
];

export function normalizeCommercialGroupCode(value: unknown): CommercialRateCardGroupCode {
  const code = String(value ?? "").trim().toUpperCase();
  if (!groupSet.has(code)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_GROUP_UNSUPPORTED");
  return code as CommercialRateCardGroupCode;
}

export function normalizeOutcomeTierCode(value: unknown): ShipmastrOutcomeTierCode {
  const code = String(value ?? "").trim().toUpperCase();
  if (!tierSet.has(code)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_OUTCOME_TIER_UNSUPPORTED");
  return code as ShipmastrOutcomeTierCode;
}

export function normalizeRateCardSourceType(value: unknown): ProvisionalRateCardSourceType {
  const sourceType = String(value ?? "").trim().toUpperCase();
  if (!sourceSet.has(sourceType)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_SOURCE_UNSUPPORTED");
  return sourceType as ProvisionalRateCardSourceType;
}

export function normalizeRateCardStatus(value: unknown): ProvisionalRateCardStatus {
  const status = String(value ?? "").trim().toUpperCase();
  if (!statusSet.has(status)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_STATUS_UNSUPPORTED");
  return status as ProvisionalRateCardStatus;
}

export function normalizeRateCardZoneCode(value: unknown): ProvisionalRateCardZoneCode {
  const zoneCode = String(value ?? "").trim().toUpperCase();
  if (!zoneSet.has(zoneCode)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_ZONE_UNSUPPORTED");
  return zoneCode as ProvisionalRateCardZoneCode;
}

export function normalizeRateCardLaneCode(value: unknown): CourierProviderLaneCode {
  const laneCode = String(value ?? "").trim().toUpperCase();
  if (!laneSet.has(laneCode)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_LANE_UNSUPPORTED");
  return laneCode as CourierProviderLaneCode;
}

export function isReviewPast(card: { reviewBy?: string | null }, now = new Date()) {
  if (!card.reviewBy) return false;
  const reviewDate = new Date(card.reviewBy);
  return Number.isFinite(reviewDate.getTime()) && reviewDate.getTime() < now.getTime();
}

export function normalizeProvisionalRateCardDefinition(card: ProvisionalRateCardDefinition): ProvisionalRateCardDefinition {
  const sourceType = normalizeRateCardSourceType(card.sourceType);
  const status = normalizeRateCardStatus(card.status);
  const groupCode = normalizeCommercialGroupCode(card.groupCode);

  const manualBenchmark = sourceType === "MANUAL_BENCHMARK";
  const benchmarkOnly = status === "BENCHMARK_ONLY";
  const official = manualBenchmark || benchmarkOnly ? false : card.official;
  const settlementAllowed = manualBenchmark ? false : card.settlementAllowed;
  const reconciliationAllowed = manualBenchmark ? false : card.reconciliationAllowed;
  const publicSellerVisible = benchmarkOnly ? false : card.publicSellerVisible;

  if (sourceType === "OFFICIAL_CONTRACT" && official && !card.officialContractRef?.trim()) {
    throw new HttpError(400, "PROVISIONAL_RATE_CARD_OFFICIAL_METADATA_REQUIRED");
  }

  const allowedOutcomeTierCodes = card.allowedOutcomeTierCodes.map(normalizeOutcomeTierCode);
  const providerLaneMappings = card.providerLaneMappings.map((mapping) => ({
    outcomeCode: normalizeOutcomeTierCode(mapping.outcomeCode),
    laneCodes: mapping.laneCodes.map(normalizeRateCardLaneCode)
  }));
  const chargeCells = card.chargeCells.map((cell) => ({
    ...cell,
    laneCode: normalizeRateCardLaneCode(cell.laneCode),
    outcomeCode: normalizeOutcomeTierCode(cell.outcomeCode),
    zoneCode: normalizeRateCardZoneCode(cell.zoneCode),
    chargeALabel: cell.chargeALabel || "PRIMARY_CHARGE",
    chargeBLabel: cell.chargeBLabel || "SECONDARY_CHARGE",
    currency: "INR" as const
  }));

  return {
    ...card,
    groupCode,
    sourceType,
    status,
    official,
    settlementAllowed,
    reconciliationAllowed,
    publicSellerVisible,
    allowedOutcomeTierCodes,
    providerLaneMappings,
    chargeCells
  };
}
