import type {
  GrowthOfferStatus,
  GrowthOfferType,
  GrowthPlacementSurface
} from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import {
  recordGrowthEvent,
  type GrowthNetworkDb
} from "./growth-network.service.js";
import {
  serializeOfferSellerGrowthSuggestion,
  serializeSystemSellerGrowthSuggestion
} from "./seller-growth-suggestions.serializer.js";
import {
  sellerDashboardGrowthSurface,
  type SellerGrowthSuggestion
} from "./seller-growth-suggestions.types.js";
import type {
  RecordSellerGrowthSuggestionEventInput,
  ResolveSellerGrowthSuggestionsQueryInput
} from "./seller-growth-suggestions.validation.js";

type GrowthOfferWithPlacements = {
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
  createdAt: Date | string;
  placements?: Array<{
    id: string;
    offerId: string;
    surface: GrowthPlacementSurface;
    priority: number;
    createdAt: Date | string;
  }>;
};

type PolicyCounter = {
  count(input?: Record<string, unknown>): Promise<number>;
};

export type SellerGrowthSuggestionsDb = GrowthNetworkDb & {
  prepaidIncentivePolicy?: PolicyCounter;
  rtoNdrRecoveryPolicy?: PolicyCounter;
};

const defaultClient = prisma as unknown as SellerGrowthSuggestionsDb;

function cleanString(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function activeDateWhere(now: Date) {
  return [
    { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
    { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }
  ];
}

function merchantScope(merchantId: string | null) {
  return merchantId
    ? { OR: [{ merchantId: null }, { merchantId }] }
    : { merchantId: null };
}

function sortSuggestions(left: SellerGrowthSuggestion, right: SellerGrowthSuggestion) {
  const priorityDelta = left.priority - right.priority;
  if (priorityDelta !== 0) return priorityDelta;
  return left.suggestionId.localeCompare(right.suggestionId);
}

async function hasActivePolicy(
  delegate: PolicyCounter | undefined,
  merchantId: string | null,
  now: Date
) {
  if (!delegate || !merchantId) return false;

  const total = await delegate.count({
    where: {
      merchantId,
      status: "ACTIVE",
      AND: activeDateWhere(now)
    }
  });
  return total > 0;
}

async function resolveOfferSuggestions(
  query: ResolveSellerGrowthSuggestionsQueryInput,
  client: SellerGrowthSuggestionsDb,
  now: Date
) {
  const contextMerchantId = cleanString(query.merchantId);
  const offers = await client.growthOffer.findMany({
    where: {
      status: "ACTIVE",
      placements: { some: { surface: sellerDashboardGrowthSurface } },
      AND: [
        merchantScope(contextMerchantId),
        ...activeDateWhere(now)
      ]
    },
    include: {
      placements: {
        where: { surface: sellerDashboardGrowthSurface },
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }]
      }
    }
  });

  return offers
    .filter((offer) => (offer.placements ?? []).length > 0)
    .sort((left, right) => {
      const leftPlacement = left.placements?.[0];
      const rightPlacement = right.placements?.[0];
      const priorityDelta = (leftPlacement?.priority ?? 100) - (rightPlacement?.priority ?? 100);
      if (priorityDelta !== 0) return priorityDelta;
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    })
    .map((offer) => serializeOfferSellerGrowthSuggestion(
      offer as GrowthOfferWithPlacements,
      offer.placements?.[0]?.priority ?? 100
    ));
}

