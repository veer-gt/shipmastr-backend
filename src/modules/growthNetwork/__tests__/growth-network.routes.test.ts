import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";

import { errorHandler } from "../../../middleware/error.js";
import { createGrowthNetworkRouter } from "../growth-network.routes.js";
import type { GrowthNetworkDb } from "../growth-network.service.js";

function makeClient() {
  const state = {
    offers: [] as any[],
    placements: [] as any[],
    events: [] as any[],
    nextOffer: 1,
    nextPlacement: 1,
    nextEvent: 1
  };

  const client: GrowthNetworkDb = {
    growthOffer: {
      create: async ({ data }) => {
        const createdAt = new Date(`2026-06-13T09:00:0${state.nextOffer}.000Z`);
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
        let offers = [...state.offers];
        if (input.where?.status) offers = offers.filter((offer) => offer.status === input.where.status);
        if (input.where?.placements?.some?.surface) {
          offers = offers.filter((offer) => state.placements.some((placement) => (
            placement.offerId === offer.id && placement.surface === input.where.placements.some.surface
          )));
        }
        if (input.where?.AND) {
          offers = offers.filter((offer) => input.where.AND.every((condition: any) => {
            if (condition.merchantId === null) return offer.merchantId === null;
            if (condition.OR) {
              return condition.OR.some((child: any) => {
                if (child.merchantId === null) return offer.merchantId === null;
                if (child.merchantId) return offer.merchantId === child.merchantId;
                if (child.startsAt === null) return offer.startsAt == null;
                if (child.startsAt?.lte) return offer.startsAt == null || new Date(offer.startsAt) <= new Date(child.startsAt.lte);
                if (child.endsAt === null) return offer.endsAt == null;
                if (child.endsAt?.gte) return offer.endsAt == null || new Date(offer.endsAt) >= new Date(child.endsAt.gte);
                return true;
              });
            }
            return true;
          }));
        }
        if (input.include?.placements) {
          const surface = input.include.placements.where?.surface;
          offers = offers.map((offer) => ({
            ...offer,
            placements: state.placements
              .filter((placement) => placement.offerId === offer.id && (!surface || placement.surface === surface))
              .sort((a, b) => a.priority - b.priority)
          }));
        }
        return offers;
      },
      findUnique: async ({ where }) => state.offers.find((offer) => offer.id === where.id) ?? null,
      update: async ({ where, data }) => {
        const offer = state.offers.find((record) => record.id === where.id);
        if (!offer) throw new Error("OFFER_NOT_FOUND");
        Object.assign(offer, data, { updatedAt: new Date("2026-06-13T09:10:00.000Z") });
        return offer;
      },
      count: async () => state.offers.length
    },
    growthOfferPlacement: {
      create: async ({ data }) => {
        const placement = {
          id: `placement_${state.nextPlacement++}`,
          rulesJson: null,
          createdAt: new Date("2026-06-13T09:05:00.000Z"),
          updatedAt: new Date("2026-06-13T09:05:00.000Z"),
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
          createdAt: new Date("2026-06-13T09:06:00.000Z"),
          ...data
        };
        state.events.push(event);
        return event as any;
      }
    }
  };

  return { client, state };
}

async function makeApp(client: GrowthNetworkDb) {
  const app = express();
  app.use(express.json());
  app.use("/growth-network", createGrowthNetworkRouter({ client }));
  app.use(errorHandler);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

async function request(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

describe("growth network routes", () => {
  const servers: Array<() => Promise<void>> = [];

  after(async () => {
    await Promise.all(servers.map((close) => close()));
  });

  it("creates, activates, places, lists, and resolves public cards", async () => {
    const { client } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const created = await request(app.baseUrl, "/growth-network/offers", {
      method: "POST",
      body: JSON.stringify({
        merchantId: "merchant_1",
        title: "Offer prepaid discount before dispatch",
        type: "PREPAID_INCENTIVE",
        ctaLabel: "Choose prepaid"
      })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.success, true);
    assert.equal(created.body.data.offerId, "offer_1");

    const status = await request(app.baseUrl, "/growth-network/offers/offer_1/status", {
      method: "PATCH",
      body: JSON.stringify({ status: "ACTIVE" })
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.data.status, "ACTIVE");

    const placement = await request(app.baseUrl, "/growth-network/offers/offer_1/placements", {
      method: "POST",
      body: JSON.stringify({
        surface: "TRACKING_PAGE",
        priority: 5,
        rulesJson: { hiddenProvider: "Bigship" }
      })
    });
    assert.equal(placement.status, 201);
    assert.equal("rulesJson" in placement.body.data, false);

    const list = await request(app.baseUrl, "/growth-network/offers");
    assert.equal(list.status, 200);
    assert.equal(list.body.data.offers.length, 1);

    const resolved = await request(app.baseUrl, "/growth-network/placements/TRACKING_PAGE/offers?merchant_id=merchant_1");
    assert.equal(resolved.status, 200);
    assert.deepEqual(resolved.body.data.offers, [{
      offerId: "offer_1",
      title: "Offer prepaid discount before dispatch",
      subtitle: null,
      description: null,
      type: "PREPAID_INCENTIVE",
      label: "Merchant Offer",
      ctaLabel: "Choose prepaid",
      ctaUrl: null,
      isSponsored: false,
      surface: "TRACKING_PAGE"
    }]);
  });

  it("records tracking page views and rejects offer-level events without offerId", async () => {
    const { client } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const view = await request(app.baseUrl, "/growth-network/tracking-page/view", {
      method: "POST",
      body: JSON.stringify({
        merchantId: "merchant_1",
        sessionRef: "session_1"
      })
    });
    assert.equal(view.status, 201);
    assert.equal(view.body.data.eventType, "VIEW");
    assert.equal(view.body.data.offerId, null);

    const invalidClick = await request(app.baseUrl, "/growth-network/events", {
      method: "POST",
      body: JSON.stringify({
        eventType: "CLICK",
        surface: "TRACKING_PAGE"
      })
    });
    assert.equal(invalidClick.status, 400);
    assert.equal(invalidClick.body.error, "VALIDATION_ERROR");
  });
});
