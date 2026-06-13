import type {
  GrowthAttributionEventType,
  GrowthPartnerCategory,
  GrowthPartnerLeadStatus,
  GrowthPartnerStatus,
  GrowthPlacementSurface
} from "@prisma/client";

export const growthPartnerStatuses = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED"
] as const satisfies readonly GrowthPartnerStatus[];

export const growthManageablePartnerStatuses = [
  "ACTIVE",
  "PAUSED",
  "ARCHIVED"
] as const satisfies readonly GrowthPartnerStatus[];

export const growthPartnerCategories = [
  "PACKAGING",
  "INSURANCE",
  "FINANCING",
  "STORE_GROWTH_TOOL",
  "DOMAIN_HOSTING",
  "DESIGN_THEME",
  "RETURNS_MANAGEMENT",
  "CUSTOMER_SUPPORT",
  "ANALYTICS",
  "OTHER"
] as const satisfies readonly GrowthPartnerCategory[];

export const growthPartnerLeadStatuses = [
  "CAPTURED",
  "QUALIFIED_SIMULATED",
  "DISQUALIFIED",
  "ARCHIVED"
] as const satisfies readonly GrowthPartnerLeadStatus[];

export const growthAttributionEventTypes = [
  "IMPRESSION",
  "CLICK",
  "LEAD_CAPTURED",
  "CONVERSION_SIMULATED",
  "DISMISS"
] as const satisfies readonly GrowthAttributionEventType[];

export type PublicGrowthPartnerSuggestion = {
  partnerId: string;
  offerId: string | null;
  displayName: string;
  category: GrowthPartnerCategory;
  title: string;
  description: string | null;
  label: "Recommended" | "Sponsored Partner";
  ctaLabel: string;
  ctaUrl: string | null;
  surface: GrowthPlacementSurface;
  isSponsored: boolean;
};
