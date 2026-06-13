import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recordGrowthEvent, recordTrackingPageView } from "../growth-network.service.js";
import {
  createRtoNdrRecoveryIntent,
  createRtoNdrRecoveryPolicy,
  getRtoNdrRecoveryIntent,
  listRtoNdrRecoveryPolicies,
  resolveRtoNdrRecoveryOffer,
  updateRtoNdrRecoveryPolicyStatus,
  type RtoNdrRecoveryDb
} from "../rto-ndr-recovery.service.js";

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
    ndrCases: [] as any[],
    rtoCases: [] as any[],
    courierApiCalls: 0,
    communicationSends: 0,
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

  function matchesIntentWhere(intent: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") {
        return (condition as any[]).some((child) => matchesIntentWhere(intent, child));
      }
      return intent[key] === condition;
    });
  }

  function matchesOperationalCase(row: any, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (key === "status" && typeof condition === "object" && condition && "notIn" in condition) {
        return !(condition as any).notIn.includes(row.status);
      }
      return row[key] === condition;
    });
  }

  const client: RtoNdrRecoveryDb = {
    rtoNdrRecoveryPolicy: {
      create: async ({ data }) => {
        const createdAt = nextDate();
        const policy = {
          id: `policy_${state.nextPolicy++}`,
          description: null,
          status: "DRAFT",
          incentiveAmountPaise: null,
          maxIncentiveAmountPaise: null,
          minOrderAmountPaise: null,
          maxOrderAmountPaise: null,
          allowedFailureReasons: null,
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
    rtoNdrRecoveryIntent: {
      create: async ({ data }) => {
        if (data.idempotencyKey && state.intents.some((intent) => intent.idempotencyKey === data.idempotencyKey)) {
          throw { code: "P2002" };
        }
        const createdAt = nextDate();
        const intent = {
          id: `intent_${state.nextIntent++}`,
          status: "INTENT_CREATED",
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
      },
      findFirst: async (input: any = {}) => state.intents.find((intent) => matchesIntentWhere(intent, input.where)) ?? null
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
    },
    ndrCase: {
      findFirst: async ({ where }: any) => state.ndrCases.find((row) => matchesOperationalCase(row, where)) ?? null
    },
    rtoCase: {
      findFirst: async ({ where }: any) => state.rtoCases.find((row) => matchesOperationalCase(row, where)) ?? null
    }
  };

  return { client, state };
}

async function createPolicy(
  client: RtoNdrRecoveryDb,
  overrides: Partial<Parameters<typeof createRtoNdrRecoveryPolicy>[0]> = {}
) {
  return createRtoNdrRecoveryPolicy({
    merchantId: "merchant_1",
    title: "Recover failed delivery",
    actionType: "CONFIRM_ADDRESS",
    status: "DRAFT",
    description: "Confirm delivery details to help retry.",
    ...overrides
  }, client);
}

describe("RTO/NDR recovery service", () => {
  it("creates, lists, activates, pauses, and archives policies without exposing metadata", async () => {
    const { client, state } = makeClient();
    const created = await createPolicy(client, {
      metadata: {
        buyerPhone: "9999999999",
        providerRef: "secret-provider-ref",
        safe: true
      }
    });

    assert.equal(created.policyId, "policy_1");
    assert.equal(created.status, "DRAFT");
    assert.equal("metadata" in created, false);

    const list = await listRtoNdrRecoveryPolicies({ merchantId: "merchant_1", page: 1, perPage: 50 }, client);
    assert.equal(list.pagination.total, 1);
    assert.equal(list.policies[0]?.policyId, created.policyId);

    const active = await updateRtoNdrRecoveryPolicyStatus(created.policyId, { status: "ACTIVE" }, client);
    assert.equal(active.status, "ACTIVE");
    const paused = await updateRtoNdrRecoveryPolicyStatus(created.policyId, { status: "PAUSED" }, client);
    assert.equal(paused.status, "PAUSED");
    const archived = await updateRtoNdrRecoveryPolicyStatus(created.policyId, { status: "ARCHIVED" }, client);
    assert.equal(archived.status, "ARCHIVED");
    assert.equal(state.courierApiCalls, 0);
    assert.equal(state.communicationSends, 0);
  });

  it("rejects invalid recovery policy configuration", async () => {
    const { client } = makeClient();
    await assert.rejects(
      () => createPolicy(client, { incentiveAmountPaise: -1 } as any),
      /RTO_NDR_RECOVERY_NEGATIVE_AMOUNT/
    );
    await assert.rejects(
      () => createPolicy(client, { incentiveAmountPaise: 5000, maxIncentiveAmountPaise: 4000 } as any),
      /RTO_NDR_RECOVERY_INVALID_INCENTIVE_RANGE/
    );
    await assert.rejects(
      () => createPolicy(client, { minOrderAmountPaise: 200000, maxOrderAmountPaise: 100000 } as any),
      /RTO_NDR_RECOVERY_INVALID_ORDER_AMOUNT_RANGE/
    );
  });

  it("resolves an active policy for NDR context and creates a reusable public-safe GrowthOffer", async () => {
    const { client, state } = makeClient();
    await createPolicy(client, { status: "ACTIVE" });

    const result = await resolveRtoNdrRecoveryOffer({
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      shipmentStatus: "delivery_failed",
      failureReason: "unreachable",
      orderAmountPaise: 150000,
      surface: "NDR_ACTION"
    }, client, now);

    assert.equal(result.eligible, true);
    assert.equal(result.offer?.policyId, "policy_1");
    assert.equal(result.offer?.offerId, "offer_1");
    assert.equal(result.offer?.label, "Address confirmation");
    assert.equal(result.offer?.isSponsored, false);
    assert.equal(state.offers[0]?.type, "RTO_NDR_RECOVERY");

    const json = JSON.stringify(result);
    assert.equal(json.includes("metadata"), false);
    assert.equal(json.includes("buyerPhone"), false);
    assert.equal(json.includes("provider"), false);
    assert.equal(json.includes("paymentSecret"), false);

    await resolveRtoNdrRecoveryOffer({
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      shipmentStatus: "delivery_failed",
      failureReason: "unreachable",
      orderAmountPaise: 150000,
      surface: "NDR_ACTION"
    }, client, now);
    assert.equal(state.offers.length, 1);
  });

  it("does not resolve paused, draft, archived, future, expired, terminal, non-recovery, or simulated-recovered contexts", async () => {
    const { client, state } = makeClient();
    await createPolicy(client, { status: "DRAFT" });
    await createPolicy(client, { status: "PAUSED" });
    await createPolicy(client, { status: "ARCHIVED" });
    await createPolicy(client, { status: "ACTIVE", startsAt: new Date("2026-06-14T00:00:00.000Z") });
    await createPolicy(client, { status: "ACTIVE", endsAt: new Date("2026-06-12T00:00:00.000Z") });

    const base = {
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      orderAmountPaise: 100000,
      surface: "NDR_ACTION" as const
    };

    assert.equal((await resolveRtoNdrRecoveryOffer({ ...base, shipmentStatus: "delivery_failed" }, client, now)).eligible, false);

    await createPolicy(client, { status: "ACTIVE" });
    assert.equal((await resolveRtoNdrRecoveryOffer({ ...base, shipmentStatus: "delivered" }, client, now)).reason, "ORDER_OR_SHIPMENT_TERMINAL");
    assert.equal((await resolveRtoNdrRecoveryOffer({ ...base, shipmentStatus: "cancelled" }, client, now)).reason, "ORDER_OR_SHIPMENT_TERMINAL");
    assert.equal((await resolveRtoNdrRecoveryOffer({ ...base, shipmentStatus: "in_transit" }, client, now)).reason, "RTO_NDR_RECOVERY_CONTEXT_REQUIRED");

    state.intents.push({
      id: "intent_recovered",
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      status: "RECOVERY_SIMULATED",
      actionType: "CONFIRM_ADDRESS",
      recoverySnapshot: {},
      createdAt: now
    });
    assert.equal((await resolveRtoNdrRecoveryOffer({ ...base, shipmentStatus: "delivery_failed" }, client, now)).reason, "RTO_NDR_ALREADY_RECOVERED_SIMULATED");
  });

  it("respects amount bounds, failure reasons, and best policy priority", async () => {
    const { client } = makeClient();
    await createPolicy(client, {
      status: "ACTIVE",
      title: "High amount only",
      minOrderAmountPaise: 200000
    });
    await createPolicy(client, {
      status: "ACTIVE",
      title: "Reason matched retry",
      actionType: "SELECT_RETRY_WINDOW",
      allowedFailureReasons: ["unreachable"],
      incentiveAmountPaise: 8000
    });
    await createPolicy(client, {
      status: "ACTIVE",
      title: "Confirm wins priority",
      actionType: "CONFIRM_ADDRESS",
      allowedFailureReasons: ["unreachable"],
      incentiveAmountPaise: 1000
    });
    await createPolicy(client, {
      status: "ACTIVE",
      title: "Wrong reason",
      actionType: "CONTACT_SUPPORT",
      allowedFailureReasons: ["address_incomplete"],
      incentiveAmountPaise: 9000
    });

    const result = await resolveRtoNdrRecoveryOffer({
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      shipmentStatus: "delivery_failed",
      failureReason: "unreachable",
      orderAmountPaise: 150000,
      surface: "NDR_ACTION"
    }, client, now);

    assert.equal(result.offer?.title, "Confirm wins priority");

    const noReason = await resolveRtoNdrRecoveryOffer({
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      shipmentStatus: "delivery_failed",
      orderAmountPaise: 150000,
      surface: "NDR_ACTION"
    }, client, now);
    assert.notEqual(noReason.offer?.title, "Reason matched retry");
  });

  it("creates and reads recovery intent idempotently without courier, communication, payment, or shipment-state mutation", async () => {
    const { client, state } = makeClient();
    const policy = await createPolicy(client, { status: "ACTIVE", incentiveAmountPaise: 5000 });
    state.shipments.push({
      id: "shipment_1",
      sellerId: "merchant_1",
      orderId: "order_1",
      status: "delivery_failed",
      recovered: false
    });

    const first = await createRtoNdrRecoveryIntent({
      policyId: policy.policyId,
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      growthOfferId: "offer_1",
      idempotencyKey: "recovery-intent-key-1",
      failureReason: "unreachable"
    }, client);
    const second = await createRtoNdrRecoveryIntent({
      policyId: policy.policyId,
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      growthOfferId: "offer_1",
      idempotencyKey: "recovery-intent-key-1",
      failureReason: "unreachable"
    }, client);

    assert.equal(first.intentId, "intent_1");
    assert.equal(second.intentId, "intent_1");
    assert.equal(second.duplicate, true);
    assert.equal(first.communicationSent, false);
    assert.equal(first.courierMutation, false);
    assert.equal(first.paymentCollection, false);
    assert.equal(first.displayValue, "Rs 50 recovery benefit");
    assert.equal(state.shipments[0]?.status, "delivery_failed");
    assert.equal(state.shipments[0]?.recovered, false);
    assert.equal(state.courierApiCalls, 0);
    assert.equal(state.communicationSends, 0);
    assert.equal(state.paymentGatewayCalls, 0);

    const fetched = await getRtoNdrRecoveryIntent(first.intentId, client);
    assert.equal(fetched.intentId, first.intentId);
    assert.equal(fetched.status, "INTENT_CREATED");
    assert.equal(JSON.stringify(fetched).includes("shipment_1"), false);

    await assert.rejects(
      () => createRtoNdrRecoveryIntent({
        policyId: policy.policyId,
        merchantId: "merchant_1"
      } as any, client),
      /RTO_NDR_RECOVERY_INTENT_CONTEXT_REQUIRED/
    );
  });

  it("keeps GrowthOfferEvent telemetry compatible for recovery offers", async () => {
    const { client } = makeClient();
    await createPolicy(client, { status: "ACTIVE" });
    const resolved = await resolveRtoNdrRecoveryOffer({
      merchantId: "merchant_1",
      shipmentId: "shipment_1",
      shipmentStatus: "delivery_failed",
      orderAmountPaise: 150000,
      surface: "NDR_ACTION"
    }, client, now);
    const offerId = resolved.offer?.offerId;
    assert.ok(offerId);

    const click = await recordGrowthEvent({
      eventType: "CLICK",
      surface: "NDR_ACTION",
      offerId,
      merchantId: "merchant_1"
    }, client);
    assert.equal(click.eventType, "CLICK");

    await assert.rejects(
      () => recordGrowthEvent({ eventType: "CONVERSION", surface: "NDR_ACTION" }, client),
      /GROWTH_OFFER_ID_REQUIRED_FOR_EVENT/
    );

    const conversion = await recordGrowthEvent({
      eventType: "CONVERSION",
      surface: "NDR_ACTION",
      offerId,
      merchantId: "merchant_1"
    }, client);
    assert.equal(conversion.eventType, "CONVERSION");

    const view = await recordTrackingPageView({ merchantId: "merchant_1" }, client);
    assert.equal(view.eventType, "VIEW");
    assert.equal(view.offerId, null);
  });
});
