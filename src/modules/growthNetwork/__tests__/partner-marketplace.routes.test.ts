import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";

import { errorHandler } from "../../../middleware/error.js";
import { createGrowthNetworkRouter } from "../growth-network.routes.js";

function makeClient() {
  const state = {
    offers: [{ id: "offer_1" }],
    partners: [] as any[],
    placements: [] as any[],
    leads: [] as any[],
    events: [] as any[],
    nextPartner: 1,
    nextPlacement: 1,
    nextLead: 1,
    nextEvent: 1,
    tick: 0
  };

  function nextDate() {
    state.tick += 1;
    return new Date(Date.parse("2026-06-13T09:00:00.000Z") + state.tick * 1000);
  }

  function matchesWhere(record: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "AND") return (condition as any[]).every((child) => matchesWhere(record, child));
      if (key === "OR") return (condition as any[]).some((child) => matchesWhere(record, child));
      if (key === "startsAt") {
        if (condition === null) return record.startsAt == null;
        if ((condition as any)?.lte) return record.startsAt == null || new Date(record.startsAt) <= new Date((condition as any).lte);
      }
      if (key === "endsAt") {
        if (condition === null) return record.endsAt == null;
        if ((condition as any)?.gte) return record.endsAt == null || new Date(record.endsAt) >= new Date((condition as any).gte);
      }
      return record[key] === condition;
    });
  }

  const client = {
    growthOffer: {
      create: async () => {
        throw new Error("UNUSED");
      },
      findMany: async () => [],
      findUnique: async ({ where }: any) => state.offers.find((offer) => offer.id === where.id) ?? null,
      update: async () => {
        throw new Error("UNUSED");
      },
      count: async () => state.offers.length
    },
    growthOfferPlacement: {
      create: async () => {
        throw new Error("UNUSED");
      }
    },
    growthOfferEvent: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("UNUSED");
      }
    },
    growthPartner: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const partner = {
          id: `partner_${state.nextPartner++}`,
          status: "DRAFT",
          description: null,
          websiteUrl: null,
          isSponsored: false,
          metadata: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.partners.push(partner);
        return partner;
      },
      findMany: async (input: any = {}) => {
        let partners = state.partners.filter((partner) => matchesWhere(partner, input.where));
        if (input.orderBy?.createdAt === "desc") {
          partners = partners.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
        }
        if (typeof input.skip === "number") partners = partners.slice(input.skip);
        if (typeof input.take === "number") partners = partners.slice(0, input.take);
        return partners;
      },
      findUnique: async ({ where }: any) => state.partners.find((partner) => partner.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const partner = state.partners.find((record) => record.id === where.id);
        if (!partner) throw new Error("PARTNER_NOT_FOUND");
        Object.assign(partner, data, { updatedAt: nextDate() });
        return partner;
      },
      count: async (input: any = {}) => state.partners.filter((partner) => matchesWhere(partner, input.where)).length
    },
    growthPartnerPlacement: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const placement = {
          id: `placement_${state.nextPlacement++}`,
          offerId: null,
          rulesJson: null,
          startsAt: null,
          endsAt: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.placements.push(placement);
        return placement;
      },
      findMany: async (input: any = {}) => state.placements
        .filter((placement) => matchesWhere(placement, input.where))
        .sort((left, right) => (
          left.priority - right.priority || new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
        ))
    },
    growthPartnerLead: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const lead = {
          id: `lead_${state.nextLead++}`,
          merchantId: null,
          sellerId: null,
          offerId: null,
          shipmentId: null,
          orderId: null,
          status: "CAPTURED",
          attributionRef: null,
          idempotencyKey: null,
          metadata: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.leads.push(lead);
        return lead;
      },
      findUnique: async ({ where }: any) => state.leads.find((lead) => (
        (where.id && lead.id === where.id) || (where.idempotencyKey && lead.idempotencyKey === where.idempotencyKey)
      )) ?? null,
      count: async (input: any = {}) => state.leads.filter((lead) => matchesWhere(lead, input.where)).length
    },
    growthPartnerAttributionEvent: {
      create: async ({ data }: any) => {
        const event = {
          id: `event_${state.nextEvent++}`,
          partnerId: null,
          offerId: null,
          leadId: null,
          merchantId: null,
          sellerId: null,
          attributionRef: null,
          sessionRef: null,
          idempotencyKey: null,
          metadata: null,
          createdAt: nextDate(),
          ...data
        };
        state.events.push(event);
        return event;
      },
      findUnique: async ({ where }: any) => state.events.find((event) => (
        where.idempotencyKey && event.idempotencyKey === where.idempotencyKey
      )) ?? null,
      findMany: async (input: any = {}) => state.events.filter((event) => matchesWhere(event, input.where)),
      count: async (input: any = {}) => state.events.filter((event) => matchesWhere(event, input.where)).length
    }
  };

  return { client, state };
}

