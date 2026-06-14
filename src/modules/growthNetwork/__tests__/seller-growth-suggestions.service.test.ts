import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  recordSellerGrowthSuggestionEvent,
  resolveSellerDashboardGrowthSuggestions,
  type SellerGrowthSuggestionsDb
} from "../seller-growth-suggestions.service.js";

const now = new Date("2026-06-13T10:00:00.000Z");

function makeClient() {
  const state = {
    offers: [] as any[],
    placements: [] as any[],
    events: [] as any[],
    prepaidPolicies: [] as any[],
    rtoPolicies: [] as any[],
    nextOffer: 1,
    nextPlacement: 1,
    nextEvent: 1,
    tick: 0
  };

  function nextDate() {
    state.tick += 1;
    return new Date(now.getTime() + state.tick * 1000);
  }

  function matchesDate(value: Date | string | null | undefined, condition: any) {
    if (condition === null) return value == null;
    if (condition?.lte) return value != null && new Date(value).getTime() <= new Date(condition.lte).getTime();
    if (condition?.gte) return value != null && new Date(value).getTime() >= new Date(condition.gte).getTime();
    return true;
  }

  function matchesWhere(record: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "AND") return (condition as any[]).every((child) => matchesWhere(record, child));
      if (key === "OR") return (condition as any[]).some((child) => matchesWhere(record, child));
      if (key === "startsAt" || key === "endsAt") return matchesDate(record[key], condition);
      if (key === "placements") {
        const surface = (condition as any)?.some?.surface;
        return state.placements.some((placement) => (
          placement.offerId === record.id && (!surface || placement.surface === surface)
        ));
      }
      return record[key] === condition;
    });
  }

  function addOffer(overrides: Record<string, unknown>, placement: Record<string, unknown> | null = {}) {
    const createdAt = nextDate();
    const offer = {
      id: `offer_${state.nextOffer++}`,
      merchantId: null,
      title: "Review shipment outcome settings",
      subtitle: null,
      description: "Review seller-controlled settings.",
      type: "STORE_GROWTH_TOOL",
      status: "ACTIVE",
      isSponsored: false,
      sponsorName: null,
      ctaLabel: "Review",
      ctaUrl: "/seller/shipping",
      metadata: null,
      startsAt: null,
      endsAt: null,
      createdAt,
      updatedAt: createdAt,
      ...overrides
    };
    state.offers.push(offer);

    if (placement) {
      const placementCreatedAt = nextDate();
      state.placements.push({
        id: `placement_${state.nextPlacement++}`,
        offerId: offer.id,
        surface: "SELLER_DASHBOARD",
        priority: 20,
        rulesJson: null,
        createdAt: placementCreatedAt,
        updatedAt: placementCreatedAt,
        ...placement
      });
    }

    return offer;
  }

  const client: SellerGrowthSuggestionsDb = {
    growthOffer: {
      create: async ({ data }) => {
        const offer = addOffer(data, null);
        return offer as any;
      },
      findMany: async (input: any = {}) => {
        let offers = state.offers.filter((offer) => matchesWhere(offer, input.where));
        if (input.include?.placements) {
          const surface = input.include.placements.where?.surface;
          offers = offers.map((offer) => ({
            ...offer,
            placements: state.placements
              .filter((placement) => placement.offerId === offer.id && (!surface || placement.surface === surface))
              .sort((left, right) => left.priority - right.priority)
          }));
        }
        return offers;
      },
      findUnique: async ({ where }) => state.offers.find((offer) => offer.id === where.id) ?? null,
      update: async ({ where, data }) => {
        const offer = state.offers.find((record) => record.id === where.id);
        if (!offer) throw new Error("OFFER_NOT_FOUND");
        Object.assign(offer, data, { updatedAt: nextDate() });
        return offer as any;
      },
      count: async (input: any = {}) => state.offers.filter((offer) => matchesWhere(offer, input.where)).length
    },
    growthOfferPlacement: {
      create: async ({ data }) => {
        const createdAt = nextDate();
        const placement = {
          id: `placement_${state.nextPlacement++}`,
          rulesJson: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.placements.push(placement);
        return placement as any;
      }
    },
    growthOfferEvent: {
      findUnique: async ({ where }) => state.events.find((event) => event.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }) => {
        const event = {
          id: `event_${state.nextEvent++}`,
          createdAt: nextDate(),
          ...data
        };
        state.events.push(event);
        return event as any;
      }
    },
    prepaidIncentivePolicy: {
      count: async (input: any = {}) => state.prepaidPolicies.filter((policy) => matchesWhere(policy, input.where)).length
    },
    rtoNdrRecoveryPolicy: {
      count: async (input: any = {}) => state.rtoPolicies.filter((policy) => matchesWhere(policy, input.where)).length
    }
  };

  return { client, state, addOffer };
}

