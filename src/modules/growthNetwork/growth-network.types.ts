import type {
  GrowthEventType,
  GrowthOfferStatus,
  GrowthOfferType,
  GrowthPlacementSurface
} from "@prisma/client";

export const growthPlacementSurfaces = [
  "TRACKING_PAGE",
  "SELLER_DASHBOARD",
  "CHECKOUT",
  "POST_DELIVERY",
  "NDR_ACTION",
  "BUILD_ON_SHIPMASTR"
] as const satisfies readonly GrowthPlacementSurface[];

export const growthOfferTypes = [
  "MERCHANT_REORDER",
  "MERCHANT_CROSS_SELL",
  "PREPAID_INCENTIVE",
  "COD_RISK_REDUCTION",
  "PACKAGING_RECOMMENDATION",
  "INSURANCE_RECOMMENDATION",
  "PARTNER_SPONSORED",
  "STORE_GROWTH_TOOL"
] as const satisfies readonly GrowthOfferType[];

export const growthOfferStatuses = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED"
] as const satisfies readonly GrowthOfferStatus[];

export const growthManageableOfferStatuses = [
  "ACTIVE",
  "PAUSED",
  "ARCHIVED"
] as const satisfies readonly GrowthOfferStatus[];

export const growthEventTypes = [
  "VIEW",
  "IMPRESSION",
  "CLICK",
  "DISMISS",
  "CONVERSION"
] as const satisfies readonly GrowthEventType[];

export const growthOfferLevelEventTypes = [
  "IMPRESSION",
  "CLICK",
  "DISMISS",
  "CONVERSION"
] as const satisfies readonly GrowthEventType[];

export type PublicGrowthOfferCard = {
  offerId: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  type: GrowthOfferType;
  label: "Recommended" | "Merchant Offer" | "Sponsored Partner";
  ctaLabel: string;
  ctaUrl: string | null;
  isSponsored: boolean;
  sponsorName?: string | null;
  surface: GrowthPlacementSurface;
};
