import type {
  GrowthEventType,
  GrowthOfferType,
  GrowthPlacementSurface
} from "@prisma/client";

export const sellerDashboardGrowthSurface = "SELLER_DASHBOARD" as const satisfies GrowthPlacementSurface;

export const sellerGrowthSuggestionEventTypes = [
  "IMPRESSION",
  "CLICK",
  "DISMISS"
] as const satisfies readonly GrowthEventType[];

export type SellerGrowthSuggestion = {
  suggestionId: string;
  offerId: string | null;
  title: string;
  description: string | null;
  type: GrowthOfferType;
  label: "Recommended" | "Merchant Offer" | "Sponsored Partner";
  ctaLabel: string;
  ctaUrl: string | null;
  priority: number;
  surface: typeof sellerDashboardGrowthSurface;
  isSponsored: boolean;
  sponsorName?: string | null;
};
