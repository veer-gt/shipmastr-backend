import type {
  GrowthAttributionEventType,
  GrowthPartnerCategory,
  GrowthPartnerLeadStatus,
  GrowthPartnerStatus,
  GrowthPlacementSurface
} from "@prisma/client";

import type { PublicGrowthPartnerSuggestion } from "./partner-marketplace.types.js";

type GrowthPartnerRecord = {
  id: string;
  name: string;
  displayName: string;
  category: GrowthPartnerCategory | string;
  status: GrowthPartnerStatus | string;
  description?: string | null;
  websiteUrl?: string | null;
  isSponsored: boolean;
  metadata?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type GrowthPartnerPlacementRecord = {
  id: string;
  partnerId: string;
  offerId?: string | null;
  surface: GrowthPlacementSurface | string;
  priority: number;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type GrowthPartnerLeadRecord = {
  id: string;
  partnerId: string;
  merchantId?: string | null;
  sellerId?: string | null;
  offerId?: string | null;
  shipmentId?: string | null;
  orderId?: string | null;
  status: GrowthPartnerLeadStatus | string;
  sourceSurface: GrowthPlacementSurface | string;
  attributionRef?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type GrowthPartnerAttributionEventRecord = {
  id: string;
  partnerId?: string | null;
  offerId?: string | null;
  leadId?: string | null;
  merchantId?: string | null;
  sellerId?: string | null;
  eventType: GrowthAttributionEventType | string;
  surface: GrowthPlacementSurface | string;
  attributionRef?: string | null;
  sessionRef?: string | null;
  createdAt?: Date | string | null;
};

type PartnerPerformanceSummary = {
  partnerId: string;
  impressions: number;
  clicks: number;
  leadsCaptured: number;
  simulatedConversions: number;
  ctr: number;
  leadConversionRate: number;
  simulatedConversionRate: number;
  simulatedRevenuePaise: number | null;
  adSpendPaise: null;
  roas: null;
  revenueSource: "none" | "simulated_event_metadata";
  billingMode: "none";
};

const unsafePublicTextPattern = /\b(shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax|ecom express|ekart)\b/gi;

function timestamp(value: Date | string | null | undefined) {
  return value ?? null;
}

function safeText(value: string | null | undefined) {
  if (!value) return null;
  return value.replace(unsafePublicTextPattern, "Shipmastr logistics network");
}

function metadataRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function metadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? safeText(value) : null;
}

function safeInternalCtaUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

export function growthPartnerLabel(record: { isSponsored: boolean }) {
  return record.isSponsored ? "Sponsored Partner" : "Recommended";
}

export function serializeGrowthPartner(record: GrowthPartnerRecord) {
  return {
    partnerId: record.id,
    name: safeText(record.name) ?? "",
    displayName: safeText(record.displayName) ?? "",
    category: record.category,
    status: record.status,
    description: safeText(record.description),
    websiteUrl: record.websiteUrl ?? null,
    label: growthPartnerLabel(record),
    isSponsored: record.isSponsored,
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializeGrowthPartnerPlacement(record: GrowthPartnerPlacementRecord) {
  return {
    placementId: record.id,
    partnerId: record.partnerId,
    offerId: record.offerId ?? null,
    surface: record.surface,
    priority: record.priority,
    startsAt: timestamp(record.startsAt),
    endsAt: timestamp(record.endsAt),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializePublicGrowthPartnerSuggestion(
  partner: GrowthPartnerRecord,
  placement: GrowthPartnerPlacementRecord,
  surface: GrowthPlacementSurface
): PublicGrowthPartnerSuggestion {
  const metadata = metadataRecord(partner.metadata);
  const title = metadataText(metadata, "publicTitle") ?? safeText(partner.displayName) ?? "Partner recommendation";
  const description = metadataText(metadata, "publicDescription") ?? safeText(partner.description);
  const ctaLabel = metadataText(metadata, "ctaLabel") ?? "View partner";
  const ctaUrl = safeInternalCtaUrl(metadata.ctaUrl) ?? safeInternalCtaUrl(metadata.ctaPath);

  return {
    partnerId: partner.id,
    offerId: placement.offerId ?? null,
    displayName: safeText(partner.displayName) ?? "",
    category: partner.category as GrowthPartnerCategory,
    title,
    description,
    label: growthPartnerLabel(partner),
    ctaLabel,
    ctaUrl,
    surface,
    isSponsored: partner.isSponsored
  };
}

export function serializeGrowthPartnerLead(record: GrowthPartnerLeadRecord, duplicate = false) {
  return {
    leadId: record.id,
    partnerId: record.partnerId,
    merchantId: record.merchantId ?? null,
    sellerId: record.sellerId ?? null,
    offerId: record.offerId ?? null,
    shipmentId: record.shipmentId ?? null,
    orderId: record.orderId ?? null,
    status: record.status,
    sourceSurface: record.sourceSurface,
    attributionRef: record.attributionRef ?? null,
    duplicate,
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializeGrowthPartnerAttributionEvent(
  record: GrowthPartnerAttributionEventRecord,
  duplicate = false
) {
  return {
    eventId: record.id,
    partnerId: record.partnerId ?? null,
    offerId: record.offerId ?? null,
    leadId: record.leadId ?? null,
    merchantId: record.merchantId ?? null,
    sellerId: record.sellerId ?? null,
    eventType: record.eventType,
    surface: record.surface,
    attributionRef: record.attributionRef ?? null,
    sessionRef: record.sessionRef ?? null,
    duplicate,
    createdAt: timestamp(record.createdAt)
  };
}

export function serializeGrowthPartnerPerformanceSummary(summary: PartnerPerformanceSummary) {
  return summary;
}
