import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recordGrowthEvent, recordTrackingPageView } from "../growth-network.service.js";
import {
  createPrepaidConversionIntent,
  createPrepaidIncentivePolicy,
  getPrepaidConversionIntent,
  listPrepaidIncentivePolicies,
  resolvePrepaidIncentiveOffer,
  updatePrepaidIncentivePolicyStatus,
  type CodPrepaidIncentiveDb
} from "../cod-prepaid-incentive.service.js";

const now = new Date("2026-06-13T10:00:00.000Z");

function makeClient() {
  const state = {
    policies: [] as any[],
    intents: [] as any[],
    offers: [] as any[],
    placements: [] as any[],
    events: [] as any[],
    orders: [] as any[],
    shipments: [] as any[],
    paymentGatewayCalls: 0,
    nextPolicy: 1,
    nextIntent: 1,
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

  function matchesPolicyWhere(policy: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "AND") return (condition as any[]).every((child) => matchesPolicyWhere(policy, child));
      if (key === "OR") return (condition as any[]).some((child) => matchesPolicyWhere(policy, child));
      if (key === "startsAt" || key === "endsAt") return matchesDate(policy[key], condition);
      return policy[key] === condition;
    });
  }

  function matchesOfferWhere(offer: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "metadata") {
        const path = (condition as any).path?.[0];
        return path ? offer.metadata?.[path] === (condition as any).equals : true;
      }
      return offer[key] === condition;
    });
  }

  const client: CodPrepaidIncentiveDb = {
    prepaidIncentivePolicy: {
      create: async ({ data }) => {
        const createdAt = nextDate();
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
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.policies.push(policy);
        return policy as any;
      },
      findMany: async (input: any = {}) => {
        let policies = state.policies.filter((policy) => matchesPolicyWhere(policy, input.where));
        if (input.orderBy?.createdAt === "desc") {
          policies = [...policies].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        }
        if (typeof input.skip === "number") policies = policies.slice(input.skip);
        if (typeof input.take === "number") policies = policies.slice(0, input.take);
        return policies;
      },
      findUnique: async ({ where }) => state.policies.find((policy) => policy.id === where.id) ?? null,
      update: async ({ where, data }) => {
        const policy = state.policies.find((record) => record.id === where.id);
        if (!policy) throw new Error("POLICY_NOT_FOUND");
        Object.assign(policy, data, { updatedAt: nextDate() });
        return policy as any;
      },
      count: async (input: any = {}) => state.policies.filter((policy) => matchesPolicyWhere(policy, input.where)).length
    },
    prepaidConversionIntent: {
      create: async ({ data }) => {
        if (data.idempotencyKey && state.intents.some((intent) => intent.idempotencyKey === data.idempotencyKey)) {
          throw { code: "P2002" };
        }
        const createdAt = nextDate();
        const intent = {
          id: `intent_${state.nextIntent++}`,
          status: "INTENT_CREATED",
          targetPaymentMode: "PREPAID",
          createdAt,
          updatedAt: createdAt,
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
        let offers = state.offers.filter((offer) => matchesOfferWhere(offer, input.where));
        if (input.include?.placements) {
          offers = offers.map((offer) => ({
            ...offer,
            placements: state.placements.filter((placement) => placement.offerId === offer.id)
          }));
        }
        if (typeof input.take === "number") offers = offers.slice(0, input.take);
        return offers;
      },
      findUnique: async ({ where }) => state.offers.find((offer) => offer.id === where.id) ?? null,
      update: async ({ where, data }) => {
        const offer = state.offers.find((record) => record.id === where.id);
        if (!offer) throw new Error("OFFER_NOT_FOUND");
        Object.assign(offer, data, { updatedAt: nextDate() });
        return offer as any;
      },
      count: async () => state.offers.length
    },
    growthOfferPlacement: {
      create: async ({ data }) => {
        const createdAt = nextDate();
        const placement = {
          id: `placement_${state.nextPlacement++}`,
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
    order: {
      findFirst: async ({ where }: any) => state.orders.find((order) => (
        order.merchantId === where.merchantId
        && where.OR.some((clause: any) => order.id === clause.id || order.externalOrderId === clause.externalOrderId)
      )) ?? null
    },
    shipment: {
      findFirst: async ({ where }: any) => state.shipments.find((shipment) => (
        where.OR.some((clause: any) => shipment.id === clause.id || shipment.orderId === clause.orderId || shipment.externalOrderId === clause.externalOrderId)
      )) ?? null
    }
  };

  return { client, state };
}

async function createPolicy(
  client: CodPrepaidIncentiveDb,
  overrides: Partial<Parameters<typeof createPrepaidIncentivePolicy>[0]> = {}
) {
  return createPrepaidIncentivePolicy({
    merchantId: "merchant_1",
    title: "Switch COD to prepaid",
    incentiveType: "FLAT_DISCOUNT",
    discountAmountPaise: 5000,
    status: "DRAFT",
    description: "Save when you switch before dispatch.",
    ...overrides
  }, client);
}

describe("COD-to-prepaid incentive service", () => {
  it("creates, lists, activates, pauses, and archives policies without exposing metadata", async () => {
    const { client, state } = makeClient();
    const created = await createPolicy(client, {
      metadata: {
        buyerPhone: "9999999999",
        safe: true
      }
    });

    assert.equal(created.policyId, "policy_1");
    assert.equal(created.status, "DRAFT");
    assert.equal("metadata" in created, false);

    const list = await listPrepaidIncentivePolicies({ merchantId: "merchant_1", page: 1, perPage: 50 }, client);
    assert.equal(list.pagination.total, 1);
    assert.equal(list.policies[0]?.policyId, created.policyId);

    const active = await updatePrepaidIncentivePolicyStatus(created.policyId, { status: "ACTIVE" }, client);
    assert.equal(active.status, "ACTIVE");
    const paused = await updatePrepaidIncentivePolicyStatus(created.policyId, { status: "PAUSED" }, client);
    assert.equal(paused.status, "PAUSED");
    const archived = await updatePrepaidIncentivePolicyStatus(created.policyId, { status: "ARCHIVED" }, client);
    assert.equal(archived.status, "ARCHIVED");
    assert.equal(state.paymentGatewayCalls, 0);
  });

  it("rejects invalid discount configuration", async () => {
    const { client } = makeClient();
    await assert.rejects(
      () => createPolicy(client, { incentiveType: "FLAT_DISCOUNT", discountAmountPaise: null } as any),
      /PREPAID_INCENTIVE_FLAT_AMOUNT_REQUIRED/
    );
    await assert.rejects(
      () => createPolicy(client, { incentiveType: "PERCENT_DISCOUNT", discountPercent: 101 } as any),
      /PREPAID_INCENTIVE_PERCENT_OUT_OF_RANGE/
    );
    await assert.rejects(
      () => createPolicy(client, { discountAmountPaise: -1 } as any),
      /PREPAID_INCENTIVE_NEGATIVE_AMOUNT/
    );
  });

  it("resolves an active policy for COD context and creates a reusable public-safe GrowthOffer", async () => {
    const { client, state } = makeClient();
    await createPolicy(client, { status: "ACTIVE" });

    const result = await resolvePrepaidIncentiveOffer({
      merchantId: "merchant_1",
      paymentMode: "COD",
      codAmountPaise: 150000,
      orderAmountPaise: 150000,
      surface: "TRACKING_PAGE"
    }, client, now);

    assert.equal(result.eligible, true);
    assert.equal(result.offer?.policyId, "policy_1");
    assert.equal(result.offer?.offerId, "offer_1");
    assert.equal(result.offer?.label, "COD Shield suggestion");
    assert.equal(result.offer?.isSponsored, false);

    const json = JSON.stringify(result);
    assert.equal(json.includes("metadata"), false);
    assert.equal(json.includes("buyerPhone"), false);
    assert.equal(json.includes("provider"), false);
    assert.equal(json.includes("paymentSecret"), false);

    await resolvePrepaidIncentiveOffer({
      merchantId: "merchant_1",
      paymentMode: "COD",
      codAmountPaise: 150000,
      orderAmountPaise: 150000,
      surface: "TRACKING_PAGE"
    }, client, now);
    assert.equal(state.offers.length, 1);
  });

  it("does not resolve paused, draft, archived, future, expired, prepaid, paid, or terminal contexts", async () => {
    const { client } = makeClient();
    await createPolicy(client, { status: "DRAFT" });
    await createPolicy(client, { status: "PAUSED" });
    await createPolicy(client, { status: "ARCHIVED" });
    await createPolicy(client, { status: "ACTIVE", startsAt: new Date("2026-06-14T00:00:00.000Z") });
    await createPolicy(client, { status: "ACTIVE", endsAt: new Date("2026-06-12T00:00:00.000Z") });

    const base = {
      merchantId: "merchant_1",
      codAmountPaise: 100000,
      orderAmountPaise: 100000,
      surface: "TRACKING_PAGE" as const
    };

    assert.equal((await resolvePrepaidIncentiveOffer({ ...base, paymentMode: "COD" }, client, now)).eligible, false);

    await createPolicy(client, { status: "ACTIVE" });
    assert.equal((await resolvePrepaidIncentiveOffer({ ...base, paymentMode: "PREPAID" }, client, now)).reason, "ORDER_ALREADY_PREPAID_OR_PAID");
    assert.equal((await resolvePrepaidIncentiveOffer({ ...base, paymentMode: "COD", isPaid: true }, client, now)).reason, "ORDER_ALREADY_PREPAID_OR_PAID");
    assert.equal((await resolvePrepaidIncentiveOffer({ ...base, paymentMode: "COD", orderStatus: "DELIVERED" }, client, now)).reason, "ORDER_OR_SHIPMENT_TERMINAL");
    assert.equal((await resolvePrepaidIncentiveOffer({ ...base, paymentMode: "COD", shipmentStatus: "rto_delivered" }, client, now)).reason, "ORDER_OR_SHIPMENT_TERMINAL");
  });

  it("respects min and max order amounts and selects the best policy by discount value then newest", async () => {
    const { client } = makeClient();
    await createPolicy(client, {
      status: "ACTIVE",
      title: "Low value only",
      minOrderAmountPaise: 100000,
      maxOrderAmountPaise: 200000,
      discountAmountPaise: 5000
    });
    await createPolicy(client, {
      status: "ACTIVE",
      title: "Percent winner",
      incentiveType: "PERCENT_DISCOUNT",
      discountPercent: 20,
      maxDiscountAmountPaise: 10000
    });
    await createPolicy(client, {
      status: "ACTIVE",
      title: "Flat fallback",
      discountAmountPaise: 3000
    });

    const belowMin = await resolvePrepaidIncentiveOffer({
      merchantId: "merchant_1",
      paymentMode: "COD",
      codAmountPaise: 90000,
      orderAmountPaise: 90000,
      surface: "TRACKING_PAGE"
    }, client, now);
    assert.notEqual(belowMin.offer?.title, "Low value only");

    const aboveMax = await resolvePrepaidIncentiveOffer({
      merchantId: "merchant_1",
      paymentMode: "COD",
      codAmountPaise: 250000,
      orderAmountPaise: 250000,
      surface: "TRACKING_PAGE"
    }, client, now);
    assert.equal(aboveMax.offer?.title, "Percent winner");

    const tiedClient = makeClient().client;
    await createPolicy(tiedClient, { status: "ACTIVE", title: "Older", discountAmountPaise: 5000 });
    await createPolicy(tiedClient, { status: "ACTIVE", title: "Newer", discountAmountPaise: 5000 });
    const tied = await resolvePrepaidIncentiveOffer({
      merchantId: "merchant_1",
      paymentMode: "COD",
      codAmountPaise: 150000,
      orderAmountPaise: 150000,
      surface: "TRACKING_PAGE"
    }, tiedClient, now);
    assert.equal(tied.offer?.title, "Newer");
  });

  it("creates and reads conversion intent idempotently without marking an order paid or calling payment gateways", async () => {
    const { client, state } = makeClient();
    const policy = await createPolicy(client, { status: "ACTIVE" });
    state.orders.push({
      id: "order_1",
      merchantId: "merchant_1",
      externalOrderId: "external_1",
      orderValue: 150000,
      codAmount: 150000,
      paymentMode: "COD",
      status: "CREATED",
      paid: false
    });

    const first = await createPrepaidConversionIntent({
      policyId: policy.policyId,
      merchantId: "merchant_1",
      orderId: "order_1",
      growthOfferId: "offer_1",
      originalPaymentMode: "COD",
      idempotencyKey: "intent-key-1"
    }, client);
    const second = await createPrepaidConversionIntent({
      policyId: policy.policyId,
      merchantId: "merchant_1",
      orderId: "order_1",
      growthOfferId: "offer_1",
      originalPaymentMode: "COD",
      idempotencyKey: "intent-key-1"
    }, client);

    assert.equal(first.intentId, "intent_1");
    assert.equal(second.intentId, "intent_1");
    assert.equal(second.duplicate, true);
    assert.equal(first.paymentCollection, false);
    assert.equal(first.displayValue, "Rs 50 off");
    assert.equal(state.orders[0]?.paymentMode, "COD");
    assert.equal(state.orders[0]?.paid, false);
    assert.equal(state.paymentGatewayCalls, 0);

    const fetched = await getPrepaidConversionIntent(first.intentId, client);
    assert.equal(fetched.intentId, first.intentId);
    assert.equal(fetched.status, "INTENT_CREATED");
    assert.equal(JSON.stringify(fetched).includes("order_1"), false);

    await assert.rejects(
      () => createPrepaidConversionIntent({
        policyId: policy.policyId,
        merchantId: "merchant_1"
      } as any, client),
      /PREPAID_CONVERSION_INTENT_CONTEXT_REQUIRED/
    );
  });

  it("keeps GrowthOfferEvent telemetry compatible for prepaid offers", async () => {
    const { client } = makeClient();
    await createPolicy(client, { status: "ACTIVE" });
    const resolved = await resolvePrepaidIncentiveOffer({
      merchantId: "merchant_1",
      paymentMode: "COD",
      codAmountPaise: 150000,
      orderAmountPaise: 150000,
      surface: "TRACKING_PAGE"
    }, client, now);
    const offerId = resolved.offer?.offerId;
    assert.ok(offerId);

    const click = await recordGrowthEvent({
      eventType: "CLICK",
      surface: "TRACKING_PAGE",
      offerId,
      merchantId: "merchant_1"
    }, client);
    assert.equal(click.eventType, "CLICK");

    await assert.rejects(
      () => recordGrowthEvent({ eventType: "CONVERSION", surface: "TRACKING_PAGE" }, client),
      /GROWTH_OFFER_ID_REQUIRED_FOR_EVENT/
    );

    const conversion = await recordGrowthEvent({
      eventType: "CONVERSION",
      surface: "TRACKING_PAGE",
      offerId,
      merchantId: "merchant_1"
    }, client);
    assert.equal(conversion.eventType, "CONVERSION");

    const view = await recordTrackingPageView({ merchantId: "merchant_1" }, client);
    assert.equal(view.eventType, "VIEW");
    assert.equal(view.offerId, null);
  });
});
