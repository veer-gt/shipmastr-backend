import type {
  GrowthPlacementSurface,
  MerchantCampaignEventType,
  MerchantCampaignReviewStatus,
  MerchantCampaignStatus,
  MerchantCampaignType
} from "@prisma/client";

import {
  safeInternalCtaUrl,
  safePublicText,
  timestamp
} from "./growth-network-maturity.shared.js";
import type { PublicMerchantCampaignCard } from "./merchant-campaign.types.js";

export type MerchantCampaignRecord = {
  id: string;
  merchantId: string;
  title: string;
  description?: string | null;
  campaignType: MerchantCampaignType | string;
  status: MerchantCampaignStatus | string;
  reviewStatus: MerchantCampaignReviewStatus | string;
  rejectionReason?: string | null;
  growthOfferId?: string | null;
  surface: GrowthPlacementSurface | string;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  ctaLabel: string;
  ctaUrl?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type MerchantCampaignEventRecord = {
  id: string;
  campaignId: string;
  merchantId?: string | null;
  sellerId?: string | null;
  eventType: MerchantCampaignEventType | string;
  surface?: GrowthPlacementSurface | string | null;
  growthOfferEventId?: string | null;
  createdAt?: Date | string | null;
};

export function serializeMerchantCampaign(record: MerchantCampaignRecord) {
  return {
    campaignId: record.id,
    merchantId: record.merchantId,
    title: safePublicText(record.title) ?? "",
    description: safePublicText(record.description),
    campaignType: record.campaignType,
    status: record.status,
    reviewStatus: record.reviewStatus,
    rejectionReason: record.rejectionReason ?? null,
    growthOfferId: record.growthOfferId ?? null,
    surface: record.surface,
    label: "Merchant Offer",
    ctaLabel: safePublicText(record.ctaLabel) ?? "",
    ctaUrl: safeInternalCtaUrl(record.ctaUrl),
    startsAt: timestamp(record.startsAt),
    endsAt: timestamp(record.endsAt),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializePublicMerchantCampaignCard(
  record: MerchantCampaignRecord,
  surface: GrowthPlacementSurface
): PublicMerchantCampaignCard {
  return {
    campaignId: record.id,
    offerId: record.growthOfferId ?? null,
    merchantId: record.merchantId,
    title: safePublicText(record.title) ?? "",
    description: safePublicText(record.description),
    campaignType: record.campaignType as MerchantCampaignType,
    label: "Merchant Offer",
    ctaLabel: safePublicText(record.ctaLabel) ?? "",
    ctaUrl: safeInternalCtaUrl(record.ctaUrl),
    surface
  };
}

export function serializeMerchantCampaignEvent(record: MerchantCampaignEventRecord) {
  return {
    eventId: record.id,
    campaignId: record.campaignId,
    merchantId: record.merchantId ?? null,
    sellerId: record.sellerId ?? null,
    eventType: record.eventType,
    surface: record.surface ?? null,
    growthOfferEventId: record.growthOfferEventId ?? null,
    createdAt: timestamp(record.createdAt)
  };
}

export function serializeMerchantCampaignPerformanceSummary(input: {
  campaignId: string;
  impressions: number;
  clicks: number;
  dismissals: number;
  simulatedConversions: number;
  ctr: number;
  conversionRate: number;
  dismissRate: number;
}) {
  return {
    ...input,
    revenueMode: "none",
    roasMode: "not_calculated",
    billingMode: "none"
  };
}
