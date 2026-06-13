import type {
  GrowthEventType,
  GrowthOfferStatus,
  GrowthOfferType,
  GrowthPlacementSurface
} from "@prisma/client";
import { Prisma } from "@prisma/client";

import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  serializeGrowthOffer,
  serializeGrowthOfferEvent,
  serializeGrowthOfferPlacement,
  serializePublicGrowthOfferCard
} from "./growth-network.serializer.js";
import { growthOfferLevelEventTypes } from "./growth-network.types.js";
import type {
  CreateGrowthOfferInput,
  CreateGrowthOfferPlacementInput,
  ListGrowthOffersQueryInput,
  RecordGrowthEventInput,
  RecordTrackingPageViewInput,
  ResolveGrowthOffersQueryInput,
  UpdateGrowthOfferStatusInput
} from "./growth-network.validation.js";

type GrowthOfferRecord = {
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
  metadata?: unknown;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

type GrowthOfferWithPlacements = GrowthOfferRecord & {
  placements?: Array<{
    id: string;
    offerId: string;
    surface: GrowthPlacementSurface;
    priority: number;
    rulesJson?: unknown;
    createdAt: Date | string;
    updatedAt?: Date | string | null;
  }>;
};

type GrowthOfferPlacementRecord = {
  id: string;
  offerId: string;
  surface: GrowthPlacementSurface;
  priority: number;
  rulesJson?: unknown;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
};

type GrowthOfferEventRecord = {
  id: string;
  offerId?: string | null;
  merchantId?: string | null;
  sellerId?: string | null;
  shipmentId?: string | null;
  orderId?: string | null;
  eventType: GrowthEventType;
  surface: GrowthPlacementSurface;
  anonymousBuyerRef?: string | null;
  sessionRef?: string | null;
  idempotencyKey?: string | null;
  metadata?: unknown;
  createdAt: Date | string;
};

export type GrowthNetworkDb = {
  growthOffer: {
    create(input: { data: Record<string, unknown> }): Promise<GrowthOfferRecord>;
    findMany(input?: Record<string, unknown>): Promise<GrowthOfferWithPlacements[]>;
    findUnique(input: { where: Record<string, unknown> }): Promise<GrowthOfferRecord | null>;
    update(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<GrowthOfferRecord>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  growthOfferPlacement: {
    create(input: { data: Record<string, unknown> }): Promise<GrowthOfferPlacementRecord>;
  };
  growthOfferEvent: {
    findUnique(input: { where: Record<string, unknown> }): Promise<GrowthOfferEventRecord | null>;
    create(input: { data: Record<string, unknown> }): Promise<GrowthOfferEventRecord>;
  };
};

const defaultClient = prisma as unknown as GrowthNetworkDb;
const offerLevelEventSet = new Set<string>(growthOfferLevelEventTypes);
const unsafeMetadataKeyPattern = /buyer|email|phone|mobile|address|name|provider|courier|secret|token|authorization|cookie|card|payment/i;
const unsafeMetadataStringPattern = /@|\b\d{10,}\b|shiprocket|shipmozo|bigship|delhivery|bluedart|blue dart|xpressbees|shadowfax/i;

function cleanString(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function toStoredJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(sanitizeGrowthMetadata(value))) as Prisma.InputJsonValue;
}

function sanitizeGrowthMetadata(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeGrowthMetadata);
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeMetadataKeyPattern.test(key)) continue;
      safe[key] = sanitizeGrowthMetadata(child);
    }
    return safe;
  }
  if (typeof value === "string" && unsafeMetadataStringPattern.test(value)) return "[redacted]";
  return value;
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: string }).code === "P2002"
  );
}

function assertOfferIdAllowed(input: {
  eventType: GrowthEventType | string;
  offerId?: string | null | undefined;
}) {
  if (offerLevelEventSet.has(input.eventType) && !cleanString(input.offerId)) {
    throw new HttpError(400, "GROWTH_OFFER_ID_REQUIRED_FOR_EVENT");
  }
}

async function ensureOffer(offerId: string, client: GrowthNetworkDb) {
  const offer = await client.growthOffer.findUnique({ where: { id: offerId } });
  if (!offer) throw new HttpError(404, "GROWTH_OFFER_NOT_FOUND");
  return offer;
}

