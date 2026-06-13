import type {
  GrowthEventType,
  GrowthOfferStatus,
  GrowthOfferType,
  GrowthPlacementSurface
} from "@prisma/client";

import type { PublicGrowthOfferCard } from "./growth-network.types.js";

type GrowthOfferRecord = {
  id: string;
  merchantId?: string | null;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  type: GrowthOfferType | string;
  status: GrowthOfferStatus | string;
  isSponsored: boolean;
  sponsorName?: string | null;
  ctaLabel: string;
  ctaUrl?: string | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type GrowthOfferPlacementRecord = {
  id: string;
  offerId: string;
  surface: GrowthPlacementSurface | string;
  priority: number;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type GrowthOfferEventRecord = {
  id: string;
  offerId?: string | null;
  merchantId?: string | null;
  sellerId?: string | null;
  shipmentId?: string | null;
  orderId?: string | null;
  eventType: GrowthEventType | string;
  surface: GrowthPlacementSurface | string;
  createdAt?: Date | string | null;
};

const unsafePublicTextPattern = /\b(shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax|ecom express|ekart)\b/gi;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function safeText(value: string | null | undefined) {
  if (!value) return null;
  return value.replace(unsafePublicTextPattern, "Shipmastr logistics network");
}

export function growthOfferLabel(record: {
  merchantId?: string | null;
  isSponsored: boolean;
}) {
  if (record.isSponsored) return "Sponsored Partner";
  if (record.merchantId) return "Merchant Offer";
  return "Recommended";
}

export function serializeGrowthOffer(record: GrowthOfferRecord) {
  return {
    offerId: record.id,
    merchantId: record.merchantId ?? null,
    title: safeText(record.title) ?? "",
    subtitle: safeText(record.subtitle),
    description: safeText(record.description),
    type: record.type,
    status: record.status,
    label: growthOfferLabel(record),
    ctaLabel: safeText(record.ctaLabel) ?? "",
    ctaUrl: record.ctaUrl ?? null,
    isSponsored: record.isSponsored,
    ...(record.isSponsored ? { sponsorName: safeText(record.sponsorName) } : {}),
    startsAt: timestamp(record.startsAt),
    endsAt: timestamp(record.endsAt),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializeGrowthOfferPlacement(record: GrowthOfferPlacementRecord) {
  return {
    placementId: record.id,
    offerId: record.offerId,
    surface: record.surface,
    priority: record.priority,
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializeGrowthOfferEvent(record: GrowthOfferEventRecord, duplicate = false) {
  return {
    eventId: record.id,
    offerId: record.offerId ?? null,
    merchantId: record.merchantId ?? null,
    sellerId: record.sellerId ?? null,
    shipmentId: record.shipmentId ?? null,
    orderId: record.orderId ?? null,
    eventType: record.eventType,
    surface: record.surface,
    duplicate,
    createdAt: timestamp(record.createdAt)
  };
}

export function serializePublicGrowthOfferCard(
  record: GrowthOfferRecord,
  surface: GrowthPlacementSurface
): PublicGrowthOfferCard {
  const card: PublicGrowthOfferCard = {
    offerId: record.id,
    title: safeText(record.title) ?? "",
    subtitle: safeText(record.subtitle),
    description: safeText(record.description),
    type: record.type as GrowthOfferType,
    label: growthOfferLabel(record),
    ctaLabel: safeText(record.ctaLabel) ?? "",
    ctaUrl: record.ctaUrl ?? null,
    isSponsored: record.isSponsored,
    surface
  };

  if (record.isSponsored) {
    card.sponsorName = safeText(record.sponsorName);
  }

  return card;
}
