import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addGrowthOfferPlacement,
  createGrowthOffer,
  listGrowthOffers,
  recordGrowthEvent,
  recordTrackingPageView,
  resolvePublicGrowthOffersForSurface,
  updateGrowthOfferStatus,
  type GrowthNetworkDb
} from "../growth-network.service.js";

const now = new Date("2026-06-13T09:00:00.000Z");

function makeGrowthNetworkClient() {
  const state = {
    offers: [] as any[],
    placements: [] as any[],
    events: [] as any[],
    nextOffer: 1,
    nextPlacement: 1,
    nextEvent: 1,
    tick: 0
  };

  function nextDate() {
    state.tick += 1;
    return new Date(now.getTime() + state.tick * 1000);
  }

  function matchesDate(value: Date | null | undefined, condition: any) {
    if (condition === null) return value == null;
    if (condition?.lte) return value != null && new Date(value).getTime() <= new Date(condition.lte).getTime();
    if (condition?.gte) return value != null && new Date(value).getTime() >= new Date(condition.gte).getTime();
    return true;
  }

  function matchesWhere(offer: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "AND") return (condition as any[]).every((child) => matchesWhere(offer, child));
      if (key === "OR") return (condition as any[]).some((child) => matchesWhere(offer, child));
      if (key === "placements") {
        const surface = (condition as any).some?.surface;
        return state.placements.some((placement) => placement.offerId === offer.id && (!surface || placement.surface === surface));
      }
      if (key === "startsAt" || key === "endsAt") return matchesDate(offer[key], condition);
      return offer[key] === condition;
    });
  }

  const client: GrowthNetworkDb = {
    growthOffer: {
      create: async ({ data }) => {
        const createdAt = nextDate();
        const offer = {
          id: `offer_${state.nextOffer++}`,
          merchantId: null,
          subtitle: null,
          description: null,
          status: "DRAFT",
          isSponsored: false,
          sponsorName: null,
          ctaUrl: null,
          metadata: null,
          startsAt: null,
          endsAt: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.offers.push(offer);
        return offer as any;
      },
      findMany: async (input: any = {}) => {
        let records = state.offers.filter((offer) => matchesWhere(offer, input.where));
        if (input.orderBy?.createdAt === "desc") {
          records = [...records].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        }
        if (typeof input.skip === "number") records = records.slice(input.skip);
        if (typeof input.take === "number") records = records.slice(0, input.take);
        if (input.include?.placements) {
          const placementWhere = input.include.placements.where ?? {};
          records = records.map((offer) => ({
            ...offer,
            placements: state.placements
              .filter((placement) => placement.offerId === offer.id)
              .filter((placement) => !placementWhere.surface || placement.surface === placementWhere.surface)
              .sort((a, b) => a.priority - b.priority || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          }));
        }
        return records;
      },
      findUnique: async ({ where }) => state.offers.find((offer) => offer.id === where.id) ?? null,
      update: async ({ where, data }) => {
        const offer = state.offers.find((record) => record.id === where.id);
        if (!offer) throw new Error("OFFER_NOT_FOUND");
        Object.assign(offer, data, { updatedAt: nextDate() });
        return offer;
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
        if (data.idempotencyKey && state.events.some((event) => event.idempotencyKey === data.idempotencyKey)) {
          throw { code: "P2002" };
        }
        const event = {
          id: `event_${state.nextEvent++}`,
          createdAt: nextDate(),
          ...data
        };
        state.events.push(event);
        return event as any;
      }
    }
  };

  return { client, state };
}

async function createActiveOffer(
  client: GrowthNetworkDb,
  input: Partial<Parameters<typeof createGrowthOffer>[0]> = {},
  placement: Partial<Parameters<typeof addGrowthOfferPlacement>[1]> = {}
) {
  const offer = await createGrowthOffer({
    title: input.title ?? "Offer",
    type: input.type ?? "MERCHANT_REORDER",
    ctaLabel: input.ctaLabel ?? "View",
    status: input.status ?? "ACTIVE",
    merchantId: input.merchantId,
    subtitle: input.subtitle,
    description: input.description,
    isSponsored: input.isSponsored ?? false,
    sponsorName: input.sponsorName,
    ctaUrl: input.ctaUrl,
    metadata: input.metadata,
    startsAt: input.startsAt,
    endsAt: input.endsAt
  }, client);

  await addGrowthOfferPlacement(offer.offerId, {
    surface: placement.surface ?? "TRACKING_PAGE",
    priority: placement.priority ?? 100,
    rulesJson: placement.rulesJson
  }, client);

  return offer;
}

describe("growth network service", () => {
  it("creates, lists, transitions status, and creates placements without leaking raw fields", async () => {
    const { client } = makeGrowthNetworkClient();
    const offer = await createGrowthOffer({
      merchantId: "merchant_1",
      title: "Invite buyer to reorder after delivery",
      type: "MERCHANT_REORDER",
      ctaLabel: "Reorder",
      status: "DRAFT",
      isSponsored: false,
      metadata: { buyerEmail: "buyer@example.com", safe: true }
    }, client);

    assert.equal(offer.offerId, "offer_1");
    assert.equal(offer.status, "DRAFT");
    assert.equal("metadata" in offer, false);

    const list = await listGrowthOffers({ page: 1, perPage: 50 }, client);
    assert.equal(list.pagination.total, 1);
    assert.equal(list.offers[0]?.offerId, offer.offerId);

    const active = await updateGrowthOfferStatus(offer.offerId, { status: "ACTIVE" }, client);
    assert.equal(active.status, "ACTIVE");

    const placement = await addGrowthOfferPlacement(offer.offerId, {
      surface: "TRACKING_PAGE",
      priority: 25,
      rulesJson: { courierName: "Bigship" }
    }, client);
    assert.equal(placement.priority, 25);
    assert.equal("rulesJson" in placement, false);
  });

  it("resolves eligible TRACKING_PAGE offers with status, date, merchant scope, priority, and default max rules", async () => {
    const { client } = makeGrowthNetworkClient();
    await createActiveOffer(client, { title: "Merchant reorder", merchantId: "merchant_1" }, { priority: 10 });
    await createActiveOffer(client, { title: "Platform prepaid", type: "PREPAID_INCENTIVE" }, { priority: 20 });
    await createActiveOffer(client, {
      title: "Demo sponsor",
      type: "PARTNER_SPONSORED",
      isSponsored: true,
      sponsorName: "Demo Sponsored Partner"
    }, { priority: 30 });
    await createActiveOffer(client, { title: "Fourth eligible" }, { priority: 40 });
    await createActiveOffer(client, { title: "Paused", status: "PAUSED" }, { priority: 1 });
    await createActiveOffer(client, { title: "Draft", status: "DRAFT" }, { priority: 1 });
    await createActiveOffer(client, { title: "Archived", status: "ARCHIVED" }, { priority: 1 });
    await createActiveOffer(client, { title: "Expired", endsAt: new Date("2026-06-12T00:00:00.000Z") }, { priority: 1 });
    await createActiveOffer(client, { title: "Future", startsAt: new Date("2026-06-14T00:00:00.000Z") }, { priority: 1 });
    await createActiveOffer(client, { title: "Checkout only" }, { surface: "CHECKOUT", priority: 1 });
    await createActiveOffer(client, { title: "Other merchant", merchantId: "merchant_2" }, { priority: 1 });

    const resolved = await resolvePublicGrowthOffersForSurface("TRACKING_PAGE", {
      merchantId: "merchant_1",
      max: 3
    }, client, now);

    assert.deepEqual(resolved.offers.map((offer) => offer.title), [
      "Merchant reorder",
      "Platform prepaid",
      "Demo sponsor"
    ]);
    assert.deepEqual(resolved.offers.map((offer) => offer.label), [
      "Merchant Offer",
      "Recommended",
      "Sponsored Partner"
    ]);
    assert.equal(resolved.offers.length, 3);
    assert.equal(resolved.offers.some((offer) => offer.title === "Other merchant"), false);
  });

  it("sorts same-priority offers by newest createdAt before older offers", async () => {
    const { client } = makeGrowthNetworkClient();
    await createActiveOffer(client, { title: "Older" }, { priority: 10 });
    await createActiveOffer(client, { title: "Newer" }, { priority: 10 });

    const resolved = await resolvePublicGrowthOffersForSurface("TRACKING_PAGE", { max: 10 }, client, now);
    assert.deepEqual(resolved.offers.map((offer) => offer.title), ["Newer", "Older"]);
  });

  it("returns only public-safe offer card fields", async () => {
    const { client } = makeGrowthNetworkClient();
    await createActiveOffer(client, {
      title: "Shiprocket reorder push",
      merchantId: "merchant_1",
      metadata: {
        courierName: "Bigship",
        buyerEmail: "buyer@example.com",
        safeMetric: "kept"
      }
    }, { priority: 1, rulesJson: { providerName: "Shipmozo" } });
    await createActiveOffer(client, {
      title: "Sponsored packaging",
      type: "PARTNER_SPONSORED",
      isSponsored: true,
      sponsorName: "Demo Sponsored Partner"
    }, { priority: 2 });

    const resolved = await resolvePublicGrowthOffersForSurface("TRACKING_PAGE", {
      merchantId: "merchant_1",
      max: 10
    }, client, now);
    const merchantCard = resolved.offers[0]!;
    const sponsoredCard = resolved.offers[1]!;
    const json = JSON.stringify(resolved);

    assert.equal(merchantCard.label, "Merchant Offer");
    assert.equal(Object.prototype.hasOwnProperty.call(merchantCard, "sponsorName"), false);
    assert.equal(sponsoredCard.label, "Sponsored Partner");
    assert.equal(sponsoredCard.sponsorName, "Demo Sponsored Partner");
    assert.equal(json.includes("metadata"), false);
    assert.equal(json.includes("rulesJson"), false);
    assert.equal(json.includes("buyer@example.com"), false);
    assert.equal(json.includes("Bigship"), false);
    assert.equal(json.includes("Shipmozo"), false);
    assert.equal(json.includes("Shiprocket"), false);
  });

  it("enforces conditional offerId validation and records useful events", async () => {
    const { client } = makeGrowthNetworkClient();
    const offer = await createActiveOffer(client);

    const view = await recordTrackingPageView({
      merchantId: "merchant_1",
      sessionRef: "session_1"
    }, client);
    assert.equal(view.eventType, "VIEW");
    assert.equal(view.offerId, null);

    const viewWithOffer = await recordGrowthEvent({
      eventType: "VIEW",
      surface: "TRACKING_PAGE",
      offerId: offer.offerId
    }, client);
    assert.equal(viewWithOffer.offerId, offer.offerId);

    for (const eventType of ["IMPRESSION", "CLICK", "DISMISS", "CONVERSION"] as const) {
      await assert.rejects(
        () => recordGrowthEvent({ eventType, surface: "TRACKING_PAGE" }, client),
        /GROWTH_OFFER_ID_REQUIRED_FOR_EVENT/
      );

      const event = await recordGrowthEvent({
        eventType,
        surface: "TRACKING_PAGE",
        offerId: offer.offerId
      }, client);
      assert.equal(event.eventType, eventType);
      assert.equal(event.offerId, offer.offerId);
    }
  });

  it("uses idempotencyKey to prevent duplicate event inflation", async () => {
    const { client, state } = makeGrowthNetworkClient();
    const offer = await createActiveOffer(client);

    const first = await recordGrowthEvent({
      eventType: "CLICK",
      surface: "TRACKING_PAGE",
      offerId: offer.offerId,
      idempotencyKey: "click-1"
    }, client);
    const second = await recordGrowthEvent({
      eventType: "CLICK",
      surface: "TRACKING_PAGE",
      offerId: offer.offerId,
      idempotencyKey: "click-1"
    }, client);

    assert.equal(first.eventId, second.eventId);
    assert.equal(second.duplicate, true);
    assert.equal(state.events.filter((event) => event.idempotencyKey === "click-1").length, 1);
  });
});
