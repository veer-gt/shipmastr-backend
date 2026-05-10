import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSellerSafeOrderDecisionFromRecords } from "../intelligence/seller-safe-decision.service.js";
import type { CommunicationProvider } from "./communication-provider.types.js";
import { MockCommunicationProvider } from "./mock-provider.js";
import {
  handleProviderDeliveryCallback,
  processCommunicationEvent,
  processQueuedBuyerCommunications
} from "./communication-worker.service.js";
import { validateTemplateData } from "./communication-template.registry.js";

const now = new Date("2026-05-05T00:00:00.000Z");

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event_1",
    orderId: "order_1",
    merchantId: "merchant_1",
    phoneHash: "phone_hash_1",
    channel: "WHATSAPP",
    template: "send_cod_otp",
    status: "QUEUED",
    response: null,
    providerMessageId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    respondedAt: null,
    metadata: {
      providerPayload: {
        recipientPhone: "+919999999999"
      }
    },
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as any;
}

function makeWorkerClient(
  events: any[],
  orderPhone: string | null = "+919888888888",
  policyOverrides: Record<string, unknown> = {}
) {
  const state = {
    events,
    orderPhone,
    auditLogs: [] as any[],
    policy: {
      merchantId: "merchant_1",
      autoOtpForBronzeEnabled: true,
      allowBuyerWhatsappMessages: true,
      allowBuyerSmsMessages: true,
      communicationEnabled: true,
      dailyWhatsappLimit: null,
      dailySmsLimit: null,
      buyerMessageQuietHoursStart: null,
      buyerMessageQuietHoursEnd: null,
      ...policyOverrides
    } as any
  };

  function matchesStatus(value: string, rule: any) {
    if (!rule) return true;
    if (typeof rule === "string") return value === rule;
    if (Array.isArray(rule.in)) return rule.in.includes(value);
    return true;
  }

  function matchesDate(value: Date | null, rule: any) {
    if (!rule) return true;
    if (!value) return false;
    return !rule.gte || value >= rule.gte;
  }

  function eventMatches(event: any, where: any = {}) {
    const statusMatches = matchesStatus(event.status, where.status);
    const channelMatches = !where.channel || event.channel === where.channel;
    const merchantMatches = !where.merchantId || event.merchantId === where.merchantId;
    const providerMatches = where.providerMessageId === undefined || event.providerMessageId === where.providerMessageId;
    const sentAtMatches = matchesDate(event.sentAt, where.sentAt);
    return statusMatches && channelMatches && merchantMatches && providerMatches && sentAtMatches;
  }

  const client = {
    buyerCommunicationEvent: {
      findMany: async ({ where, take }: any = {}) => {
        const filtered = state.events.filter((event) => eventMatches(event, where));
        return filtered.slice(0, take ?? filtered.length);
      },
      findFirst: async ({ where }: any = {}) => state.events.find((event) => eventMatches(event, where)) ?? null,
      count: async ({ where }: any = {}) => state.events.filter((event) => eventMatches(event, where)).length,
      findUniqueOrThrow: async ({ where }: any) => {
        const event = state.events.find((item) => item.id === where.id);
        if (!event) throw new Error("EVENT_NOT_FOUND");
        return event;
      },
      update: async ({ where, data }: any) => {
        const event = state.events.find((item) => item.id === where.id);
        if (!event) throw new Error("EVENT_NOT_FOUND");
        Object.assign(event, data, { updatedAt: now });
        return event;
      }
    },
    order: {
      findUnique: async () => state.orderPhone ? { buyerPhone: state.orderPhone } : null
    },
    merchantAutomationPolicy: {
      upsert: async () => state.policy
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

describe("communication worker", () => {
  it("validates registered template variables", () => {
    const invalid = validateTemplateData("COD_OTP", {});
    const valid = validateTemplateData("COD_OTP", { orderId: "order_1" });

    assert.equal(invalid.ok, false);
    assert.deepEqual(invalid.missingVariables, ["orderId"]);
    assert.equal(valid.ok, true);
  });

  it("marks a queued event sent with the mock provider", async () => {
    const event = makeEvent();
    const { client, state } = makeWorkerClient([event]);

    const result = await processQueuedBuyerCommunications({
      limit: 1,
      provider: new MockCommunicationProvider()
    }, client);

    assert.equal(result.processed, 1);
    assert.equal(result.sent, 1);
    assert.equal(state.events[0]?.status, "SENT");
    assert.equal(state.events[0]?.providerMessageId, "mock_whatsapp_event_1");
    assert.equal(state.events[0]?.metadata.idempotencyKey, "buyer-communication:event_1:COD_OTP:WHATSAPP");
  });

  it("marks events failed when no recipient is available", async () => {
    const event = makeEvent({ metadata: null });
    const { client, state } = makeWorkerClient([event], null);

    const result = await processQueuedBuyerCommunications({
      limit: 1,
      provider: new MockCommunicationProvider()
    }, client);

    assert.equal(result.failed, 1);
    assert.equal(state.events[0]?.status, "FAILED");
    assert.equal(state.events[0]?.metadata.failureReason, "MISSING_RECIPIENT");
    assert.equal(state.events[0]?.metadata.retryCount, 1);
  });

  it("does not resend an event that is already sent", async () => {
    let calls = 0;
    const provider: CommunicationProvider = {
      name: "counting",
      sendMessage: async () => {
        calls += 1;
        return { providerMessageId: "counting_1", status: "SENT" };
      }
    };
    const event = makeEvent({
      status: "SENT",
      providerMessageId: "existing_provider_message"
    });
    const { client } = makeWorkerClient([event]);

    const result = await processCommunicationEvent(event, { provider, client });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "ALREADY_SENT");
    assert.equal(calls, 0);
  });

  it("does not resend a queued event that already has a provider message", async () => {
    let calls = 0;
    const provider: CommunicationProvider = {
      name: "counting",
      sendMessage: async () => {
        calls += 1;
        return { providerMessageId: "counting_1", status: "SENT" };
      }
    };
    const event = makeEvent({
      providerMessageId: "existing_provider_message"
    });
    const { client, state } = makeWorkerClient([event]);

    const result = await processCommunicationEvent(event, { provider, client });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "ALREADY_HAS_PROVIDER_MESSAGE");
    assert.equal(calls, 0);
    assert.equal(state.events[0]?.status, "SENT");
  });

  it("respects the process-queue limit", async () => {
    const events = [
      makeEvent({ id: "event_1" }),
      makeEvent({ id: "event_2" }),
      makeEvent({ id: "event_3" })
    ];
    const { client, state } = makeWorkerClient(events);

    const result = await processQueuedBuyerCommunications({
      limit: 2,
      provider: new MockCommunicationProvider()
    }, client);

    assert.equal(result.processed, 2);
    assert.equal(state.events.filter((event) => event.status === "SENT").length, 2);
    assert.equal(state.events.filter((event) => event.status === "QUEUED").length, 1);
  });

  it("marks provider failures as failed with retry backoff", async () => {
    const provider: CommunicationProvider = {
      name: "failing-provider",
      sendMessage: async () => {
        throw new Error("provider down");
      }
    };
    const event = makeEvent();
    const { client, state } = makeWorkerClient([event]);

    const result = await processQueuedBuyerCommunications({ limit: 1, provider, now }, client);

    assert.equal(result.failed, 1);
    assert.equal(state.events[0]?.status, "FAILED");
    assert.equal(state.events[0]?.metadata.failureReason, "PROVIDER_SEND_FAILED");
    assert.equal(state.events[0]?.metadata.provider, "failing-provider");
    assert.equal(state.events[0]?.metadata.transientFailure, true);
    assert.match(state.events[0]?.metadata.nextAttemptAt, /^2026-05-05T00:05:00/);
  });

  it("retries failed transient events after backoff", async () => {
    const event = makeEvent({
      status: "FAILED",
      metadata: {
        providerPayload: { recipientPhone: "+919999999999" },
        failureReason: "PROVIDER_SEND_FAILED",
        transientFailure: true,
        retryCount: 1,
        nextAttemptAt: "2026-05-04T23:59:00.000Z"
      }
    });
    const { client, state } = makeWorkerClient([event]);

    const result = await processQueuedBuyerCommunications({
      limit: 1,
      provider: new MockCommunicationProvider(),
      now
    }, client);

    assert.equal(result.sent, 1);
    assert.equal(state.events[0]?.status, "SENT");
  });

  it("does not retry permanent failures", async () => {
    let calls = 0;
    const provider: CommunicationProvider = {
      name: "counting",
      sendMessage: async () => {
        calls += 1;
        return { providerMessageId: "counting_1", status: "SENT" };
      }
    };
    const event = makeEvent({
      status: "FAILED",
      metadata: {
        failureReason: "MISSING_RECIPIENT",
        transientFailure: false,
        retryCount: 1
      }
    });
    const { client } = makeWorkerClient([event]);

    const result = await processCommunicationEvent(event, { provider, client, now });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "NOT_RETRY_ELIGIBLE");
    assert.equal(calls, 0);
  });

  it("updates status from provider delivery callbacks", async () => {
    const event = makeEvent({
      status: "SENT",
      providerMessageId: "provider_msg_1",
      sentAt: now
    });
    const { client, state } = makeWorkerClient([event]);

    const updated = await handleProviderDeliveryCallback({
      providerMessageId: "provider_msg_1",
      status: "DELIVERED",
      metadata: { providerStatus: "delivered" }
    }, client);

    assert.equal(updated.status, "DELIVERED");
    assert.equal(state.events[0]?.metadata.providerCallback.providerStatus, "delivered");
  });

  it("blocks sends after the daily channel cap", async () => {
    const events = [
      makeEvent({
        id: "sent_event",
        status: "SENT",
        providerMessageId: "provider_sent",
        sentAt: now
      }),
      makeEvent({ id: "queued_event" })
    ];
    const { client, state } = makeWorkerClient(events, "+919888888888", {
      dailyWhatsappLimit: 1
    });

    const result = await processQueuedBuyerCommunications({
      limit: 1,
      provider: new MockCommunicationProvider(),
      now
    }, client);

    assert.equal(result.failed, 1);
    assert.equal(state.events[1]?.status, "FAILED");
    assert.equal(state.events[1]?.metadata.failureReason, "DAILY_CAP_EXCEEDED");
  });

  it("blocks non-critical messages during quiet hours", async () => {
    const event = makeEvent({
      channel: "SMS",
      template: "send_prepaid_link"
    });
    const { client, state } = makeWorkerClient([event], "+919888888888", {
      buyerMessageQuietHoursStart: "00:00",
      buyerMessageQuietHoursEnd: "23:59"
    });

    const result = await processQueuedBuyerCommunications({
      limit: 1,
      provider: new MockCommunicationProvider(),
      now
    }, client);

    assert.equal(result.failed, 1);
    assert.equal(state.events[0]?.status, "FAILED");
    assert.equal(state.events[0]?.metadata.failureReason, "QUIET_HOURS");
  });

  it("writes an audit log for outbound attempts", async () => {
    const event = makeEvent();
    const { client, state } = makeWorkerClient([event]);

    await processQueuedBuyerCommunications({
      limit: 1,
      provider: new MockCommunicationProvider(),
      now
    }, client);

    assert.equal(state.auditLogs.length, 1);
    assert.equal(state.auditLogs[0]?.action, "BUYER_COMMUNICATION_OUTBOUND_ATTEMPT");
    assert.equal(state.auditLogs[0]?.metadata.eventId, "event_1");
  });

  it("keeps provider internals out of seller-safe decisions", () => {
    const decision = buildSellerSafeOrderDecisionFromRecords({
      order: {
        id: "order_1",
        merchantId: "merchant_1",
        paymentMode: "COD",
        status: "RISK_SCORED"
      } as any,
      shipmentDetails: {
        shipmentStatus: "HELD",
        awb: null,
        trackingNumber: null,
        courierId: null
      } as any,
      orderIntelligence: {
        consigneeTier: "BRONZE",
        codDecision: "REQUIRE_OTP",
        shipmentDecision: "VERIFY_BEFORE_SHIP",
        courierId: null,
        courierReasons: []
      } as any,
      autonomousActions: [],
      buyerCommunicationEvents: [
        {
          id: "event_1",
          channel: "WHATSAPP",
          template: "send_cod_otp",
          status: "SENT",
          response: null,
          sentAt: now,
          deliveredAt: null,
          readAt: null,
          respondedAt: null,
          createdAt: now,
          phoneHash: "seller_hidden_phone_hash",
          providerMessageId: "seller_hidden_provider_message",
          metadata: {
            rawResponse: "seller_hidden_raw_response"
          }
        }
      ] as any,
      actionOutcomes: [],
      courierRecommendation: null
    });
    const serialized = JSON.stringify(decision);

    assert.ok(!serialized.includes("seller_hidden_phone_hash"));
    assert.ok(!serialized.includes("seller_hidden_provider_message"));
    assert.ok(!serialized.includes("seller_hidden_raw_response"));
  });

  it("registers the internal process-queue route", () => {
    const source = readFileSync("src/modules/automation/automation.routes.ts", "utf8");

    assert.match(source, /post\("\/process-queue"/);
    assert.match(source, /post\("\/provider-callback"/);
    assert.match(source, /processQueuedBuyerCommunications/);
  });
});
