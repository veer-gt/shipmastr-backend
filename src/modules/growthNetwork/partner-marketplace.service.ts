import type {
  GrowthAttributionEventType,
  GrowthPartnerCategory,
  GrowthPartnerLeadStatus,
  GrowthPartnerStatus,
  GrowthPlacementSurface
} from "@prisma/client";
import { Prisma } from "@prisma/client";

import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import type { GrowthNetworkDb } from "./growth-network.service.js";
import {
  serializeGrowthPartner,
  serializeGrowthPartnerAttributionEvent,
  serializeGrowthPartnerLead,
  serializeGrowthPartnerPerformanceSummary,
  serializeGrowthPartnerPlacement,
  serializePublicGrowthPartnerSuggestion
} from "./partner-marketplace.serializer.js";
import type {
  CaptureGrowthPartnerLeadInput,
  CreateGrowthPartnerInput,
  CreateGrowthPartnerPlacementInput,
  ListGrowthPartnersQueryInput,
  RecordGrowthPartnerAttributionEventInput,
  ResolveGrowthPartnerSuggestionsQueryInput,
  UpdateGrowthPartnerStatusInput
} from "./partner-marketplace.validation.js";

type GrowthPartnerRecord = {
  id: string;
  name: string;
  displayName: string;
  category: GrowthPartnerCategory;
  status: GrowthPartnerStatus;
  description?: string | null;
  websiteUrl?: string | null;
  isSponsored: boolean;
  metadata?: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

type GrowthPartnerPlacementRecord = {
  id: string;
  partnerId: string;
  offerId?: string | null;
  surface: GrowthPlacementSurface;
  priority: number;
  rulesJson?: unknown;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  createdAt: Date | string;
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
  status: GrowthPartnerLeadStatus;
  sourceSurface: GrowthPlacementSurface;
  attributionRef?: string | null;
  idempotencyKey?: string | null;
  metadata?: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

type GrowthPartnerAttributionEventRecord = {
  id: string;
  partnerId?: string | null;
  offerId?: string | null;
  leadId?: string | null;
  merchantId?: string | null;
  sellerId?: string | null;
  eventType: GrowthAttributionEventType;
  surface: GrowthPlacementSurface;
  attributionRef?: string | null;
  sessionRef?: string | null;
  idempotencyKey?: string | null;
  metadata?: unknown;
  createdAt: Date | string;
};

export type PartnerMarketplaceDb = {
  growthOffer?: GrowthNetworkDb["growthOffer"];
  growthPartner: {
    create(input: { data: Record<string, unknown> }): Promise<GrowthPartnerRecord>;
    findMany(input?: Record<string, unknown>): Promise<GrowthPartnerRecord[]>;
    findUnique(input: { where: Record<string, unknown> }): Promise<GrowthPartnerRecord | null>;
    update(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<GrowthPartnerRecord>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  growthPartnerPlacement: {
    create(input: { data: Record<string, unknown> }): Promise<GrowthPartnerPlacementRecord>;
    findMany(input?: Record<string, unknown>): Promise<GrowthPartnerPlacementRecord[]>;
  };
  growthPartnerLead: {
    create(input: { data: Record<string, unknown> }): Promise<GrowthPartnerLeadRecord>;
    findUnique(input: { where: Record<string, unknown> }): Promise<GrowthPartnerLeadRecord | null>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  growthPartnerAttributionEvent: {
    create(input: { data: Record<string, unknown> }): Promise<GrowthPartnerAttributionEventRecord>;
    findUnique(input: { where: Record<string, unknown> }): Promise<GrowthPartnerAttributionEventRecord | null>;
    findMany(input?: Record<string, unknown>): Promise<GrowthPartnerAttributionEventRecord[]>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
};

const defaultClient = prisma as unknown as PartnerMarketplaceDb;
const unsafeMetadataKeyPattern = /buyer|email|phone|mobile|address|name|provider|courier|secret|token|authorization|cookie|card|payment|billing|invoice|payout/i;
const unsafeMetadataStringPattern = /@|\b\d{10,}\b|shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax|ecom express|ekart/i;

function cleanString(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function sanitizePartnerMetadata(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizePartnerMetadata);
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeMetadataKeyPattern.test(key)) continue;
      safe[key] = sanitizePartnerMetadata(child);
    }
    return safe;
  }
  if (typeof value === "string" && unsafeMetadataStringPattern.test(value)) return "[redacted]";
  return value;
}

function toStoredJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(sanitizePartnerMetadata(value))) as Prisma.InputJsonValue;
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "P2002"
  );
}