export async function createGrowthOffer(
  input: CreateGrowthOfferInput,
  client: GrowthNetworkDb = defaultClient
) {
  const offer = await client.growthOffer.create({
    data: {
      merchantId: cleanString(input.merchantId),
      title: input.title,
      subtitle: cleanString(input.subtitle),
      description: cleanString(input.description),
      type: input.type,
      status: input.status,
      isSponsored: input.isSponsored,
      sponsorName: input.isSponsored ? cleanString(input.sponsorName) : null,
      ctaLabel: input.ctaLabel,
      ctaUrl: cleanString(input.ctaUrl),
      metadata: toStoredJson(input.metadata),
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null
    }
  });

  return serializeGrowthOffer(offer);
}

export async function listGrowthOffers(
  query: ListGrowthOffersQueryInput,
  client: GrowthNetworkDb = defaultClient
) {
  const where = {
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.status ? { status: query.status } : {})
  };
  const [offers, total] = await Promise.all([
    client.growthOffer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.growthOffer.count({ where })
  ]);

  return {
    offers: offers.map(serializeGrowthOffer),
    pagination: {
      page: query.page,
      perPage: query.perPage,
      total,
      hasMore: query.page * query.perPage < total
    }
  };
}

export async function updateGrowthOfferStatus(
  offerId: string,
  input: UpdateGrowthOfferStatusInput,
  client: GrowthNetworkDb = defaultClient
) {
  await ensureOffer(offerId, client);
  const offer = await client.growthOffer.update({
    where: { id: offerId },
    data: { status: input.status }
  });
  return serializeGrowthOffer(offer);
}

export async function addGrowthOfferPlacement(
  offerId: string,
  input: CreateGrowthOfferPlacementInput,
  client: GrowthNetworkDb = defaultClient
) {
  await ensureOffer(offerId, client);
  const placement = await client.growthOfferPlacement.create({
    data: {
      offerId,
      surface: input.surface,
      priority: input.priority,
      rulesJson: toStoredJson(input.rulesJson)
    }
  });
  return serializeGrowthOfferPlacement(placement);
}

export async function resolvePublicGrowthOffersForSurface(
  surface: GrowthPlacementSurface,
  query: ResolveGrowthOffersQueryInput,
  client: GrowthNetworkDb = defaultClient,
  now = new Date()
) {
  const contextMerchantId = cleanString(query.merchantId);
  const merchantScope = contextMerchantId
    ? { OR: [{ merchantId: null }, { merchantId: contextMerchantId }] }
    : { merchantId: null };

  const offers = await client.growthOffer.findMany({
    where: {
      status: "ACTIVE",
      placements: { some: { surface } },
      AND: [
        merchantScope,
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }
      ]
    },
    include: {
      placements: {
        where: { surface },
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }]
      }
    }
  });

  const eligible = offers
    .filter((offer) => (offer.placements ?? []).length > 0)
    .sort((left, right) => {
      const leftPlacement = left.placements?.[0];
      const rightPlacement = right.placements?.[0];
      const priorityDelta = (leftPlacement?.priority ?? 100) - (rightPlacement?.priority ?? 100);
      if (priorityDelta !== 0) return priorityDelta;
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    })
    .slice(0, query.max)
    .map((offer) => serializePublicGrowthOfferCard(offer, surface));

  return {
    surface,
    offers: eligible
  };
}

export async function recordGrowthEvent(
  input: RecordGrowthEventInput,
  client: GrowthNetworkDb = defaultClient
) {
  assertOfferIdAllowed(input);

  const offerId = cleanString(input.offerId);
  if (offerId) await ensureOffer(offerId, client);

  const idempotencyKey = cleanString(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await client.growthOfferEvent.findUnique({ where: { idempotencyKey } });
    if (existing) return serializeGrowthOfferEvent(existing, true);
  }

  try {
    const event = await client.growthOfferEvent.create({
      data: {
        offerId,
        merchantId: cleanString(input.merchantId),
        sellerId: cleanString(input.sellerId),
        shipmentId: cleanString(input.shipmentId),
        orderId: cleanString(input.orderId),
        eventType: input.eventType,
        surface: input.surface,
        anonymousBuyerRef: cleanString(input.anonymousBuyerRef),
        sessionRef: cleanString(input.sessionRef),
        idempotencyKey,
        metadata: toStoredJson(input.metadata)
      }
    });

    return serializeGrowthOfferEvent(event, false);
  } catch (error) {
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await client.growthOfferEvent.findUnique({ where: { idempotencyKey } });
      if (existing) return serializeGrowthOfferEvent(existing, true);
    }
    throw error;
  }
}

export async function recordTrackingPageView(
  input: RecordTrackingPageViewInput,
  client: GrowthNetworkDb = defaultClient
) {
  return recordGrowthEvent({
    ...input,
    eventType: "VIEW",
    surface: "TRACKING_PAGE"
  }, client);
}
