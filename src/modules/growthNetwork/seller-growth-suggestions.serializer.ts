import type {
  GrowthOfferStatus,
  GrowthOfferType
} from "@prisma/client";

import { serializePublicGrowthOfferCard } from "./growth-network.serializer.js";
import {
  sellerDashboardGrowthSurface,
  type SellerGrowthSuggestion
} from "./seller-growth-suggestions.types.js";

type GrowthOfferSuggestionRecord = {
  id: string;
  merchantId?: string | null;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  type: GrowthOfferType;
  status: GrowthOfferStatus;
  isSponsored: boolean;
  sponsorName?: string | null;
  ctaLabel: string;
  ctaUrl?: string | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type SystemSellerGrowthSuggestionInput = {
  suggestionId: string;
  title: string;
  description: string;
  type: GrowthOfferType;
  ctaLabel: string;
  ctaUrl: string;
  priority: number;
};

function safeText(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function safeSellerDashboardUrl(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.startsWith("/seller/") ? trimmed : null;
}

export function serializeOfferSellerGrowthSuggestion(
  record: GrowthOfferSuggestionRecord,
  priority: number
): SellerGrowthSuggestion {
  const card = serializePublicGrowthOfferCard(record, sellerDashboardGrowthSurface);
  const suggestion: SellerGrowthSuggestion = {
    suggestionId: `offer:${card.offerId}`,
    offerId: card.offerId,
    title: card.title,
    description: card.description ?? card.subtitle,
    type: card.type,
    label: card.label,
    ctaLabel: card.ctaLabel,
    ctaUrl: safeSellerDashboardUrl(card.ctaUrl),
    priority,
    surface: sellerDashboardGrowthSurface,
    isSponsored: card.isSponsored
  };

  if (card.isSponsored) {
    suggestion.sponsorName = card.sponsorName ?? null;
  }

  return suggestion;
}

export function serializeSystemSellerGrowthSuggestion(
  input: SystemSellerGrowthSuggestionInput
): SellerGrowthSuggestion {
  return {
    suggestionId: input.suggestionId,
    offerId: null,
    title: safeText(input.title) ?? "",
    description: safeText(input.description),
    type: input.type,
    label: "Recommended",
    ctaLabel: safeText(input.ctaLabel) ?? "",
    ctaUrl: safeSellerDashboardUrl(input.ctaUrl),
    priority: input.priority,
    surface: sellerDashboardGrowthSurface,
    isSponsored: false
  };
}