function dateIsLive(startsAt: Date | string | null | undefined, endsAt: Date | string | null | undefined, now: Date) {
  const startsAtMs = startsAt ? new Date(startsAt).getTime() : null;
  const endsAtMs = endsAt ? new Date(endsAt).getTime() : null;
  const nowMs = now.getTime();
  return (startsAtMs == null || startsAtMs <= nowMs) && (endsAtMs == null || endsAtMs >= nowMs);
}

function activePlacementWhere(surface: GrowthPlacementSurface, now: Date) {
  return {
    surface,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }
    ]
  };
}

function rate(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function simulatedRevenuePaiseFrom(events: GrowthPartnerAttributionEventRecord[]) {
  let total = 0;
  for (const event of events) {
    const metadata = event.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const value = (metadata as Record<string, unknown>).simulatedRevenuePaise;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      total += Math.trunc(value);
    }
  }
  return total > 0 ? total : null;
}

async function ensurePartner(partnerId: string, client: PartnerMarketplaceDb) {
  const partner = await client.growthPartner.findUnique({ where: { id: partnerId } });
  if (!partner) throw new HttpError(404, "GROWTH_PARTNER_NOT_FOUND");
  return partner;
}

async function ensureOfferIfProvided(offerId: string | null, client: PartnerMarketplaceDb) {
  if (!offerId || !client.growthOffer) return;
  const offer = await client.growthOffer.findUnique({ where: { id: offerId } });
  if (!offer) throw new HttpError(404, "GROWTH_OFFER_NOT_FOUND");
}

async function findLead(leadId: string, client: PartnerMarketplaceDb) {
  const lead = await client.growthPartnerLead.findUnique({ where: { id: leadId } });
  if (!lead) throw new HttpError(404, "GROWTH_PARTNER_LEAD_NOT_FOUND");
  return lead;
}

export async function createGrowthPartner(
  input: CreateGrowthPartnerInput,
  client: PartnerMarketplaceDb = defaultClient
) {
  const partner = await client.growthPartner.create({
    data: {
      name: input.name,
      displayName: input.displayName,
      category: input.category,
      status: input.status,
      description: cleanString(input.description),
      websiteUrl: cleanString(input.websiteUrl),
      isSponsored: input.isSponsored,
      metadata: toStoredJson(input.metadata)
    }
  });

  return serializeGrowthPartner(partner);
}

export async function listGrowthPartners(
  query: ListGrowthPartnersQueryInput,
  client: PartnerMarketplaceDb = defaultClient
) {
  const where = {
    ...(query.category ? { category: query.category } : {}),
    ...(query.status ? { status: query.status } : {})
  };
  const [partners, total] = await Promise.all([
    client.growthPartner.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.growthPartner.count({ where })
  ]);

  return {
    partners: partners.map(serializeGrowthPartner),
    pagination: {
      page: query.page,
      perPage: query.perPage,
      total,
      hasMore: query.page * query.perPage < total
    }
  };
}

export async function updateGrowthPartnerStatus(
  partnerId: string,
  input: UpdateGrowthPartnerStatusInput,
  client: PartnerMarketplaceDb = defaultClient
) {
  await ensurePartner(partnerId, client);
  const partner = await client.growthPartner.update({
    where: { id: partnerId },
    data: { status: input.status }
  });
  return serializeGrowthPartner(partner);
}

export async function addGrowthPartnerPlacement(
  partnerId: string,
  input: CreateGrowthPartnerPlacementInput,
  client: PartnerMarketplaceDb = defaultClient
) {
  await ensurePartner(partnerId, client);
  const offerId = cleanString(input.offerId);
  await ensureOfferIfProvided(offerId, client);

  const placement = await client.growthPartnerPlacement.create({
    data: {
      partnerId,
      offerId,
      surface: input.surface,
      priority: input.priority,
      rulesJson: toStoredJson(input.rulesJson),
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null
    }
  });

  return serializeGrowthPartnerPlacement(placement);
}

export async function resolvePublicGrowthPartnerSuggestions(
  surface: GrowthPlacementSurface,
  query: ResolveGrowthPartnerSuggestionsQueryInput,
  client: PartnerMarketplaceDb = defaultClient,
  now = new Date()
) {
  const placements = await client.growthPartnerPlacement.findMany({
    where: activePlacementWhere(surface, now),
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }]
  });

  const suggestions = [];
  for (const placement of placements) {
    if (suggestions.length >= query.max) break;
    if (placement.surface !== surface || !dateIsLive(placement.startsAt, placement.endsAt, now)) continue;

    const partner = await client.growthPartner.findUnique({ where: { id: placement.partnerId } });
    if (!partner || partner.status !== "ACTIVE") continue;

    suggestions.push(serializePublicGrowthPartnerSuggestion(partner, placement, surface));
  }

  return {
    surface,
    suggestions
  };
}

