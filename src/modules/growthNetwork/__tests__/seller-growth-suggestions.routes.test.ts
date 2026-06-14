import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";

import { errorHandler } from "../../../middleware/error.js";
import { createGrowthNetworkRouter } from "../growth-network.routes.js";
import type { SellerGrowthSuggestionsDb } from "../seller-growth-suggestions.service.js";

function makeClient() {
  const state = {
    offers: [] as any[],
    placements: [] as any[],
    events: [] as any[],
    nextEvent: 1
  };

  state.offers.push({
    id: "offer_dashboard",
    merchantId: "merchant_1",
    title: "Review seller dashboard shipment controls",
    subtitle: null,
    description: "Use seller-owned controls for shipment outcomes.",
    type: "STORE_GROWTH_TOOL",
    status: "ACTIVE",
    isSponsored: false,
    sponsorName: null,
    ctaLabel: "Review",
    ctaUrl: "/seller/shipping",
    metadata: { buyerPhone: "9999999999" },
    startsAt: null,
    endsAt: null,
    createdAt: new Date("2026-06-13T09:00:00.000Z"),
    updatedAt: new Date("2026-06-13T09:00:00.000Z")
  });
  state.placements.push({
    id: "placement_dashboard",
    offerId: "offer_dashboard",
    surface: "SELLER_DASHBOARD",
    priority: 8,
    rulesJson: { hidden: true },
    createdAt: new Date("2026-06-13T09:01:00.000Z"),
    updatedAt: new Date("2026-06-13T09:01:00.000Z")
  });

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

  const client: SellerGrowthSuggestionsDb = {
    growthOffer: {
      create: async () => state.offers[0] as any,
      findMany: async (input: any = {}) => {
        let offers = state.offers.filter((offer) => matchesWhere(offer, input.where));
        if (input.include?.placements) {
          const surface = input.include.placements.where?.surface;
          offers = offers.map((offer) => ({
            ...offer,
            placements: state.placements.filter((placement) => (
              placement.offerId === offer.id && (!surface || placement.surface === surface)
            ))
          }));
        }
        return offers;
      },
      findUnique: async ({ where }) => state.offers.find((offer) => offer.id === where.id) ?? null,
      update: async () => state.offers[0] as any,
      count: async () => state.offers.length
    },
    growthOfferPlacement: {
      create: async () => state.placements[0] as any
    },
    growthOfferEvent: {
      findUnique: async ({ where }) => state.events.find((event) => event.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }) => {
        const event = {
          id: `event_${state.nextEvent++}`,
          createdAt: new Date("2026-06-13T09:02:00.000Z"),
          ...data
        };
        state.events.push(event);
        return event as any;
      }
    },
    prepaidIncentivePolicy: {
      count: async () => 0
    },
    rtoNdrRecoveryPolicy: {
      count: async () => 0
    }
  };

  return { client, state };
}

async function makeApp(client: SellerGrowthSuggestionsDb) {
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

describe("seller growth suggestions routes", () => {
  const servers: Array<() => Promise<void>> = [];

  after(async () => {
    await Promise.all(servers.map((close) => close()));
  });

  it("resolves seller dashboard suggestions through the growth-network router", async () => {
    const { client } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const response = await request(app.baseUrl, "/growth-network/seller-dashboard/suggestions?merchant_id=merchant_1&max=3");

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.surface, "SELLER_DASHBOARD");
    assert.equal(response.body.data.suggestions[0].offerId, "offer_dashboard");
    assert.equal("metadata" in response.body.data.suggestions[0], false);
    assert.equal("rulesJson" in response.body.data.suggestions[0], false);
  });

  it("records offer and system suggestion events with the safe endpoint", async () => {
    const { client, state } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const click = await request(app.baseUrl, "/growth-network/seller-dashboard/suggestions/events", {
      method: "POST",
      body: JSON.stringify({
        suggestion_id: "offer:offer_dashboard",
        offer_id: "offer_dashboard",
        merchant_id: "merchant_1",
        event_type: "CLICK"
      })
    });
    assert.equal(click.status, 201);
    assert.equal(click.body.data.eventType, "CLICK");
    assert.equal(click.body.data.offerId, "offer_dashboard");

    const dismiss = await request(app.baseUrl, "/growth-network/seller-dashboard/suggestions/events", {
      method: "POST",
      body: JSON.stringify({
        suggestionId: "system:rto-ndr-recovery-setup",
        merchantId: "merchant_1",
        eventType: "DISMISS",
        metadata: { courierName: "hidden-carrier", safe: true }
      })
    });
    assert.equal(dismiss.status, 201);
    assert.equal(dismiss.body.data.eventType, "VIEW");
    assert.equal(dismiss.body.data.offerId, null);
    assert.equal(state.events[1]?.metadata.sellerDashboardEventType, "DISMISS");
    assert.equal("courierName" in state.events[1]?.metadata, false);
  });

  it("rejects malformed seller dashboard events", async () => {
    const { client } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const response = await request(app.baseUrl, "/growth-network/seller-dashboard/suggestions/events", {
      method: "POST",
      body: JSON.stringify({
        eventType: "CLICK"
      })
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "VALIDATION_ERROR");
  });
});