describe("seller growth suggestions service", () => {
  it("resolves active seller-dashboard offers with bounded public-safe system suggestions", async () => {
    const { client, addOffer } = makeClient();
    addOffer({
      merchantId: "merchant_1",
      title: "Tune shipment checks",
      description: "Review carrier-specific metadata before exposing anything.",
      metadata: { buyerPhone: "9999999999", rules: true }
    }, {
      priority: 5,
      rulesJson: { provider: "hidden" }
    });
    addOffer({ merchantId: "merchant_1", title: "Paused card", status: "PAUSED" }, { priority: 1 });
    addOffer({ merchantId: "merchant_1", title: "Expired card", endsAt: new Date("2026-06-12T09:00:00.000Z") }, { priority: 1 });
    addOffer({ merchantId: "merchant_1", title: "Tracking card" }, { surface: "TRACKING_PAGE", priority: 1 });

    const result = await resolveSellerDashboardGrowthSuggestions({
      merchantId: "merchant_1",
      max: 3
    }, client, now);

    assert.equal(result.surface, "SELLER_DASHBOARD");
    assert.equal(result.suggestions.length, 3);
    assert.equal(result.suggestions[0]?.offerId, "offer_1");
    assert.equal(result.suggestions[0]?.title, "Tune shipment checks");
    assert.equal("metadata" in result.suggestions[0]!, false);
    assert.equal("rulesJson" in result.suggestions[0]!, false);
    assert.ok(result.suggestions.some((suggestion) => suggestion.suggestionId === "system:rto-ndr-recovery-setup"));
    assert.ok(result.suggestions.some((suggestion) => suggestion.suggestionId === "system:cod-prepaid-setup"));
  });

  it("keeps sponsor names scoped to sponsored offer cards", async () => {
    const { client, addOffer } = makeClient();
    addOffer({
      merchantId: null,
      title: "Unsponsored dashboard card",
      sponsorName: "Hidden Sponsor"
    }, { priority: 10 });
    addOffer({
      merchantId: null,
      title: "Sponsored dashboard card",
      isSponsored: true,
      sponsorName: "Fulfillment Studio"
    }, { priority: 20 });

    const result = await resolveSellerDashboardGrowthSuggestions({ max: 3 }, client, now);
    const [plain, sponsored] = result.suggestions;

    assert.equal(plain?.isSponsored, false);
    assert.equal("sponsorName" in plain!, false);
    assert.equal(sponsored?.isSponsored, true);
    assert.equal(sponsored?.sponsorName, "Fulfillment Studio");
  });

  it("records offer events and system-suggestion events without real provider calls", async () => {
    const { client, state, addOffer } = makeClient();
    const offer = addOffer({
      merchantId: "merchant_1",
      title: "Offer-level suggestion"
    }, { priority: 10 });

    const clicked = await recordSellerGrowthSuggestionEvent({
      suggestionId: `offer:${offer.id}`,
      offerId: offer.id,
      merchantId: "merchant_1",
      sellerId: "seller_1",
      eventType: "CLICK",
      metadata: { buyerPhone: "9999999999", safe: true }
    }, client);

    assert.equal(clicked.eventType, "CLICK");
    assert.equal(clicked.offerId, offer.id);
    assert.equal(state.events[0]?.metadata.safe, true);
    assert.equal("buyerPhone" in state.events[0]?.metadata, false);

    const dismissed = await recordSellerGrowthSuggestionEvent({
      suggestionId: "system:packaging-weight-check",
      merchantId: "merchant_1",
      sellerId: "seller_1",
      eventType: "DISMISS",
      metadata: { providerName: "hidden-provider", safe: "dashboard" }
    }, client);

    assert.equal(dismissed.offerId, null);
    assert.equal(dismissed.eventType, "VIEW");
    assert.equal(state.events[1]?.metadata.sellerDashboardEventType, "DISMISS");
    assert.equal(state.events[1]?.metadata.sellerDashboardSuggestionId, "system:packaging-weight-check");
    assert.equal("providerName" in state.events[1]?.metadata, false);
    assert.equal(state.events[1]?.surface, "SELLER_DASHBOARD");
  });
});