async function makeApp(client: any) {
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

describe("partner marketplace routes", () => {
  const servers: Array<() => Promise<void>> = [];

  after(async () => {
    await Promise.all(servers.map((close) => close()));
  });

  it("creates, activates, places, resolves, captures, attributes, and summarizes partners", async () => {
    const { client } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const created = await request(app.baseUrl, "/growth-network/partners", {
      method: "POST",
      body: JSON.stringify({
        name: "demo_route_partner",
        display_name: "Demo Route Partner",
        category: "PACKAGING",
        is_sponsored: true,
        metadata: {
          publicTitle: "Route partner card",
          ctaUrl: "/seller/growth/partners/demo",
          buyerEmail: "buyer@example.com"
        }
      })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.partnerId, "partner_1");
    assert.equal("metadata" in created.body.data, false);

    const status = await request(app.baseUrl, "/growth-network/partners/partner_1/status", {
      method: "PATCH",
      body: JSON.stringify({ status: "ACTIVE" })
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.data.status, "ACTIVE");

    const placement = await request(app.baseUrl, "/growth-network/partners/partner_1/placements", {
      method: "POST",
      body: JSON.stringify({
        offer_id: "offer_1",
        surface: "TRACKING_PAGE",
        priority: 5,
        rules_json: { courierName: "Bigship" }
      })
    });
    assert.equal(placement.status, 201);
    assert.equal("rulesJson" in placement.body.data, false);

    const list = await request(app.baseUrl, "/growth-network/partners?status=ACTIVE");
    assert.equal(list.status, 200);
    assert.equal(list.body.data.partners.length, 1);

    const suggestions = await request(app.baseUrl, "/growth-network/partners/placements/TRACKING_PAGE/suggestions?max=3");
    assert.equal(suggestions.status, 200);
    assert.deepEqual(suggestions.body.data.suggestions, [{
      partnerId: "partner_1",
      offerId: "offer_1",
      displayName: "Demo Route Partner",
      category: "PACKAGING",
      title: "Route partner card",
      description: null,
      label: "Sponsored Partner",
      ctaLabel: "View partner",
      ctaUrl: "/seller/growth/partners/demo",
      surface: "TRACKING_PAGE",
      isSponsored: true
    }]);
    assert.equal(JSON.stringify(suggestions.body).includes("buyer@example.com"), false);
    assert.equal(JSON.stringify(suggestions.body).includes("Bigship"), false);

    const lead = await request(app.baseUrl, "/growth-network/partners/leads", {
      method: "POST",
      body: JSON.stringify({
        partner_id: "partner_1",
        merchant_id: "merchant_1",
        seller_id: "seller_1",
        offer_id: "offer_1",
        source_surface: "TRACKING_PAGE",
        attribution_ref: "attr_route",
        idempotency_key: "lead-route-1"
      })
    });
    assert.equal(lead.status, 201);
    assert.equal(lead.body.data.leadId, "lead_1");

    const impression = await request(app.baseUrl, "/growth-network/partners/attribution-events", {
      method: "POST",
      body: JSON.stringify({
        partner_id: "partner_1",
        event_type: "IMPRESSION",
        surface: "TRACKING_PAGE",
        attribution_ref: "attr_route"
      })
    });
    assert.equal(impression.status, 201, JSON.stringify(impression.body));

    const click = await request(app.baseUrl, "/growth-network/partners/attribution-events", {
      method: "POST",
      body: JSON.stringify({
        partner_id: "partner_1",
        event_type: "CLICK",
        surface: "TRACKING_PAGE",
        attribution_ref: "attr_route"
      })
    });
    assert.equal(click.status, 201, JSON.stringify(click.body));

    const conversion = await request(app.baseUrl, "/growth-network/partners/attribution-events", {
      method: "POST",
      body: JSON.stringify({
        lead_id: "lead_1",
        event_type: "CONVERSION_SIMULATED",
        surface: "TRACKING_PAGE",
        metadata: { simulatedRevenuePaise: 45000 }
      })
    });
    assert.equal(conversion.status, 201, JSON.stringify(conversion.body));

    const summary = await request(app.baseUrl, "/growth-network/partners/partner_1/performance-summary");
    assert.equal(summary.status, 200);
    assert.equal(summary.body.data.impressions, 1);
    assert.equal(summary.body.data.clicks, 1);
    assert.equal(summary.body.data.leadsCaptured, 1);
    assert.equal(summary.body.data.simulatedConversions, 1);
    assert.equal(summary.body.data.simulatedRevenuePaise, 45000);
    assert.equal(summary.body.data.adSpendPaise, null);
    assert.equal(summary.body.data.roas, null);
  });

  it("rejects attribution events without a partner, offer, or lead reference", async () => {
    const { client } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const response = await request(app.baseUrl, "/growth-network/partners/attribution-events", {
      method: "POST",
      body: JSON.stringify({
        event_type: "CLICK",
        surface: "TRACKING_PAGE"
      })
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, "VALIDATION_ERROR");
  });
});
