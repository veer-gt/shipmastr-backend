import { HttpError } from "../../../lib/httpError.js";
import {
  courierProviderLaneCodes,
  type CourierProviderLaneCode
} from "../providerRegistry/courier-provider-registry.types.js";
import {
  commercialRateCardGroupCodes,
  provisionalRateCardSourceTypes,
  provisionalRateCardReviewStatuses,
  provisionalRateCardStatuses,
  provisionalRateCardZoneCodes,
  shipmastrOutcomeTierCodes,
  type CommercialRateCardGroup,
  type CommercialRateCardGroupCode,
  type ProvisionalRateCardDefinition,
  type OfficialRateCardIngestionReadinessInput,
  type OfficialRateCardIngestionReadinessResult,
  type ProvisionalRateCardSourceType,
  type ProvisionalRateCardReviewStatus,
  type ProvisionalRateCardStatus,
  type ProvisionalRateCardZoneCode,
  type ShipmastrOutcomeTier,
  type ShipmastrOutcomeTierCode
} from "./provisional-rate-card.types.js";

const groupSet = new Set<string>(commercialRateCardGroupCodes);
const tierSet = new Set<string>(shipmastrOutcomeTierCodes);
const sourceSet = new Set<string>(provisionalRateCardSourceTypes);
const reviewStatusSet = new Set<string>(provisionalRateCardReviewStatuses);
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

export const sampleProvisionalRateCardImportTemplate = {
  name: "Internal Sample Silver Benchmark",
  group_code: "SILVER",
  source_type: "MANUAL_BENCHMARK",
  status: "BENCHMARK_ONLY",
  source_label: "Internal fake sample",
  source_notes: "Example only. Replace with reviewed internal benchmark notes before import.",
  review_by: "2026-07-31T00:00:00.000Z",
  expires_at: "2026-08-31T00:00:00.000Z",
  allowed_outcome_tiers: ["SHIPMASTR_SMART", "SHIPMASTR_ECONOMY"],
  provider_lane_mappings: [
    { outcome_code: "SHIPMASTR_SMART", lane_codes: ["DELHIVERY_B2C_SURFACE"] }
  ],
  charge_cells: [
    {
      lane_code: "DELHIVERY_B2C_SURFACE",
      outcome_code: "SHIPMASTR_SMART",
      zone_code: "WITHIN_CITY",
      min_weight_kg: 0,
      max_weight_kg: 0.5,
      slab_order: 1,
      package_type: "ANY",
      charge_a_amount: 11,
      charge_b_amount: 12,
      charge_a_label: "PRIMARY_CHARGE",
      charge_b_label: "SECONDARY_CHARGE",
      cod_charge_a: 0,
      cod_charge_b: 0,
      cod_charge_policy: "COMPONENTS_ONLY",
      volumetric_divisor: 5000,
      rto_percentage: 0,
      gst_status: "REVIEW_REQUIRED",
      gst_percent: null,
      notes: ["Fake values for template validation only."]
    }
  ],
  internal_notes: [
    "Fake internal sample only.",
    "Do not use for official courier pricing, settlement, reconciliation, or seller quotes."
  ]
} as const;

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