export async function captureGrowthPartnerLead(
  input: CaptureGrowthPartnerLeadInput,
  client: PartnerMarketplaceDb = defaultClient
) {
  const partner = await ensurePartner(input.partnerId, client);
  if (partner.status !== "ACTIVE") throw new HttpError(409, "GROWTH_PARTNER_NOT_ACTIVE");

  const offerId = cleanString(input.offerId);
  await ensureOfferIfProvided(offerId, client);

  const idempotencyKey = cleanString(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await client.growthPartnerLead.findUnique({ where: { idempotencyKey } });
    if (existing) return serializeGrowthPartnerLead(existing, true);
  }

  try {
    const lead = await client.growthPartnerLead.create({
      data: {
        partnerId: input.partnerId,
        merchantId: cleanString(input.merchantId),
        sellerId: cleanString(input.sellerId),
        offerId,
        shipmentId: cleanString(input.shipmentId),
        orderId: cleanString(input.orderId),
        status: input.status,
        sourceSurface: input.sourceSurface,
        attributionRef: cleanString(input.attributionRef),
        idempotencyKey,
        metadata: toStoredJson({
          ...(input.metadata ?? {}),
          leadCaptureMode: "simulated"
        })
      }
    });

    return serializeGrowthPartnerLead(lead, false);
  } catch (error) {
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await client.growthPartnerLead.findUnique({ where: { idempotencyKey } });
      if (existing) return serializeGrowthPartnerLead(existing, true);
    }
    throw error;
  }
}

export async function recordGrowthPartnerAttributionEvent(
  input: RecordGrowthPartnerAttributionEventInput,
  client: PartnerMarketplaceDb = defaultClient
) {
  const leadId = cleanString(input.leadId);
  const lead = leadId ? await findLead(leadId, client) : null;
  const partnerId = cleanString(input.partnerId) ?? lead?.partnerId ?? null;
  if (partnerId) await ensurePartner(partnerId, client);

  const offerId = cleanString(input.offerId) ?? lead?.offerId ?? null;
  await ensureOfferIfProvided(offerId, client);

  const idempotencyKey = cleanString(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await client.growthPartnerAttributionEvent.findUnique({ where: { idempotencyKey } });
    if (existing) return serializeGrowthPartnerAttributionEvent(existing, true);
  }

  try {
    const event = await client.growthPartnerAttributionEvent.create({
      data: {
        partnerId,
        offerId,
        leadId,
        merchantId: cleanString(input.merchantId) ?? lead?.merchantId ?? null,
        sellerId: cleanString(input.sellerId) ?? lead?.sellerId ?? null,
        eventType: input.eventType,
        surface: input.surface,
        attributionRef: cleanString(input.attributionRef) ?? lead?.attributionRef ?? null,
        sessionRef: cleanString(input.sessionRef),
        idempotencyKey,
        metadata: toStoredJson(input.metadata)
      }
    });

    return serializeGrowthPartnerAttributionEvent(event, false);
  } catch (error) {
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await client.growthPartnerAttributionEvent.findUnique({ where: { idempotencyKey } });
      if (existing) return serializeGrowthPartnerAttributionEvent(existing, true);
    }
    throw error;
  }
}

export async function getGrowthPartnerPerformanceSummary(
  partnerId: string,
  client: PartnerMarketplaceDb = defaultClient
) {
  await ensurePartner(partnerId, client);

  const [impressions, clicks, leadsCaptured, simulatedConversions, conversionEvents] = await Promise.all([
    client.growthPartnerAttributionEvent.count({ where: { partnerId, eventType: "IMPRESSION" } }),
    client.growthPartnerAttributionEvent.count({ where: { partnerId, eventType: "CLICK" } }),
    client.growthPartnerLead.count({ where: { partnerId } }),
    client.growthPartnerAttributionEvent.count({ where: { partnerId, eventType: "CONVERSION_SIMULATED" } }),
    client.growthPartnerAttributionEvent.findMany({
      where: { partnerId, eventType: "CONVERSION_SIMULATED" }
    })
  ]);
  const simulatedRevenuePaise = simulatedRevenuePaiseFrom(conversionEvents);

  return serializeGrowthPartnerPerformanceSummary({
    partnerId,
    impressions,
    clicks,
    leadsCaptured,
    simulatedConversions,
    ctr: rate(clicks, impressions),
    leadConversionRate: rate(leadsCaptured, clicks),
    simulatedConversionRate: rate(simulatedConversions, leadsCaptured),
    simulatedRevenuePaise,
    adSpendPaise: null,
    roas: null,
    revenueSource: simulatedRevenuePaise == null ? "none" : "simulated_event_metadata",
    billingMode: "none"
  });
}
