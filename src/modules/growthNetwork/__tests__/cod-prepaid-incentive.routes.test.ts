import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import express from "express";

import { errorHandler } from "../../../middleware/error.js";
import { createGrowthNetworkRouter } from "../growth-network.routes.js";
import type { CodPrepaidIncentiveDb } from "../cod-prepaid-incentive.service.js";

function makeClient() {
  const state = {
    policies: [] as any[],
    intents: [] as any[],
    offers: [] as any[],
    placements: [] as any[],
    events: [] as any[],
    nextPolicy: 1,
    nextIntent: 1,
    nextOffer: 1,
    nextPlacement: 1,
    nextEvent: 1
  };

  function now() {
    return new Date("2026-06-13T10:00:00.000Z");
  }

  function matchesPolicy(policy: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "AND") return (condition as any[]).every((child: any) => matchesPolicy(policy, child));
      if (key === "OR") return (condition as any[]).some((child: any) => matchesPolicy(policy, child));
      if (key === "startsAt") return condition === null || policy.startsAt == null || new Date(policy.startsAt) <= new Date((condition as any).lte);
      if (key === "endsAt") return condition === null || policy.endsAt == null || new Date(policy.endsAt) >= new Date((condition as any).gte);
      return policy[key] === condition;
    });
  }

  const client: CodPrepaidIncentiveDb = {
    prepaidIncentivePolicy: {
      create: async ({ data }) => {
        const policy = {
          id: `policy_${state.nextPolicy++}`,
          description: null,
          status: "DRAFT",
          discountAmountPaise: null,
          discountPercent: null,
          maxDiscountAmountPaise: null,
          minOrderAmountPaise: null,
          maxOrderAmountPaise: null,
          startsAt: null,
          endsAt: null,
          metadata: null,
          createdAt: now(),
          updatedAt: now(),
          ...data
        };
        state.policies.push(policy);
        return policy as any;
      },
      findMany: async (input: any = {}) => {
        let policies = state.policies.filter((policy) => matchesPolicy(policy, input.where));
        if (input.orderBy?.createdAt === "desc") policies = [...policies].reverse();
        return policies;
      },
      findUnique: async ({ where }) => state.policies.find((policy) => policy.id === where.id) ?? null,
      update: async ({ where, data }) => {
        const policy = state.policies.find((record) => record.id === where.id);
        if (!policy) throw new Error("POLICY_NOT_FOUND");
        Object.assign(policy, data, { updatedAt: now() });
        return policy as any;
      },
      count: async (input: any = {}) => state.policies.filter((policy) => matchesPolicy(policy, input.where)).length
    },
    prepaidConversionIntent: {
      create: async ({ data }) => {
        const intent = {
          id: `intent_${state.nextIntent++}`,
          status: "INTENT_CREATED",
          targetPaymentMode: "PREPAID",
          createdAt: now(),
          updatedAt: now(),
          ...data
        };
        state.intents.push(intent);
        return intent as any;
      },
      findUnique: async ({ where }) => {
        if (where.id) return state.intents.find((intent) => intent.id === where.id) ?? null;
        return state.intents.find((intent) => intent.idempotencyKey === where.idempotencyKey) ?? null;
      }
    },
    growthOffer: {
      create: async ({ data }) => {
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
          createdAt: now(),
          updatedAt: now(),
          ...data
        };
        state.offers.push(offer);
        return offer as any;
      },
      findMany: async (input: any = {}) => {
        let offers = state.offers.filter((offer) => {
          const where = input.where ?? {};
          if (where.merchantId && offer.merchantId !== where.merchantId) return false;
          if (where.type && offer.type !== where.type) return false;
          if (where.metadata?.path?.[0]) return offer.metadata?.[where.metadata.path[0]] === where.metadata.equals;
          return true;
        });
        if (input.include?.placements) {
          offers = offers.map((offer) => ({
            ...offer,
            placements: state.placements.filter((placement) => placement.offerId === offer.id)
          }));
        }
        return offers;
      },
      findUnique: async ({ where }) => state.offers.find((offer) => offer.id === where.id) ?? null,
      update: async ({ where, data }) => {
        const offer = state.offers.find((record) => record.id === where.id);
        if (!offer) throw new Error("OFFER_NOT_FOUND");
        Object.assign(offer, data, { updatedAt: now() });
        return offer as any;
      },
      count: async () => state.offers.length
    },
    growthOfferPlacement: {
      create: async ({ data }) => {
        const placement = {
          id: `placement_${state.nextPlacement++}`,
          createdAt: now(),
          updatedAt: now(),
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
          createdAt: now(),
          ...data
        };
        state.events.push(event);
        return event as any;
      }
    }
  };

  return { client, state };
}

