import type {
  GrowthOfferType,
  GrowthPlacementSurface,
  MerchantCampaignEventType,
  MerchantCampaignReviewStatus,
  MerchantCampaignStatus,
  MerchantCampaignType
} from "@prisma/client";

export const merchantCampaignStatuses = [
  "DRAFT",
  "PENDING_REVIEW",
  "ACTIVE",
  "PAUSED",
  "REJECTED",
  "ARCHIVED"
] as const satisfies readonly MerchantCampaignStatus[];

export const merchantCampaignTypes = [
  "TRACKING_REORDER",
  "COD_TO_PREPAID",
  "RTO_NDR_RECOVERY",
  "CROSS_SELL",
  "PACKAGING_QUALITY",
  "CUSTOM_MESSAGE"
] as const satisfies readonly MerchantCampaignType[];

export const merchantCampaignReviewStatuses = [
  "NOT_REQUIRED",
  "PENDING",
  "APPROVED",
  "REJECTED"
] as const satisfies readonly MerchantCampaignReviewStatus[];

export const merchantCampaignEventTypes = [
  "CREATED",
  "UPDATED",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "ACTIVATED",
  "PAUSED",
  "ARCHIVED",
  "IMPRESSION",
  "CLICK",
  "DISMISS",
  "CONVERSION_SIMULATED"
] as const satisfies readonly MerchantCampaignEventType[];

export const campaignPublicEventTypes = [
  "IMPRESSION",
  "CLICK",
  "DISMISS",
  "CONVERSION_SIMULATED"
] as const satisfies readonly MerchantCampaignEventType[];

export function campaignTypeToGrowthOfferType(type: MerchantCampaignType | string): GrowthOfferType {
  switch (type) {
    case "TRACKING_REORDER":
      return "MERCHANT_REORDER";
    case "COD_TO_PREPAID":
      return "PREPAID_INCENTIVE";
    case "RTO_NDR_RECOVERY":
      return "RTO_NDR_RECOVERY";
    case "CROSS_SELL":
      return "MERCHANT_CROSS_SELL";
    case "PACKAGING_QUALITY":
      return "PACKAGING_RECOMMENDATION";
    case "CUSTOM_MESSAGE":
    default:
      return "STORE_GROWTH_TOOL";
  }
}

export type PublicMerchantCampaignCard = {
  campaignId: string;
  offerId: string | null;
  merchantId: string;
  title: string;
  description: string | null;
  campaignType: MerchantCampaignType;
  label: "Merchant Offer";
  ctaLabel: string;
  ctaUrl: string | null;
  surface: GrowthPlacementSurface;
};