export function normalizeRateCardReviewStatus(value: unknown): ProvisionalRateCardReviewStatus {
  const status = String(value ?? "").trim().toUpperCase();
  if (!reviewStatusSet.has(status)) throw new HttpError(400, "PROVISIONAL_RATE_CARD_REVIEW_STATUS_UNSUPPORTED");
  return status as ProvisionalRateCardReviewStatus;
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

function hasText(value: unknown) {
  return Boolean(String(value ?? "").trim());
}

function isUserProvidedProvisionalSource(input: OfficialRateCardIngestionReadinessInput) {
  const source = [
    input.sourceLabel,
    input.sourceRecordId
  ].map((value) => String(value ?? "").toUpperCase()).join(" ");

  return source.includes("USER_PROVIDED_REVIEWED_PROVISIONAL");
}

function isCapturedSilverBenchmarkSource(input: OfficialRateCardIngestionReadinessInput) {
  const source = [
    input.sourceLabel,
    input.sourceRecordId
  ].map((value) => String(value ?? "").toUpperCase()).join(" ");

  return source.includes("PHASE-66-SILVER-RATE-CARD-SOURCE-CAPTURE")
    || source.includes("SILVER-RATE-CARD-SOURCE-CAPTURE")
    || source.includes("SILVER USER PROVIDED REVIEWED PROVISIONAL")
    || source.includes("SILVER_USER_PROVIDED_REVIEWED_PROVISIONAL");
}

export function evaluateOfficialRateCardIngestionReadiness(
  input: OfficialRateCardIngestionReadinessInput
): OfficialRateCardIngestionReadinessResult {
  const sourceType = normalizeRateCardSourceType(input.sourceType);
  const status = normalizeRateCardStatus(input.status);
  const blockers = new Set<string>();

  if (sourceType !== "OFFICIAL_CONTRACT") {
    blockers.add("OFFICIAL_INGESTION_SOURCE_MUST_BE_OFFICIAL_CONTRACT");
  }

  if (sourceType === "MANUAL_BENCHMARK") {
    blockers.add("MANUAL_BENCHMARK_CANNOT_BECOME_OFFICIAL_CONTRACT");
  }

  if (status === "BENCHMARK_ONLY") {
    blockers.add("BENCHMARK_ONLY_CANNOT_BECOME_OFFICIAL_ACTIVE");
  }

  if (status !== "OFFICIAL_PENDING" && status !== "OFFICIAL_ACTIVE") {
    blockers.add("OFFICIAL_INGESTION_STATUS_MUST_BE_OFFICIAL_PENDING_OR_ACTIVE");
  }

  if (isUserProvidedProvisionalSource(input)) {
    blockers.add("USER_PROVIDED_REVIEWED_PROVISIONAL_CANNOT_BECOME_OFFICIAL_CONTRACT");
  }

  if (isCapturedSilverBenchmarkSource(input)) {
    blockers.add("SILVER_BENCHMARK_CANNOT_BE_OFFICIAL_SOURCE");
  }

  const requiredMetadata = [
    ["contractId", "OFFICIAL_RATE_CARD_CONTRACT_ID_REQUIRED"],
    ["signedDate", "OFFICIAL_RATE_CARD_SIGNED_DATE_REQUIRED"],
    ["effectiveFrom", "OFFICIAL_RATE_CARD_EFFECTIVE_FROM_REQUIRED"],
    ["effectiveTo", "OFFICIAL_RATE_CARD_EFFECTIVE_TO_REQUIRED"],
    ["approvedBy", "OFFICIAL_RATE_CARD_APPROVED_BY_REQUIRED"],
    ["documentRef", "OFFICIAL_RATE_CARD_DOCUMENT_REF_REQUIRED"]
  ] as const;

  for (const [field, blocker] of requiredMetadata) {
    if (!hasText(input[field])) blockers.add(blocker);
  }

  if (input.settlementAllowed) {
    blockers.add("OFFICIAL_RATE_CARD_FINANCE_GATE_REQUIRED_FOR_SETTLEMENT");
  }

  if (input.reconciliationAllowed) {
    blockers.add("OFFICIAL_RATE_CARD_FINANCE_GATE_REQUIRED_FOR_RECONCILIATION");
  }

  if (input.publicSellerVisible) {
    blockers.add("OFFICIAL_RATE_CARD_SELLER_VISIBILITY_GATE_REQUIRED");
  }

  return {
    ready: blockers.size === 0,
    blockers: [...blockers],
    officialRatesEnabled: false,
    settlementAllowed: false,
    reconciliationAllowed: false,
    mutationPerformed: false,
    liveProviderCallPerformed: false
  };
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
    volumetricDivisor: cell.volumetricDivisor || 5000,
    rtoPercentage: cell.rtoPercentage || 0,
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