async function makeApp(client: CodPrepaidIncentiveDb) {
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

describe("COD-to-prepaid incentive routes", () => {
  const servers: Array<() => Promise<void>> = [];

  after(async () => {
    await Promise.all(servers.map((close) => close()));
  });

  it("creates, lists, activates, resolves, creates, and reads intents through growth-network routes", async () => {
    const { client } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const created = await request(app.baseUrl, "/growth-network/prepaid-incentives/policies", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: "merchant_1",
        title: "Offer prepaid discount before dispatch",
        incentive_type: "FLAT_DISCOUNT",
        discount_amount_paise: 7500,
        metadata: {
          buyerEmail: "buyer@example.com",
          safe: true
        }
      })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.policyId, "policy_1");
    assert.equal("metadata" in created.body.data, false);

    const listed = await request(app.baseUrl, "/growth-network/prepaid-incentives/policies?merchant_id=merchant_1");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.policies.length, 1);

    const active = await request(app.baseUrl, "/growth-network/prepaid-incentives/policies/policy_1/status", {
      method: "PATCH",
      body: JSON.stringify({ status: "ACTIVE" })
    });
    assert.equal(active.status, 200);
    assert.equal(active.body.data.status, "ACTIVE");

    const resolved = await request(app.baseUrl, "/growth-network/prepaid-incentives/resolve", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: "merchant_1",
        payment_mode: "COD",
        cod_amount_paise: 150000,
        order_amount_paise: 150000,
        surface: "TRACKING_PAGE"
      })
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.data.eligible, true);
    assert.equal(resolved.body.data.offer.offerId, "offer_1");
    assert.equal(resolved.body.data.offer.label, "COD Shield suggestion");
    assert.equal(JSON.stringify(resolved.body).includes("buyer@example.com"), false);

    const intent = await request(app.baseUrl, "/growth-network/prepaid-incentives/intents", {
      method: "POST",
      body: JSON.stringify({
        policy_id: "policy_1",
        merchant_id: "merchant_1",
        order_id: "order_1",
        growth_offer_id: "offer_1",
        original_payment_mode: "COD",
        idempotency_key: "intent-route-1"
      })
    });
    assert.equal(intent.status, 201);
    assert.equal(intent.body.data.intentId, "intent_1");
    assert.equal(intent.body.data.paymentCollection, false);
    assert.equal(JSON.stringify(intent.body).includes("order_1"), false);

    const fetched = await request(app.baseUrl, "/growth-network/prepaid-incentives/intents/intent_1");
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.intentId, "intent_1");
  });

  it("rejects invalid policy and intent requests at the route boundary", async () => {
    const { client } = makeClient();
    const app = await makeApp(client);
    servers.push(app.close);

    const missingFlatAmount = await request(app.baseUrl, "/growth-network/prepaid-incentives/policies", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: "merchant_1",
        title: "Invalid flat",
        incentive_type: "FLAT_DISCOUNT"
      })
    });
    assert.equal(missingFlatAmount.status, 400);
    assert.equal(missingFlatAmount.body.error, "VALIDATION_ERROR");

    const overPercent = await request(app.baseUrl, "/growth-network/prepaid-incentives/policies", {
      method: "POST",
      body: JSON.stringify({
        merchant_id: "merchant_1",
        title: "Invalid percent",
        incentive_type: "PERCENT_DISCOUNT",
        discount_percent: 120
      })
    });
    assert.equal(overPercent.status, 400);

    const missingIntentContext = await request(app.baseUrl, "/growth-network/prepaid-incentives/intents", {
      method: "POST",
      body: JSON.stringify({
        policy_id: "policy_1",
        merchant_id: "merchant_1"
      })
    });
    assert.equal(missingIntentContext.status, 400);
  });
});