async function resolveSystemSuggestions(
  query: ResolveSellerGrowthSuggestionsQueryInput,
  client: SellerGrowthSuggestionsDb,
  offerSuggestions: SellerGrowthSuggestion[],
  now: Date
) {
  const merchantId = cleanString(query.merchantId);
  if (!merchantId) return [];

  const visibleTypes = new Set(offerSuggestions.map((suggestion) => suggestion.type));
  const [hasRecoveryPolicy, hasPrepaidPolicy] = await Promise.all([
    hasActivePolicy(client.rtoNdrRecoveryPolicy, merchantId, now),
    hasActivePolicy(client.prepaidIncentivePolicy, merchantId, now)
  ]);

  const suggestions: SellerGrowthSuggestion[] = [];

  if (!visibleTypes.has("RTO_NDR_RECOVERY")) {
    suggestions.push(serializeSystemSellerGrowthSuggestion({
      suggestionId: hasRecoveryPolicy
        ? "system:rto-ndr-recovery-review"
        : "system:rto-ndr-recovery-setup",
      title: hasRecoveryPolicy
        ? "Review failed-delivery recovery actions"
        : "Set up recovery actions for failed deliveries",
      description: hasRecoveryPolicy
        ? "Check open NDR and RTO cases and tune seller-controlled actions where delivery risk is rising."
        : "Add seller-controlled confirmation or retry-window actions before failed deliveries become final RTO cases.",
      type: "RTO_NDR_RECOVERY",
      ctaLabel: "Open recovery queue",
      ctaUrl: "/seller/ndr",
      priority: 30
    }));
  }

  if (!visibleTypes.has("PREPAID_INCENTIVE")) {
    suggestions.push(serializeSystemSellerGrowthSuggestion({
      suggestionId: hasPrepaidPolicy
        ? "system:cod-prepaid-review"
        : "system:cod-prepaid-setup",
      title: hasPrepaidPolicy
        ? "Review COD-to-prepaid controls"
        : "Create a prepaid option for COD orders",
      description: hasPrepaidPolicy
        ? "Keep active prepaid incentives aligned with shipment risk, order value bands, and seller appetite."
        : "Use a seller-controlled prepaid incentive to reduce COD exposure on shipments that need extra caution.",
      type: "PREPAID_INCENTIVE",
      ctaLabel: "Open shipping controls",
      ctaUrl: "/seller/shipping",
      priority: 40
    }));
  }

  if (!visibleTypes.has("PACKAGING_RECOMMENDATION")) {
    suggestions.push(serializeSystemSellerGrowthSuggestion({
      suggestionId: "system:packaging-weight-check",
      title: "Check weight and packaging exceptions",
      description: "Review shipments with weight mismatch or packaging risk before they affect delivery outcomes.",
      type: "PACKAGING_RECOMMENDATION",
      ctaLabel: "Open weight tools",
      ctaUrl: "/seller/weight-management",
      priority: 50
    }));
  }

  return suggestions;
}

export async function resolveSellerDashboardGrowthSuggestions(
  query: ResolveSellerGrowthSuggestionsQueryInput,
  client: SellerGrowthSuggestionsDb = defaultClient,
  now = new Date()
) {
  const offerSuggestions = await resolveOfferSuggestions(query, client, now);
  const systemSuggestions = await resolveSystemSuggestions(query, client, offerSuggestions, now);
  const suggestionsById = new Map<string, SellerGrowthSuggestion>();

  for (const suggestion of [...offerSuggestions, ...systemSuggestions].sort(sortSuggestions)) {
    if (!suggestionsById.has(suggestion.suggestionId)) {
      suggestionsById.set(suggestion.suggestionId, suggestion);
    }
  }

  return {
    surface: sellerDashboardGrowthSurface,
    suggestions: [...suggestionsById.values()].slice(0, query.max)
  };
}

export async function recordSellerGrowthSuggestionEvent(
  input: RecordSellerGrowthSuggestionEventInput,
  client: SellerGrowthSuggestionsDb = defaultClient
) {
  const suggestionId = cleanString(input.suggestionId);
  const offerId = cleanString(input.offerId);
  const metadata = {
    ...(input.metadata ?? {}),
    sellerDashboardSuggestionId: suggestionId,
    sellerDashboardEventType: input.eventType,
    source: "seller_dashboard_growth_suggestion"
  };

  if (offerId) {
    return recordGrowthEvent({
      offerId,
      merchantId: input.merchantId,
      sellerId: input.sellerId,
      shipmentId: input.shipmentId,
      orderId: input.orderId,
      eventType: input.eventType,
      surface: sellerDashboardGrowthSurface,
      idempotencyKey: input.idempotencyKey,
      metadata
    }, client);
  }

  return recordGrowthEvent({
    merchantId: input.merchantId,
    sellerId: input.sellerId,
    shipmentId: input.shipmentId,
    orderId: input.orderId,
    eventType: "VIEW",
    surface: sellerDashboardGrowthSurface,
    idempotencyKey: input.idempotencyKey,
    metadata
  }, client);
}
