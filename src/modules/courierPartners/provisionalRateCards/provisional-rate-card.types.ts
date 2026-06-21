import type { CourierProviderLaneCode } from "../providerRegistry/courier-provider-registry.types.js";

export const commercialRateCardGroupCodes = [
  "PILOT",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "ENTERPRISE",
  "CUSTOM"
] as const;
export type CommercialRateCardGroupCode = typeof commercialRateCardGroupCodes[number];

export const shipmastrOutcomeTierCodes = [
  "SHIPMASTR_SMART",
  "SHIPMASTR_ECONOMY",
  "SHIPMASTR_EXPRESS",
  "SHIPMASTR_COD_SHIELD",
  "SHIPMASTR_WEIGHT_GUARD",
  "SHIPMASTR_AUTOPILOT"
] as const;
export type ShipmastrOutcomeTierCode = typeof shipmastrOutcomeTierCodes[number];

export const provisionalRateCardSourceTypes = [
  "MANUAL_BENCHMARK",
  "OFFICIAL_CONTRACT",
  "INTERNAL_OVERRIDE",
  "PROVIDER_API"
] as const;
export type ProvisionalRateCardSourceType = typeof provisionalRateCardSourceTypes[number];

export const provisionalRateCardStatuses = [
  "DRAFT",
  "BENCHMARK_ONLY",
  "ACTIVE_INTERNAL",
  "OFFICIAL_PENDING",
  "OFFICIAL_ACTIVE",
  "EXPIRED",
  "ARCHIVED"
] as const;
export type ProvisionalRateCardStatus = typeof provisionalRateCardStatuses[number];

export const provisionalRateCardReviewStatuses = [
  "DRAFT",
  "IMPORTED",
  "VALIDATION_FAILED",
  "READY_FOR_REVIEW",
  "APPROVED_INTERNAL",
  "REJECTED",
  "ARCHIVED",
  "EXPIRED"
] as const;
export type ProvisionalRateCardReviewStatus = typeof provisionalRateCardReviewStatuses[number];

export const provisionalRateCardZoneCodes = [
  "WITHIN_CITY",
  "WITHIN_STATE",
  "METRO_TO_METRO",
  "ROI",
  "JK",
  "METRO",
  "ZONE",
  "STATE"
] as const;
export type ProvisionalRateCardZoneCode = typeof provisionalRateCardZoneCodes[number];

export type CommercialRateCardGroup = {
  groupCode: CommercialRateCardGroupCode;
  groupName: string;
  groupLevel: number;
  description: string;
  sellerSegment: string | null;
  defaultOutcomeTierCodes: ShipmastrOutcomeTierCode[];
  marginPolicy: {
    strategy: "NOT_CONFIGURED" | "INTERNAL_REVIEW" | "CUSTOM";
    settlementAllowed: boolean;
    reconciliationAllowed: boolean;
  };
  active: boolean;
  internalNotes: string[];
};

export type ShipmastrOutcomeTier = {
  outcomeCode: ShipmastrOutcomeTierCode;
  displayName: string;
  description: string;
  priority: number;
  sellerVisible: boolean;
  active: boolean;
  eligibilityRules: Record<string, unknown>;
};

export type ProvisionalRateCardWeightSlab = {
  minWeightKg: number;
  maxWeightKg: number;
  slabOrder: number;
  packageType: "ANY" | "DOCUMENT" | "PARCEL";
  active: boolean;
};

export type ProvisionalRateCardChargeCell = {
  laneCode: CourierProviderLaneCode;
  outcomeCode: ShipmastrOutcomeTierCode;
  zoneCode: ProvisionalRateCardZoneCode;
  weightSlab: ProvisionalRateCardWeightSlab;
  chargeAAmount: number | null;
  chargeBAmount: number | null;
  chargeALabel: "PRIMARY_CHARGE" | string;
  chargeBLabel: "SECONDARY_CHARGE" | string;
  codChargeA: number | null;
  codChargeB: number | null;
  codChargePolicy: "NOT_CONFIGURED" | "COMPONENTS_ONLY" | "OFFICIAL_CONFIRMED";
  volumetricDivisor: number;
  rtoPercentage: number;
  currency: "INR";
  gstTaxHandling: {
    status: "NOT_CONFIGURED" | "INCLUSIVE" | "EXCLUSIVE" | "REVIEW_REQUIRED";
    gstPercent: number | null;
  };
  notes: string[];
};

export type ProvisionalRateCardDefinition = {
  id: string;
  name: string;
  groupCode: CommercialRateCardGroupCode;
  sourceType: ProvisionalRateCardSourceType;
  status: ProvisionalRateCardStatus;
  official: boolean;
  officialContractRef: string | null;
  settlementAllowed: boolean;
  reconciliationAllowed: boolean;
  publicSellerVisible: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  reviewBy: string | null;
  allowedOutcomeTierCodes: ShipmastrOutcomeTierCode[];
  providerLaneMappings: Array<{
    outcomeCode: ShipmastrOutcomeTierCode;
    laneCodes: CourierProviderLaneCode[];
  }>;
  chargeCells: ProvisionalRateCardChargeCell[];
  internalNotes: string[];
};

export type ProvisionalRateCardSimulationInput = {
  outcomeCode: ShipmastrOutcomeTierCode;
  zoneCode: ProvisionalRateCardZoneCode;
  weightKg: number;
  sellerFacing?: boolean;
};

export type ProvisionalRateCardSimulationResult = {
  status: "BLOCKED" | "SIMULATED" | "NO_MATCH";
  blockerCode: string | null;
  sellerSafeQuote: {
    serviceTier: string;
    priceEstimate: number | null;
    currency: "INR";
    weightSlab: string | null;
    zoneLabel: string;
    groupLabel: string;
  } | null;
  adminDiagnostics: {
    sourceType: ProvisionalRateCardSourceType;
    status: ProvisionalRateCardStatus;
    official: boolean;
    settlementAllowed: boolean;
    reconciliationAllowed: boolean;
    publicSellerVisible: boolean;
    laneCode: CourierProviderLaneCode | null;
    chargeComponents: {
      chargeALabel: string;
      chargeAAmount: number | null;
      chargeBLabel: string;
      chargeBAmount: number | null;
      codChargeA: number | null;
      codChargeB: number | null;
      codChargePolicy: string;
    } | null;
    warnings: string[];
  };
};

export type ProvisionalRateCardImportMetadata = {
  sourceLabel: string | null;
  sourceNotes: string | null;
  uploadedBy: string | null;
  createdBy: string | null;
  importedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  expiresAt: string | null;
  originalFileName: string | null;
  checksum: string | null;
};

export type ProvisionalRateCardReviewRecord = ProvisionalRateCardDefinition & {
  reviewStatus: ProvisionalRateCardReviewStatus;
  validationErrors: string[];
  validationWarnings: string[];
  importMetadata: ProvisionalRateCardImportMetadata;
};

export type ProvisionalRateCardImportPreview = {
  previewId: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  mutationPerformed: false;
  liveProviderCallPerformed: false;
  officialRateClaim: false;
  settlementAllowed: false;
  reconciliationAllowed: false;
  publicSellerVisible: false;
  checksum: string;
  card: ProvisionalRateCardReviewRecord | null;
};
