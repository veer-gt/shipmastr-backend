import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { env } from "../../config/env.js";
import { requireInternalSecret } from "../../middleware/internal.js";
import { prisma } from "../../lib/prisma.js";
import {
  AutomationCallbackError,
  buildAbandonedCheckoutAutomationEvent,
  buildCodRemittanceAlertAutomationEvent,
  buildCodRemittanceSubject,
  buildCourierPickupDelayAutomationEvent,
  buildCourierPickupDelaySubject,
  buildCourierSlaBreachAutomationEvent,
  buildCourierSlaBreachSubject,
  buildCourierDailyDigestAutomationEvent,
  buildCourierDailyDigestSubject,
  buildFakeScanReviewAutomationEvent,
  buildFakeScanReviewSubject,
  buildInvoiceMismatchAutomationEvent,
  buildInvoiceMismatchSubject,
  buildMerchantDailyDigestAutomationEvent,
  buildMerchantDailyDigestSummary,
  buildNdrRecoveryAutomationEvent,
  buildRepeatBuyerAutomationEvent,
  buildRepeatBuyerSubject,
  buildSellerSettlementSubject,
  buildSellerSettlementSummaryAutomationEvent,
  connectMerchantEmailChannel,
  connectMerchantWhatsappChannel,
  createAutomationSignature,
  dispatchAutomationEvent,
  emitAutomationEvent,
  formatMerchantDigestSubjectDate,
  getMerchantChannelReadiness,
  handleAutomationCallback,
  handleWhatsappProviderCallback,
  runMerchantChannelTest,
  runRepeatBuyerSmoke,
  setMerchantEmailFallback,
  verifyAutomationSignature,
  verifyWhatsappProviderSignature
} from "./autopilot.service.js";
import {
  buildOrderAutomationEvents,
  buildOrderAutomationPayloads
} from "../orders/orders.routes.js";
import { validateAutomationSmokeCallbackBody } from "./automation.routes.js";

const now = new Date("2026-05-14T10:00:00.000Z");

const originalEnv = {
  n8nEnabled: env.N8N_AUTOPILOT_ENABLED,
  n8nUrl: env.N8N_AUTOPILOT_DISPATCH_URL,
  n8nWorkflowUrls: env.N8N_AUTOPILOT_WORKFLOW_URLS,
  n8nSigningSecret: env.N8N_AUTOPILOT_SIGNING_SECRET,
  n8nTimeout: env.N8N_AUTOPILOT_TIMEOUT_MS,
  smokeCallbacksEnabled: env.SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED,
  internalProvisioningSecret: env.SHIPMASTR_INTERNAL_PROVISIONING_SECRET,
  internalSecret: env.SHIPMASTR_INTERNAL_SECRET,
  whatsappWebhookSecret: env.WHATSAPP_PROVIDER_WEBHOOK_SECRET
};

const restorers: Array<() => void> = [];

function mockPrismaMethod(delegate: string, method: string, fn: (...args: any[]) => any) {
  const target = (prisma as any)[delegate];
  const original = target[method];
  Object.defineProperty(target, method, {
    configurable: true,
    value: fn
  });
  restorers.push(() => {
    Object.defineProperty(target, method, {
      configurable: true,
      value: original
    });
  });
}

function resetEnv() {
  (env as any).N8N_AUTOPILOT_ENABLED = originalEnv.n8nEnabled;
  (env as any).N8N_AUTOPILOT_DISPATCH_URL = originalEnv.n8nUrl;
  (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = originalEnv.n8nWorkflowUrls;
  (env as any).N8N_AUTOPILOT_SIGNING_SECRET = originalEnv.n8nSigningSecret;
  (env as any).N8N_AUTOPILOT_TIMEOUT_MS = originalEnv.n8nTimeout;
  (env as any).SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED = originalEnv.smokeCallbacksEnabled;
  (env as any).SHIPMASTR_INTERNAL_PROVISIONING_SECRET = originalEnv.internalProvisioningSecret;
  (env as any).SHIPMASTR_INTERNAL_SECRET = originalEnv.internalSecret;
  (env as any).WHATSAPP_PROVIDER_WEBHOOK_SECRET = originalEnv.whatsappWebhookSecret;
}

function createAutomationTestHmac(secret: string, body: string) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const callbackSecret = "shipmastr-internal-callback-secret-min-32";

function configureCallbackTestEnv(smokeCallbacksEnabled = true) {
  (env as any).SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED = smokeCallbacksEnabled;
  (env as any).SHIPMASTR_INTERNAL_PROVISIONING_SECRET = undefined;
  (env as any).SHIPMASTR_INTERNAL_SECRET = callbackSecret;
  (env as any).N8N_AUTOPILOT_SIGNING_SECRET = undefined;
}

function makePreference(overrides: Record<string, unknown> = {}) {
  return {
    id: "pref_1",
    merchantId: "merchant_1",
    autopilotEnabled: true,
    notificationsEnabled: true,
    codShieldEnabled: true,
    ndrRescueEnabled: true,
    marketingEnabled: true,
    courierControlEnabled: true,
    financeControlEnabled: true,
    buyerIntelligenceEnabled: true,
    whatsappEnabled: true,
    smsEnabled: true,
    emailEnabled: true,
    quietHoursStart: "21:00",
    quietHoursEnd: "09:00",
    timezone: "Asia/Kolkata",
    dailyBuyerMessageCap: 3,
    weeklyBuyerMessageCap: 8,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as any;
}

function makeWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    id: "workflow_1",
    merchantId: "merchant_1",
    key: "SM_ORDER_CREATED",
    status: "ACTIVE",
    channelOrder: ["WHATSAPP", "SMS", "EMAIL"],
    frequencyCap: null,
    retryLimit: 3,
    quietHoursMode: "respect",
    settings: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as any;
}

function makeChannelCredential(channel: "EMAIL" | "WHATSAPP", overrides: Record<string, unknown> = {}) {
  return {
    id: `cred_${channel.toLowerCase()}`,
    merchantId: "merchant_1",
    channel,
    provider: channel === "EMAIL" ? "merchant-smtp" : "merchant-whatsapp",
    label: channel === "EMAIL" ? "Primary email" : "Primary WhatsApp",
    credentialRef: `secret_ref_${channel.toLowerCase()}_must_not_dispatch`,
    status: "VERIFIED",
    lastVerifiedAt: now,
    metadata: channel === "EMAIL"
      ? {
        businessEmail: "care@merchant.example",
        senderEmail: "care@merchant.example",
        replyToEmail: "support@merchant.example"
      }
      : {
        whatsappBusinessNumber: "+919876543210",
        templateNamespace: "merchant_namespace",
        templateName: "abandoned_checkout_v1",
        templateStatuses: {
          abandonedCheckout: "APPROVED",
          repeatBuyer: "APPROVED"
        }
      },
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as any;
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    merchantId: "merchant_1",
    eventKey: "order.created",
    status: "QUEUED",
    source: "test",
    sourceId: "order_1",
    idempotencyKey: "order.created:order_1",
    payload: { orderId: "order_1", buyerPhone: "+919999999999" },
    contextSnapshot: null,
    dispatchResult: null,
    error: null,
    attempts: 0,
    nextAttemptAt: null,
    processedAt: null,
    failedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as any;
}

function installDispatchMocks(input: {
  event?: any;
  preference?: any;
  workflow?: any;
  channelCredentials?: any[];
  optOut?: any | null;
  frequencyLedger?: any | null;
} = {}) {
  const event = input.event || makeEvent();
  const preference = input.preference || makePreference();
  const workflow = input.workflow || makeWorkflow({
    key: event.eventKey === "cart.abandoned"
      ? "SM_20_ABANDONED_CHECKOUT"
      : event.eventKey === "buyer.repeat_purchase_due"
        ? "SM_21_REPEAT_BUYER"
        : event.eventKey.startsWith("cod.remittance_")
          ? "SM_40_COD_REMITTANCE_ALERT"
          : event.eventKey.startsWith("seller.settlement_")
            ? "SM_41_SELLER_SETTLEMENT_SUMMARY"
          : event.eventKey.startsWith("invoice.")
            ? "SM_42_INVOICE_MISMATCH"
          : event.eventKey.startsWith("courier.pickup_")
            ? "SM_30_COURIER_PICKUP_DELAY"
          : event.eventKey.includes("sla_breach")
            ? "SM_31_COURIER_SLA_BREACH"
          : event.eventKey.includes("scan")
            ? "SM_32_FAKE_SCAN_REVIEW"
          : event.eventKey.includes("daily_digest")
            ? "SM_33_COURIER_DAILY_DIGEST"
          : "SM_ORDER_CREATED"
  });
  const updates: any[] = [];
  const audits: any[] = [];
  const usage: any[] = [];
  const logs: any[] = [];

  mockPrismaMethod("automationEvent", "findUnique", async () => event);
  mockPrismaMethod("automationEvent", "update", async ({ data }: any) => {
    updates.push(data);
    if (data.attempts?.increment) event.attempts += data.attempts.increment;
    Object.assign(event, data, { updatedAt: now });
    return { ...event };
  });
  mockPrismaMethod("automationPreference", "upsert", async () => preference);
  mockPrismaMethod("automationWorkflowSetting", "upsert", async () => workflow);
  mockPrismaMethod("automationWorkflowSetting", "findMany", async () => [workflow]);
  mockPrismaMethod("automationTemplate", "findMany", async () => []);
  mockPrismaMethod("merchantChannelCredential", "findMany", async () => input.channelCredentials || []);
  mockPrismaMethod("merchantChannelCredential", "findFirst", async ({ where }: any = {}) => {
    const credentials = input.channelCredentials || [];
    return credentials.find((credential) =>
      (!where?.merchantId || credential.merchantId === where.merchantId) &&
      (!where?.channel || credential.channel === where.channel) &&
      (!where?.status?.in || where.status.in.includes(credential.status))
    ) || null;
  });
  mockPrismaMethod("merchant", "findUnique", async () => ({
    id: "merchant_1",
    name: "Skymax",
    email: "seller@example.com",
    phone: "+919999999999",
    onboardingStatus: "COMPLETED",
    sellerKycStatus: "APPROVED",
    adminStatus: "ACTIVE"
  }));
  mockPrismaMethod("automationOptOut", "findFirst", async () => input.optOut ?? null);
  mockPrismaMethod("automationFrequencyLedger", "findUnique", async () => input.frequencyLedger ?? null);
  mockPrismaMethod("automationFrequencyLedger", "upsert", async () => ({ id: "ledger_1" }));
  mockPrismaMethod("communicationLog", "findFirst", async ({ where }: any) =>
    logs.find((log) => log.merchantId === where.merchantId && log.idempotencyKey === where.idempotencyKey) || null
  );
  mockPrismaMethod("communicationLog", "create", async ({ data }: any) => {
    const log = { id: `log_${logs.length + 1}`, createdAt: now, updatedAt: now, ...data };
    logs.push(log);
    return log;
  });
  mockPrismaMethod("automationUsageMeter", "upsert", async (args: any) => {
    usage.push(args);
    return args.create;
  });
  mockPrismaMethod("auditLog", "create", async ({ data }: any) => {
    audits.push(data);
    return { id: `audit_${audits.length}`, ...data, createdAt: now };
  });

  return { event, updates, audits, usage, logs };
}

function installCallbackMocks(input: {
  event?: any;
  logs?: any[];
} = {}) {
  const event = input.event || makeEvent({ status: "DISPATCHED", attempts: 1 });
  const updates: any[] = [];
  const audits: any[] = [];
  const logs = input.logs || [];
  const usage: any[] = [];

  mockPrismaMethod("automationEvent", "findUnique", async () => event);
  mockPrismaMethod("automationEvent", "update", async ({ data }: any) => {
    updates.push(data);
    Object.assign(event, data, { updatedAt: now });
    return { ...event };
  });
  mockPrismaMethod("marketingCampaign", "findFirst", async () => ({ id: "campaign_1" }));
  mockPrismaMethod("communicationLog", "findFirst", async ({ where }: any) =>
    logs.find((log) => log.merchantId === where.merchantId && log.idempotencyKey === where.idempotencyKey) || null
  );
  mockPrismaMethod("communicationLog", "create", async ({ data }: any) => {
    const log = { id: `log_${logs.length + 1}`, createdAt: now, updatedAt: now, ...data };
    logs.push(log);
    return log;
  });
  mockPrismaMethod("automationFrequencyLedger", "upsert", async () => ({ id: "ledger_1" }));
  mockPrismaMethod("automationUsageMeter", "upsert", async (args: any) => {
    usage.push(args);
    return args.create;
  });
  mockPrismaMethod("auditLog", "create", async ({ data }: any) => {
    audits.push(data);
    return { id: `audit_${audits.length + 1}`, createdAt: now, ...data };
  });

  return { event, updates, audits, logs, usage };
}

describe("Autopilot hardening", () => {
  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    while (restorers.length) restorers.pop()?.();
    mock.restoreAll();
    resetEnv();
  });

  it("enforces AutomationEvent idempotency by merchant and idempotency key", async () => {
    let upsertArgs: any;
    mockPrismaMethod("automationEvent", "upsert", async (args: any) => {
      upsertArgs = args;
      return { id: "evt_1", ...args.create };
    });
    mockPrismaMethod("auditLog", "create", async () => {
      throw new Error("audit should not be written on successful emit");
    });

    await emitAutomationEvent({
      merchantId: "merchant_1",
      eventKey: "order.created",
      source: "orders",
      sourceId: "order_1",
      idempotencyKey: "order.created:order_1",
      payload: { orderId: "order_1" }
    });

    assert.deepEqual(upsertArgs.where, {
      merchantId_idempotencyKey: {
        merchantId: "merchant_1",
        idempotencyKey: "order.created:order_1"
      }
    });
    assert.equal(upsertArgs.create.merchantId, "merchant_1");
    assert.equal(upsertArgs.create.status, "QUEUED");
  });

  it("cancels disabled automation preferences without dispatching", async () => {
    const { updates } = installDispatchMocks({
      preference: makePreference({ autopilotEnabled: false })
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called");
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(updates.at(-1).dispatchResult.reason, "AUTOPILOT_PAUSED");
  });

  it("separates marketing automation from transactional notifications", async () => {
    const { updates } = installDispatchMocks({
      event: makeEvent({ eventKey: "cart.abandoned", payload: { cartId: "cart_1", buyerPhone: "+919999999999" } }),
      preference: makePreference({ marketingEnabled: false }),
      workflow: makeWorkflow({ key: "SM_ABANDONED_CHECKOUT" })
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("marketing dispatch should not run when marketing is disabled");
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(updates.at(-1).dispatchResult.reason, "MARKETING_DISABLED");
    assert.equal(updates.at(-1).dispatchResult.automationType, "marketing");
  });

  it("builds merchant-owned abandoned checkout recovery events without raw provider secrets", () => {
    const event = buildAbandonedCheckoutAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      storeName: "Urban Saree Co",
      cartId: "cart_1",
      checkoutId: "checkout_1",
      buyerName: "Preview Buyer",
      buyerEmail: "buyer@example.com",
      buyerPhone: "+919999999999",
      emailMarketingConsent: true,
      whatsappMarketingConsent: true,
      cartValuePaise: 199900,
      itemCount: 2,
      recoveryWindowMinutes: 45,
      recoveryUrl: "https://merchant.example/recover/cart_1",
      preferredChannels: ["EMAIL", "WHATSAPP"]
    });

    assert.equal(event.eventKey, "cart.abandoned");
    assert.equal(event.source, "abandoned-checkout");
    assert.equal(event.idempotencyKey, "cart-abandoned:merchant_1:cart_1:45");
    assert.equal((event.payload as any).email.subject, "Complete your order from Urban Saree Co");
    assert.equal((event.payload as any).buyerContact.email, "buyer@example.com");
    assert.equal((event.payload as any).buyerContact.phone, "+919999999999");
    const serialized = JSON.stringify(event.payload);
    for (const forbidden of ["credentialRef", "secret", "token", "password", "smtp", "webhookId"]) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `${forbidden} leaked in abandoned checkout payload`);
    }
  });

  it("dispatches abandoned checkout through verified merchant email and WhatsApp channels", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_DISPATCH_URL = "https://workflow.internal.example/autopilot/order-created";
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_20_ABANDONED_CHECKOUT: "https://workflow.internal.example/autopilot/abandoned-checkout"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const abandoned = buildAbandonedCheckoutAutomationEvent({
      merchantId: "merchant_1",
      storeName: "Urban Saree Co",
      cartId: "cart_1",
      buyerEmail: "buyer@example.com",
      buyerPhone: "+919999999999",
      emailMarketingConsent: true,
      whatsappMarketingConsent: true,
      recoveryUrl: "https://merchant.example/recover/cart_1"
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({
        eventKey: abandoned.eventKey,
        idempotencyKey: abandoned.idempotencyKey,
        payload: abandoned.payload
      }),
      preference: makePreference({
        marketingEnabled: true,
        metadata: {
          abandonedCheckoutEnabled: true,
          emailMarketingEnabled: true,
          whatsappMarketingEnabled: true
        }
      }),
      workflow: makeWorkflow({
        key: "SM_20_ABANDONED_CHECKOUT",
        channelOrder: ["EMAIL", "WHATSAPP"],
        frequencyCap: 1,
        quietHoursMode: "ignore_internal_only"
      }),
      channelCredentials: [
        makeChannelCredential("EMAIL"),
        makeChannelCredential("WHATSAPP")
      ]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/abandoned-checkout");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_20_ABANDONED_CHECKOUT");
    assert.equal(body.automationType, "marketing");
    assert.equal(body.event.payload.channelPlan.emailEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, true);
    assert.equal(body.event.payload.channelPlan.emailSender, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.replyTo, "care@merchant.example");
    assert.equal(body.event.payload.email.subject, "Complete your order from Urban Saree Co");
    const serializedBody = JSON.stringify(body);
    assert.equal(serializedBody.includes("secret_ref_email_must_not_dispatch"), false);
    assert.equal(serializedBody.includes("secret_ref_whatsapp_must_not_dispatch"), false);
    assert.equal(serializedBody.includes("credentialRef"), false);
    assert.equal(state.usage[0].create.usageType, "N8N_EXECUTION");
    assert.equal(state.usage[0].create.workflowKey, "SM_20_ABANDONED_CHECKOUT");
  });

  it("skips WhatsApp safely when the merchant WhatsApp channel is not verified", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_20_ABANDONED_CHECKOUT: "https://workflow.internal.example/autopilot/abandoned-checkout"
    });

    const abandoned = buildAbandonedCheckoutAutomationEvent({
      merchantId: "merchant_1",
      storeName: "Urban Saree Co",
      cartId: "cart_2",
      buyerEmail: "buyer@example.com",
      buyerPhone: "+919999999999",
      emailMarketingConsent: true,
      whatsappMarketingConsent: true,
      recoveryUrl: "https://merchant.example/recover/cart_2"
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: abandoned.eventKey, idempotencyKey: abandoned.idempotencyKey, payload: abandoned.payload }),
      preference: makePreference({ marketingEnabled: true, metadata: { abandonedCheckoutEnabled: true } }),
      workflow: makeWorkflow({ key: "SM_20_ABANDONED_CHECKOUT", channelOrder: ["EMAIL", "WHATSAPP"], frequencyCap: 1, quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [
        makeChannelCredential("EMAIL"),
        makeChannelCredential("WHATSAPP", { status: "PENDING" })
      ]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.event.payload.channelPlan.emailEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons[0].reason, "WHATSAPP_MERCHANT_CHANNEL_NOT_VERIFIED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "SKIPPED");
    assert.equal(state.logs[0].channel, "WHATSAPP");
  });

  it("uses Shipmastr noreply fallback only when the merchant explicitly allows it", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_20_ABANDONED_CHECKOUT: "https://workflow.internal.example/autopilot/abandoned-checkout"
    });

    const abandoned = buildAbandonedCheckoutAutomationEvent({
      merchantId: "merchant_1",
      storeName: "Urban Saree Co",
      cartId: "cart_3",
      buyerEmail: "buyer@example.com",
      emailMarketingConsent: true,
      whatsappMarketingConsent: false,
      recoveryUrl: "https://merchant.example/recover/cart_3",
      preferredChannels: ["EMAIL"]
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    installDispatchMocks({
      event: makeEvent({ eventKey: abandoned.eventKey, idempotencyKey: abandoned.idempotencyKey, payload: abandoned.payload }),
      preference: makePreference({
        marketingEnabled: true,
        metadata: {
          abandonedCheckoutEnabled: true,
          abandonedCheckoutFallbackSenderAllowed: true
        }
      }),
      workflow: makeWorkflow({ key: "SM_20_ABANDONED_CHECKOUT", channelOrder: ["EMAIL"], frequencyCap: 1, quietHoursMode: "ignore_internal_only" }),
      channelCredentials: []
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.event.payload.channelPlan.emailSender, "noreply@shipmastr.com");
    assert.equal(body.event.payload.channelPlan.fallbackSenderAllowed, true);
    assert.equal(body.event.payload.channelPlan.emailEnabled, true);
  });

  it("dispatches COD remittance alerts through email first and skips WhatsApp while provider is blocked", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_40_COD_REMITTANCE_ALERT: "https://workflow.internal.example/autopilot/cod-remittance"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const alert = buildCodRemittanceAlertAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "cod.remittance_delayed",
      remittanceId: "remit_2",
      dueDate: "2026-05-13",
      codAmountPaise: 240000,
      shipmentCount: 8,
      awbCount: 8,
      preferredChannels: ["EMAIL", "WHATSAPP"]
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        financeControlEnabled: true,
        metadata: {
          financeAlertsEnabled: true,
          codDelayedAlertsEnabled: true,
          financeAlertEmailEnabled: true,
          financeAlertWhatsappEnabled: true
        }
      }),
      workflow: makeWorkflow({ key: "SM_40_COD_REMITTANCE_ALERT", channelOrder: ["EMAIL", "WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/cod-remittance");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_40_COD_REMITTANCE_ALERT");
    assert.equal(body.automationType, "transactional");
    assert.equal(body.event.payload.templateKey, "cod_remittance_delayed_v1");
    assert.equal(body.event.payload.channelPlan.emailEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.emailSender, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.replyTo, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons.some((skip: any) => skip.reason === "WHATSAPP_FINANCE_TEMPLATE_NOT_READY"), true);
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "SKIPPED");
    assert.equal(state.logs[0].templateKey, "cod_remittance_delayed_v1");
    assert.equal(state.usage.some((item) => item.create.usageType === "N8N_EXECUTION" && item.create.workflowKey === "SM_40_COD_REMITTANCE_ALERT"), true);
  });

  it("blocks COD remittance dispatch when finance alert preferences are disabled", async () => {
    const alert = buildCodRemittanceAlertAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "cod.remittance_due",
      remittanceId: "remit_disabled",
      dueDate: "2026-05-16"
    });
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        metadata: { financeAlertsEnabled: false }
      }),
      workflow: makeWorkflow({ key: "SM_40_COD_REMITTANCE_ALERT", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(state.updates.at(-1).dispatchResult.reason, "FINANCE_ALERTS_DISABLED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs.every((log) => log.status === "SKIPPED"), true);
  });

  it("dispatches seller settlement summaries through email and keeps WhatsApp skipped while provider is blocked", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_41_SELLER_SETTLEMENT_SUMMARY: "https://workflow.internal.example/autopilot/seller-settlement"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const alert = buildSellerSettlementSummaryAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "seller.settlement_paid",
      settlementId: "settlement_2",
      settlementDate: "2026-05-16",
      paidAt: "2026-05-17T07:00:00.000Z",
      grossCodAmountPaise: 300000,
      shippingChargesPaise: 45000,
      platformFeesPaise: 5000,
      netPayableAmountPaise: 250000,
      shipmentCount: 14,
      awbCount: 14,
      preferredChannels: ["EMAIL", "WHATSAPP"]
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        financeControlEnabled: true,
        metadata: {
          settlementAlertsEnabled: true,
          settlementPaidAlertsEnabled: true,
          settlementEmailEnabled: true,
          settlementWhatsappEnabled: true
        }
      }),
      workflow: makeWorkflow({ key: "SM_41_SELLER_SETTLEMENT_SUMMARY", channelOrder: ["EMAIL", "WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/seller-settlement");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_41_SELLER_SETTLEMENT_SUMMARY");
    assert.equal(body.automationType, "transactional");
    assert.equal(body.event.payload.templateKey, "seller_settlement_paid_v1");
    assert.equal(body.event.payload.channelPlan.emailEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.emailSender, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.replyTo, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons.some((skip: any) => skip.reason === "WHATSAPP_SETTLEMENT_TEMPLATE_NOT_READY"), true);
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "SKIPPED");
    assert.equal(state.logs[0].templateKey, "seller_settlement_paid_v1");
    assert.equal(state.usage.some((item) => item.create.usageType === "N8N_EXECUTION" && item.create.workflowKey === "SM_41_SELLER_SETTLEMENT_SUMMARY"), true);
  });

  it("blocks seller settlement dispatch when settlement alerts are disabled", async () => {
    const alert = buildSellerSettlementSummaryAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "seller.settlement_generated",
      settlementId: "settlement_disabled",
      settlementDate: "2026-05-16"
    });
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        metadata: { settlementAlertsEnabled: false }
      }),
      workflow: makeWorkflow({ key: "SM_41_SELLER_SETTLEMENT_SUMMARY", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(state.updates.at(-1).dispatchResult.reason, "SETTLEMENT_ALERTS_DISABLED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs.every((log) => log.status === "SKIPPED"), true);
  });

  it("dispatches invoice mismatch alerts through email and keeps WhatsApp skipped while provider is blocked", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_42_INVOICE_MISMATCH: "https://workflow.internal.example/autopilot/invoice-mismatch"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const alert = buildInvoiceMismatchAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "invoice.weight_discrepancy_detected",
      invoiceId: "invoice_7",
      mismatchId: "mismatch_7",
      courierPartnerName: "Safe Courier",
      expectedAmountPaise: 175000,
      billedAmountPaise: 205000,
      affectedShipmentCount: 4,
      preferredChannels: ["EMAIL", "WHATSAPP"]
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        financeControlEnabled: true,
        metadata: {
          invoiceMismatchAlertsEnabled: true,
          weightDiscrepancyAlertsEnabled: true,
          invoiceMismatchEmailEnabled: true,
          invoiceMismatchWhatsappEnabled: true
        }
      }),
      workflow: makeWorkflow({ key: "SM_42_INVOICE_MISMATCH", channelOrder: ["EMAIL", "WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/invoice-mismatch");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_42_INVOICE_MISMATCH");
    assert.equal(body.event.payload.templateKey, "invoice_weight_discrepancy_v1");
    assert.equal(body.event.payload.invoiceId, "invoice_7");
    assert.equal(body.event.payload.channelPlan.emailEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.emailSender, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.replyTo, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons.some((skip: any) => skip.reason === "WHATSAPP_INVOICE_TEMPLATE_NOT_READY"), true);
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "SKIPPED");
    assert.equal(state.logs[0].templateKey, "invoice_weight_discrepancy_v1");
    assert.equal(state.usage.some((item) => item.create.usageType === "N8N_EXECUTION" && item.create.workflowKey === "SM_42_INVOICE_MISMATCH"), true);
  });

  it("blocks invoice mismatch dispatch when invoice alerts are disabled", async () => {
    const alert = buildInvoiceMismatchAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "invoice.duplicate_awb_charge_detected",
      invoiceId: "invoice_disabled",
      mismatchId: "mismatch_disabled"
    });
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        metadata: { invoiceMismatchAlertsEnabled: false }
      }),
      workflow: makeWorkflow({ key: "SM_42_INVOICE_MISMATCH", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(state.updates.at(-1).dispatchResult.reason, "INVOICE_MISMATCH_ALERTS_DISABLED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs.every((log) => log.status === "SKIPPED"), true);
  });

  it("dispatches courier pickup delay alerts with merchant and courier-safe payloads", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_30_COURIER_PICKUP_DELAY: "https://workflow.internal.example/autopilot/courier-pickup-delay"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const alert = buildCourierPickupDelayAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@merchant.example",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      courierEmail: "ops@safe-courier.example",
      eventKey: "courier.pickup_delay_detected",
      pickupId: "pickup_7",
      pickupDate: "2026-05-17",
      delayMinutes: 95,
      affectedShipmentCount: 12,
      awbCount: 12,
      oldestAwbAgeMinutes: 180,
      preferredChannels: ["EMAIL", "WHATSAPP"],
      ...( {
        courierCredentialRef: "must_not_leak",
        rawPickupManifest: ["must_not_leak"]
      } as any)
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        courierControlEnabled: true,
        metadata: {
          courierPickupAlertsEnabled: true,
          merchantPickupDelayAlertsEnabled: true,
          courierPartnerPickupAlertsEnabled: true,
          pickupDelayEmailEnabled: true,
          pickupDelayWhatsappEnabled: true
        }
      }),
      workflow: makeWorkflow({ key: "SM_30_COURIER_PICKUP_DELAY", channelOrder: ["EMAIL", "WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/courier-pickup-delay");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_30_COURIER_PICKUP_DELAY");
    assert.equal(body.event.payload.templateKey, "courier_pickup_delay_v1");
    assert.equal(body.event.payload.pickupId, "pickup_7");
    assert.equal(body.event.payload.courierPartner.id, "courier_1");
    assert.equal(body.event.payload.channelPlan.merchantEmailEnabled, true);
    assert.equal(body.event.payload.channelPlan.courierEmailEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.emailSender, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.replyTo, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons.some((skip: any) => skip.reason === "WHATSAPP_PICKUP_DELAY_TEMPLATE_NOT_READY"), true);
    assert.equal(JSON.stringify(body.event.payload).includes("rawPickupManifest"), false);
    assert.equal(JSON.stringify(body.event.payload).includes("courierCredentialRef"), false);
    assert.equal(state.usage.some((item) => item.create.usageType === "N8N_EXECUTION" && item.create.workflowKey === "SM_30_COURIER_PICKUP_DELAY"), true);
  });

  it("dispatches courier SLA breach alerts with merchant and courier-safe payloads", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_31_COURIER_SLA_BREACH: "https://workflow.internal.example/autopilot/courier-sla-breach"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const alert = buildCourierSlaBreachAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@merchant.example",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      courierEmail: "sla@safe-courier.example",
      eventKey: "courier.ndr_response_sla_breach",
      breachId: "breach_7",
      breachMinutes: 180,
      affectedShipmentCount: 9,
      awbCount: 9,
      sampleAwbs: ["BLISS17774438577588613"],
      severity: "CRITICAL",
      preferredChannels: ["EMAIL", "WHATSAPP", "INTERNAL"],
      ...( {
        courierCredentialRef: "must_not_leak",
        rawCourierApiTrace: ["must_not_leak"]
      } as any)
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        courierControlEnabled: true,
        metadata: {
          courierSlaAlertsEnabled: true,
          merchantSlaAlertsEnabled: true,
          courierPartnerSlaAlertsEnabled: true,
          ndrSlaBreachAlertsEnabled: true,
          slaBreachEmailEnabled: true,
          slaBreachWhatsappEnabled: true,
          opsEscalationEnabled: true
        }
      }),
      workflow: makeWorkflow({ key: "SM_31_COURIER_SLA_BREACH", channelOrder: ["EMAIL", "WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/courier-sla-breach");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_31_COURIER_SLA_BREACH");
    assert.equal(body.event.payload.templateKey, "courier_ndr_response_sla_breach_v1");
    assert.equal(body.event.payload.breachId, "breach_7");
    assert.equal(body.event.payload.courierPartner.id, "courier_1");
    assert.equal(body.event.payload.sampleAwbs[0], "BLI***613");
    assert.equal(body.event.payload.channelPlan.merchantEmailEnabled, true);
    assert.equal(body.event.payload.channelPlan.courierEmailEnabled, true);
    assert.equal(body.event.payload.channelPlan.opsEscalationEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons.some((skip: any) => skip.reason === "WHATSAPP_COURIER_SLA_TEMPLATE_NOT_READY"), true);
    assert.equal(JSON.stringify(body.event.payload).includes("rawCourierApiTrace"), false);
    assert.equal(JSON.stringify(body.event.payload).includes("courierCredentialRef"), false);
    assert.equal(state.usage.some((item) => item.create.usageType === "N8N_EXECUTION" && item.create.workflowKey === "SM_31_COURIER_SLA_BREACH"), true);
  });

  it("dispatches fake scan review alerts with ops-first safe payloads", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_32_FAKE_SCAN_REVIEW: "https://workflow.internal.example/autopilot/fake-scan-review"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const alert = buildFakeScanReviewAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@merchant.example",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      courierEmail: "scan@safe-courier.example",
      eventKey: "courier.ndr_scan_suspected_fake",
      anomalyId: "anomaly_7",
      detectedAt: "2026-05-17T10:00:00.000Z",
      awb: "BLISS17774438577588613",
      affectedShipmentCount: 2,
      awbCount: 2,
      sellerSafeSummary: "NDR scan timing needs review.",
      opsReviewSummary: "Scan arrived late and conflicts with courier sequence.",
      severity: "HIGH",
      preferredChannels: ["EMAIL", "WHATSAPP", "INTERNAL"],
      ...( {
        rawCourierWebhookPayload: ["must_not_leak"],
        courierCredentialRef: "must_not_leak"
      } as any)
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        courierControlEnabled: true,
        metadata: {
          fakeScanReviewEnabled: true,
          merchantFakeScanAlertsEnabled: false,
          courierFakeScanAlertsEnabled: false,
          fakeScanEmailEnabled: true,
          fakeScanWhatsappEnabled: true,
          opsEscalationEnabled: true
        }
      }),
      workflow: makeWorkflow({ key: "SM_32_FAKE_SCAN_REVIEW", channelOrder: ["EMAIL", "WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/fake-scan-review");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_32_FAKE_SCAN_REVIEW");
    assert.equal(body.event.payload.templateKey, "fake_ndr_scan_v1");
    assert.equal(body.event.payload.anomalyId, "anomaly_7");
    assert.equal(body.event.payload.anomalyType, "ndr_scan_suspected_fake");
    assert.equal(body.event.payload.awbMasked, "BLI***613");
    assert.equal(body.event.payload.channelPlan.opsEscalationEnabled, true);
    assert.equal(body.event.payload.channelPlan.merchantEmailEnabled, false);
    assert.equal(body.event.payload.channelPlan.courierEmailEnabled, false);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.emailSender, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.replyTo, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons.some((skip: any) => skip.reason === "FAKE_SCAN_MERCHANT_EMAIL_DISABLED"), true);
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons.some((skip: any) => skip.reason === "WHATSAPP_FAKE_SCAN_TEMPLATE_NOT_READY"), true);
    assert.equal(JSON.stringify(body.event.payload).includes("rawCourierWebhookPayload"), false);
    assert.equal(JSON.stringify(body.event.payload).includes("courierCredentialRef"), false);
    assert.equal(state.updates.at(-1).dispatchResult.permissionScope, "automation:ops:fake-scan");
    assert.equal(state.usage.some((item) => item.create.usageType === "N8N_EXECUTION" && item.create.workflowKey === "SM_32_FAKE_SCAN_REVIEW"), true);
  });

  it("dispatches courier daily digest with ops-safe summary payload", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_33_COURIER_DAILY_DIGEST: "https://workflow.internal.example/autopilot/courier-daily-digest"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const digest = buildCourierDailyDigestAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "ops@shipmastr.example",
      eventKey: "courier.ops_daily_digest_due",
      digestId: "digest_ops_1",
      digestDate: "2026-05-17",
      scope: "OPS",
      pendingPickupCount: 18,
      slaBreachCount: 7,
      ndrBacklogCount: 11,
      fakeScanReviewCount: 4,
      invoiceMismatchCount: 3,
      invoiceMismatchAmountPaise: 45000,
      affectedMerchantCount: 6,
      affectedShipmentCount: 42,
      criticalSeverityCount: 1,
      preferredChannels: ["EMAIL", "WHATSAPP", "INTERNAL"],
      ...( {
        rawCourierWebhookPayload: ["must_not_leak"],
        rawInvoiceRows: ["must_not_leak"],
        courierCredentialRef: "must_not_leak"
      } as any)
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: digest.eventKey, idempotencyKey: digest.idempotencyKey, payload: digest.payload }),
      preference: makePreference({
        courierControlEnabled: true,
        metadata: {
          courierDailyDigestEnabled: true,
          opsDigestEnabled: true,
          courierDailyDigestEmailEnabled: true,
          courierDailyDigestInternalAlertEnabled: true,
          courierDailyDigestWhatsappEnabled: true
        }
      }),
      workflow: makeWorkflow({ key: "SM_33_COURIER_DAILY_DIGEST", channelOrder: ["EMAIL", "WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/courier-daily-digest");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_33_COURIER_DAILY_DIGEST");
    assert.equal(body.event.payload.templateKey, "courier_ops_daily_digest_v1");
    assert.equal(body.event.payload.digestId, "digest_ops_1");
    assert.equal(body.event.payload.scope, "OPS");
    assert.equal(body.event.payload.summary.pendingPickupCount, 18);
    assert.equal(body.event.payload.summary.invoiceMismatchAmountPaise, 45000);
    assert.equal(body.event.payload.channelPlan.opsEmailEnabled, true);
    assert.equal(body.event.payload.channelPlan.internalAlertEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.emailSender, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.replyTo, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons.some((skip: any) => skip.reason === "WHATSAPP_COURIER_DAILY_DIGEST_TEMPLATE_NOT_READY"), true);
    assert.equal(JSON.stringify(body.event.payload).includes("rawCourierWebhookPayload"), false);
    assert.equal(JSON.stringify(body.event.payload).includes("rawInvoiceRows"), false);
    assert.equal(JSON.stringify(body.event.payload).includes("courierCredentialRef"), false);
    assert.equal(state.updates.at(-1).dispatchResult.permissionScope, "automation:ops:courier-daily-digest");
    assert.equal(state.usage.some((item) => item.create.usageType === "N8N_EXECUTION" && item.create.workflowKey === "SM_33_COURIER_DAILY_DIGEST"), true);
  });

  it("blocks courier SLA breach dispatch when SLA alerts are disabled", async () => {
    const alert = buildCourierSlaBreachAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@merchant.example",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      eventKey: "courier.pickup_sla_breach",
      breachId: "breach_disabled"
    });
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        metadata: { courierSlaAlertsEnabled: false }
      }),
      workflow: makeWorkflow({ key: "SM_31_COURIER_SLA_BREACH", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(state.updates.at(-1).dispatchResult.reason, "COURIER_SLA_ALERTS_DISABLED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs.every((log) => log.status === "SKIPPED"), true);
  });

  it("blocks fake scan review dispatch when fake scan review is disabled", async () => {
    const alert = buildFakeScanReviewAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      eventKey: "courier.pickup_scan_suspected_fake",
      anomalyId: "anomaly_disabled"
    });
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        metadata: { fakeScanReviewEnabled: false }
      }),
      workflow: makeWorkflow({ key: "SM_32_FAKE_SCAN_REVIEW", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(state.updates.at(-1).dispatchResult.reason, "FAKE_SCAN_REVIEW_DISABLED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs.every((log) => log.status === "SKIPPED"), true);
  });

  it("blocks courier partner daily digest until the partner has opted in", async () => {
    const digest = buildCourierDailyDigestAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      eventKey: "courier.partner_daily_digest_due",
      digestId: "digest_partner_disabled",
      digestDate: "2026-05-17",
      scope: "COURIER_PARTNER",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      courierEmail: "digest@safe-courier.example"
    });
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: digest.eventKey, idempotencyKey: digest.idempotencyKey, payload: digest.payload }),
      preference: makePreference({
        courierControlEnabled: true,
        metadata: {
          courierDailyDigestEnabled: true,
          courierPartnerDailyDigestEnabled: false
        }
      }),
      workflow: makeWorkflow({ key: "SM_33_COURIER_DAILY_DIGEST", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(state.updates.at(-1).dispatchResult.reason, "COURIER_PARTNER_DAILY_DIGEST_DISABLED");
    assert.equal(state.logs.some((log) => log.status === "SKIPPED" && log.metadata.skipReason === "COURIER_PARTNER_DAILY_DIGEST_DISABLED"), true);
  });

  it("blocks courier pickup delay dispatch when courier alerts are disabled", async () => {
    const alert = buildCourierPickupDelayAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@merchant.example",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      eventKey: "courier.pickup_missed",
      pickupId: "pickup_disabled"
    });
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: alert.eventKey, idempotencyKey: alert.idempotencyKey, payload: alert.payload }),
      preference: makePreference({
        metadata: { courierPickupAlertsEnabled: false }
      }),
      workflow: makeWorkflow({ key: "SM_30_COURIER_PICKUP_DELAY", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(state.updates.at(-1).dispatchResult.reason, "COURIER_PICKUP_ALERTS_DISABLED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs.every((log) => log.status === "SKIPPED"), true);
  });

  it("returns merchant channel readiness with one effective email identity", async () => {
    mockPrismaMethod("automationPreference", "upsert", async () => makePreference({
      metadata: { abandonedCheckoutFallbackSenderAllowed: false }
    }));
    mockPrismaMethod("merchantChannelCredential", "findMany", async () => [
      makeChannelCredential("EMAIL", {
        metadata: {
          businessEmail: "care@merchant.example",
          senderEmail: "care@merchant.example",
          replyToEmail: "support@merchant.example",
          credentialRef: "must_not_return"
        }
      })
    ]);
    mockPrismaMethod("communicationLog", "findFirst", async () => null);

    const readiness = await getMerchantChannelReadiness("merchant_1");

    assert.equal(readiness.email.status, "VERIFIED");
    assert.equal(readiness.email.fallbackUsed, false);
    assert.equal(readiness.email.effectiveSenderMasked, readiness.email.effectiveReplyToMasked);
    assert.equal(readiness.abandonedCheckout.emailReady, true);
    const serialized = JSON.stringify(readiness);
    assert.equal(serialized.includes("support@merchant.example"), false);
    assert.equal(serialized.includes("credentialRef"), false);
    assert.equal(serialized.includes("must_not_return"), false);
  });

  it("falls back to noreply only when fallback is allowed", async () => {
    mockPrismaMethod("automationPreference", "upsert", async () => makePreference({
      metadata: { abandonedCheckoutFallbackSenderAllowed: true }
    }));
    mockPrismaMethod("merchantChannelCredential", "findMany", async () => []);
    mockPrismaMethod("communicationLog", "findFirst", async () => null);

    const readiness = await getMerchantChannelReadiness("merchant_1");

    assert.equal(readiness.email.status, "NOT_CONNECTED");
    assert.equal(readiness.email.fallbackUsed, true);
    assert.equal(readiness.email.fallbackAllowed, true);
    assert.equal(readiness.email.effectiveSenderMasked, readiness.email.effectiveReplyToMasked);
    assert.equal(readiness.abandonedCheckout.canEnable, true);
  });

  it("gates WhatsApp abandoned checkout on verified channel and approved template", async () => {
    mockPrismaMethod("automationPreference", "upsert", async () => makePreference());
    mockPrismaMethod("communicationLog", "findFirst", async () => null);
    mockPrismaMethod("merchantChannelCredential", "findMany", async () => [
      makeChannelCredential("WHATSAPP", {
        metadata: {
          whatsappBusinessNumber: "+919876543210",
          templateStatuses: { abandonedCheckout: "PENDING" }
        }
      })
    ]);
    const pending = await getMerchantChannelReadiness("merchant_1");
    assert.equal(pending.whatsapp.status, "VERIFIED");
    assert.equal(pending.whatsapp.templateStatus.abandonedCheckout, "PENDING");
    assert.equal(pending.abandonedCheckout.whatsappReady, false);

    while (restorers.length) restorers.pop()?.();
    mockPrismaMethod("automationPreference", "upsert", async () => makePreference());
    mockPrismaMethod("communicationLog", "findFirst", async () => null);
    mockPrismaMethod("merchantChannelCredential", "findMany", async () => [
      makeChannelCredential("WHATSAPP", {
        metadata: {
          whatsappBusinessNumber: "+919876543210",
          templateStatuses: { abandonedCheckout: "APPROVED" }
        }
      })
    ]);

    const approved = await getMerchantChannelReadiness("merchant_1");
    assert.equal(approved.whatsapp.templateStatus.abandonedCheckout, "APPROVED");
    assert.equal(approved.abandonedCheckout.whatsappReady, true);
    assert.equal(approved.abandonedCheckout.canEnable, true);
  });

  it("returns WhatsApp provider readiness without exposing phone-number ids or credential refs", async () => {
    mockPrismaMethod("automationPreference", "upsert", async () => makePreference());
    mockPrismaMethod("communicationLog", "findFirst", async () => null);
    mockPrismaMethod("merchantChannelCredential", "findMany", async () => [
      makeChannelCredential("WHATSAPP", {
        provider: "gupshup",
        credentialRef: "secret-manager://merchant-whatsapp-token",
        metadata: {
          whatsappBusinessNumber: "+919876543210",
          whatsappPhoneNumberId: "123456789012345",
          providerMode: "real",
          providerStatus: "HEALTHY",
          templateStatuses: {
            codRisk: "APPROVED",
            addressConfirmation: "APPROVED",
            ndrRecovery: "APPROVED",
            abandonedCheckout: "APPROVED",
            repeatBuyer: "APPROVED"
          },
          templateMappings: {
            codRisk: { providerTemplateName: "merchant_cod_risk_v1", language: "en" }
          }
        }
      })
    ]);

    const readiness = await getMerchantChannelReadiness("merchant_1");

    assert.equal(readiness.whatsapp.providerStatus, "HEALTHY");
    assert.equal(readiness.whatsapp.providerMode, "real");
    assert.equal(readiness.whatsapp.phoneNumberIdMasked, "12***2345");
    assert.equal(readiness.whatsapp.templateMappings.codRisk.providerTemplateName, "merchant_cod_risk_v1");
    const serialized = JSON.stringify(readiness);
    assert.equal(serialized.includes("123456789012345"), false);
    assert.equal(serialized.includes("secret-manager://merchant-whatsapp-token"), false);
    assert.equal(serialized.includes("credentialRef"), false);
  });

  it("blocks real WhatsApp dispatch when the required template is missing", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_COD_RISK_HIGH: "https://workflow.internal.example/autopilot/cod-risk"
    });
    const state = installDispatchMocks({
      event: makeEvent({
        eventKey: "order.cod_risk_high",
        payload: {
          orderId: "order_1",
          buyerContact: { phone: "+919999999999" }
        }
      }),
      workflow: makeWorkflow({ key: "SM_COD_RISK_HIGH", channelOrder: ["WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [
        makeChannelCredential("WHATSAPP", {
          provider: "gupshup",
          metadata: {
            whatsappBusinessNumber: "+919876543210",
            providerMode: "real",
            templateStatuses: { codRisk: "PENDING" }
          }
        })
      ]
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("real WhatsApp dispatch should not run without approved template");
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(state.updates.at(-1).dispatchResult.reason, "NO_WHATSAPP_CHANNEL_ALLOWED");
    assert.equal(state.logs[0].templateKey, "cod_risk_high_v1");
    assert.equal(state.logs[0].status, "SKIPPED");
  });

  it("allows real WhatsApp dispatch only with verified channel and approved template", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_COD_RISK_HIGH: "https://workflow.internal.example/autopilot/cod-risk"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";
    const requests: Array<{ url: string; init: RequestInit }> = [];
    installDispatchMocks({
      event: makeEvent({
        eventKey: "order.cod_risk_high",
        payload: {
          orderId: "order_1",
          buyerContact: { phone: "+919999999999" }
        }
      }),
      workflow: makeWorkflow({ key: "SM_COD_RISK_HIGH", channelOrder: ["WHATSAPP"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [
        makeChannelCredential("WHATSAPP", {
          provider: "gupshup",
          metadata: {
            whatsappBusinessNumber: "+919876543210",
            whatsappPhoneNumberId: "123456789012345",
            providerMode: "real",
            templateStatuses: { codRisk: "APPROVED" },
            templateMappings: {
              codRisk: { providerTemplateName: "merchant_cod_risk_v1", language: "en" }
            }
          }
        })
      ]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.event.payload.channelPlan.whatsappProviderMode, "real");
    assert.equal(body.event.payload.channelPlan.whatsappTemplateKey, "cod_risk_high_v1");
    assert.equal(body.event.payload.channelPlan.whatsappTemplateName, "merchant_cod_risk_v1");
    assert.equal(body.event.payload.channelPlan.whatsappPhoneNumberIdMasked, "12***2345");
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("123456789012345"), false);
    assert.equal(serialized.includes("secret_ref_whatsapp_must_not_dispatch"), false);
  });

  it("connects email with safe business-email metadata and toggles fallback by merchant", async () => {
    let credentialUpsert: any;
    let preferenceUpdate: any;
    mockPrismaMethod("merchantChannelCredential", "upsert", async (args: any) => {
      credentialUpsert = args;
      return { id: "cred_email", ...args.create };
    });
    mockPrismaMethod("automationPreference", "upsert", async () => makePreference({ metadata: {} }));
    mockPrismaMethod("automationPreference", "update", async (args: any) => {
      preferenceUpdate = args;
      return { ...makePreference(), ...args.data };
    });

    await connectMerchantEmailChannel({ merchantId: "merchant_1", businessEmail: "Care@Merchant.Example" });
    await setMerchantEmailFallback({ merchantId: "merchant_1", fallbackAllowed: true });

    assert.equal(credentialUpsert.create.merchantId, "merchant_1");
    assert.equal(credentialUpsert.create.metadata.businessEmail, "care@merchant.example");
    assert.equal("replyToEmail" in credentialUpsert.create.metadata, false);
    assert.equal("senderEmail" in credentialUpsert.create.metadata, false);
    assert.equal(JSON.stringify(credentialUpsert).includes("password"), false);
    assert.equal(preferenceUpdate.where.merchantId, "merchant_1");
    assert.equal(preferenceUpdate.data.metadata.abandonedCheckoutFallbackSenderAllowed, true);
  });

  it("logs explicit channel tests with sender and reply-to using the same effective email", async () => {
    const event = makeEvent({ id: "evt_channel", eventKey: "merchant.channel_test" });
    const logs: any[] = [];
    const usage: any[] = [];
    mockPrismaMethod("automationPreference", "upsert", async () => makePreference({
      metadata: { abandonedCheckoutFallbackSenderAllowed: true }
    }));
    mockPrismaMethod("merchantChannelCredential", "findMany", async () => []);
    mockPrismaMethod("merchantChannelCredential", "findFirst", async () => null);
    mockPrismaMethod("communicationLog", "findFirst", async ({ where }: any) =>
      where.idempotencyKey ? logs.find((log) => log.idempotencyKey === where.idempotencyKey) || null : null
    );
    mockPrismaMethod("communicationLog", "create", async ({ data }: any) => {
      const log = { id: `log_${logs.length + 1}`, createdAt: now, updatedAt: now, ...data };
      logs.push(log);
      return log;
    });
    mockPrismaMethod("merchant", "findUnique", async () => ({
      id: "merchant_1",
      name: "Urban Saree Co",
      email: "seller@example.com",
      phone: "+919999999999"
    }));
    mockPrismaMethod("automationEvent", "upsert", async ({ create }: any) => ({ ...event, ...create, id: "evt_channel" }));
    mockPrismaMethod("automationEvent", "update", async ({ data }: any) => ({ ...event, ...data }));
    mockPrismaMethod("automationFrequencyLedger", "upsert", async () => ({ id: "ledger_1" }));
    mockPrismaMethod("automationUsageMeter", "upsert", async (args: any) => {
      usage.push(args);
      return args.create;
    });

    const result = await runMerchantChannelTest({ merchantId: "merchant_1", channel: "EMAIL" });

    assert.equal(result.communication.channel, "EMAIL");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].templateKey, "channel_test_v1");
    assert.equal(logs[0].metadata.sender, "noreply@shipmastr.com");
    assert.equal(logs[0].metadata.replyTo, "noreply@shipmastr.com");
    assert.equal(usage.filter((item) => item.create.usageType === "MESSAGE_SENT").length, 1);
  });

  it("blocks abandoned checkout channels for buyer opt-out, quiet hours, and frequency caps", async () => {
    const abandoned = buildAbandonedCheckoutAutomationEvent({
      merchantId: "merchant_1",
      cartId: "cart_4",
      buyerEmail: "buyer@example.com",
      emailMarketingConsent: true,
      whatsappMarketingConsent: false,
      preferredChannels: ["EMAIL"]
    });

    const optOutState = installDispatchMocks({
      event: makeEvent({ eventKey: abandoned.eventKey, idempotencyKey: abandoned.idempotencyKey, payload: abandoned.payload }),
      preference: makePreference({ marketingEnabled: true, metadata: { abandonedCheckoutEnabled: true } }),
      workflow: makeWorkflow({ key: "SM_20_ABANDONED_CHECKOUT", channelOrder: ["EMAIL"], frequencyCap: 1, quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")],
      optOut: { id: "optout_1" }
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("opt-out dispatch should not run");
    });
    const optOutResult = await dispatchAutomationEvent("evt_1");
    assert.equal(optOutResult.status, "CANCELLED");
    assert.equal(optOutState.updates.at(-1).dispatchResult.reason, "NO_ABANDONED_CHECKOUT_CHANNELS_ALLOWED");
    assert.equal(optOutState.logs[0].metadata.skipReason, "RECIPIENT_OPTED_OUT");

    while (restorers.length) restorers.pop()?.();
    mock.restoreAll();

    const quietState = installDispatchMocks({
      event: makeEvent({ eventKey: abandoned.eventKey, idempotencyKey: abandoned.idempotencyKey, payload: abandoned.payload }),
      preference: makePreference({
        marketingEnabled: true,
        quietHoursStart: "00:00",
        quietHoursEnd: "23:59",
        metadata: { abandonedCheckoutEnabled: true }
      }),
      workflow: makeWorkflow({ key: "SM_20_ABANDONED_CHECKOUT", channelOrder: ["EMAIL"], frequencyCap: 1, quietHoursMode: "respect" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("quiet-hours dispatch should not run");
    });
    const quietResult = await dispatchAutomationEvent("evt_1");
    assert.equal(quietResult.status, "QUEUED");
    assert.equal(quietState.updates.at(-1).dispatchResult.reason, "QUIET_HOURS");

    while (restorers.length) restorers.pop()?.();
    mock.restoreAll();

    const frequencyState = installDispatchMocks({
      event: makeEvent({ eventKey: abandoned.eventKey, idempotencyKey: abandoned.idempotencyKey, payload: abandoned.payload }),
      preference: makePreference({ marketingEnabled: true, metadata: { abandonedCheckoutEnabled: true } }),
      workflow: makeWorkflow({ key: "SM_20_ABANDONED_CHECKOUT", channelOrder: ["EMAIL"], frequencyCap: 1, quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")],
      frequencyLedger: { id: "ledger_1", count: 1 }
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("frequency-capped dispatch should not run");
    });
    const frequencyResult = await dispatchAutomationEvent("evt_1");
    assert.equal(frequencyResult.status, "CANCELLED");
    assert.equal(frequencyState.logs[0].metadata.skipReason, "ABANDONED_CHECKOUT_FREQUENCY_CAP_REACHED");
  });

  it("builds seller-safe repeat buyer events without raw intelligence or provider secrets", () => {
    const event = buildRepeatBuyerAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      storeName: "Urban Saree Co",
      buyerId: "buyer_1",
      buyerName: "Preview Buyer",
      buyerEmail: "buyer@example.com",
      buyerPhone: "+919999999999",
      emailMarketingConsent: true,
      whatsappMarketingConsent: true,
      lastOrderId: "order_1",
      lastOrderDate: "2026-04-01T10:00:00.000Z",
      daysSinceLastOrder: 45,
      lastPurchasedCategories: ["Sarees", "Blouses", "Accessories"],
      suggestedProducts: [
        { id: "prod_1", title: "Fresh edit", url: "https://merchant.example/products/fresh-edit" }
      ],
      recommendedOffer: "New collection preview",
      storeUrl: "https://merchant.example/",
      preferredChannels: ["EMAIL", "WHATSAPP"],
      windowDate: "2026-05-16"
    });

    assert.equal(buildRepeatBuyerSubject("Urban Saree Co"), "New picks from Urban Saree Co");
    assert.equal(event.eventKey, "buyer.repeat_purchase_due");
    assert.equal(event.source, "repeat-buyer");
    assert.equal(event.sourceId, "buyer_1");
    assert.equal(event.idempotencyKey, "repeat-buyer:merchant_1:buyer_1:2026-05-16");
    assert.equal((event.payload as any).email.subject, "New picks from Urban Saree Co");
    assert.equal((event.payload as any).buyerContact.email, "buyer@example.com");
    assert.equal((event.payload as any).buyerContact.phone, "+919999999999");
    assert.equal((event.payload as any).lastOrderId, "order_1");
    assert.equal((event.payload as any).daysSinceLastOrder, 45);
    const serialized = JSON.stringify(event.payload);
    for (const forbidden of [
      "credentialRef",
      "secret",
      "token",
      "password",
      "smtp",
      "webhookId",
      "buyerScore",
      "buyerSegmentScore",
      "rawBuyerFeatures",
      "model"
    ]) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `${forbidden} leaked in repeat buyer payload`);
    }
  });

  it("dispatches repeat buyer recovery through verified merchant email and WhatsApp channels", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_21_REPEAT_BUYER: "https://workflow.internal.example/autopilot/repeat-buyer"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const repeatBuyer = buildRepeatBuyerAutomationEvent({
      merchantId: "merchant_1",
      storeName: "Urban Saree Co",
      buyerId: "buyer_1",
      buyerEmail: "buyer@example.com",
      buyerPhone: "+919999999999",
      emailMarketingConsent: true,
      whatsappMarketingConsent: true,
      lastOrderId: "order_1",
      lastOrderDate: "2026-04-01T10:00:00.000Z",
      daysSinceLastOrder: 45,
      storeUrl: "https://merchant.example/"
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({
        eventKey: repeatBuyer.eventKey,
        idempotencyKey: repeatBuyer.idempotencyKey,
        payload: repeatBuyer.payload
      }),
      preference: makePreference({
        marketingEnabled: true,
        metadata: {
          repeatBuyerEnabled: true,
          repeatBuyerEmailEnabled: true,
          repeatBuyerWhatsappEnabled: true,
          repeatBuyerWindowDays: 30,
          maxRepeatBuyerMessagesPerBuyerPerMonth: 1
        }
      }),
      workflow: makeWorkflow({
        key: "SM_21_REPEAT_BUYER",
        channelOrder: ["EMAIL", "WHATSAPP"],
        frequencyCap: 1,
        quietHoursMode: "ignore_internal_only"
      }),
      channelCredentials: [
        makeChannelCredential("EMAIL"),
        makeChannelCredential("WHATSAPP")
      ]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    assert.equal(requests[0]?.url, "https://workflow.internal.example/autopilot/repeat-buyer");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.workflowKey, "SM_21_REPEAT_BUYER");
    assert.equal(body.automationType, "marketing");
    assert.equal(body.event.payload.channelPlan.emailEnabled, true);
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, true);
    assert.equal(body.event.payload.channelPlan.emailSender, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.replyTo, "care@merchant.example");
    assert.equal(body.event.payload.channelPlan.whatsappTemplateName, "repeat_buyer_v1");
    assert.equal(body.event.payload.email.subject, "New picks from Urban Saree Co");
    const serializedBody = JSON.stringify(body);
    assert.equal(serializedBody.includes("secret_ref_email_must_not_dispatch"), false);
    assert.equal(serializedBody.includes("secret_ref_whatsapp_must_not_dispatch"), false);
    assert.equal(serializedBody.includes("credentialRef"), false);
    assert.equal(state.usage[0].create.usageType, "N8N_EXECUTION");
    assert.equal(state.usage[0].create.workflowKey, "SM_21_REPEAT_BUYER");
  });

  it("gates repeat buyer recovery by preference, order window, opt-out, quiet hours, and monthly frequency", async () => {
    const repeatBuyer = buildRepeatBuyerAutomationEvent({
      merchantId: "merchant_1",
      storeName: "Urban Saree Co",
      buyerId: "buyer_1",
      buyerEmail: "buyer@example.com",
      buyerPhone: "+919999999999",
      emailMarketingConsent: true,
      whatsappMarketingConsent: false,
      lastOrderId: "order_1",
      lastOrderDate: "2026-04-01T10:00:00.000Z",
      daysSinceLastOrder: 45,
      preferredChannels: ["EMAIL"]
    });

    const disabledState = installDispatchMocks({
      event: makeEvent({ eventKey: repeatBuyer.eventKey, idempotencyKey: repeatBuyer.idempotencyKey, payload: repeatBuyer.payload }),
      preference: makePreference({ marketingEnabled: true, metadata: { repeatBuyerEnabled: false } }),
      workflow: makeWorkflow({ key: "SM_21_REPEAT_BUYER", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("disabled repeat buyer dispatch should not run");
    });
    const disabledResult = await dispatchAutomationEvent("evt_1");
    assert.equal(disabledResult.status, "CANCELLED");
    assert.equal(disabledState.updates.at(-1).dispatchResult.reason, "REPEAT_BUYER_DISABLED");

    while (restorers.length) restorers.pop()?.();
    mock.restoreAll();

    const recent = buildRepeatBuyerAutomationEvent({
      merchantId: "merchant_1",
      buyerId: "buyer_1",
      buyerEmail: "buyer@example.com",
      emailMarketingConsent: true,
      whatsappMarketingConsent: false,
      lastOrderId: "order_1",
      lastOrderDate: "2026-05-01T10:00:00.000Z",
      daysSinceLastOrder: 10,
      preferredChannels: ["EMAIL"]
    });
    const recentState = installDispatchMocks({
      event: makeEvent({ eventKey: recent.eventKey, idempotencyKey: recent.idempotencyKey, payload: recent.payload }),
      preference: makePreference({ marketingEnabled: true, metadata: { repeatBuyerEnabled: true, repeatBuyerWindowDays: 30 } }),
      workflow: makeWorkflow({ key: "SM_21_REPEAT_BUYER", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("recent repeat buyer dispatch should not run");
    });
    const recentResult = await dispatchAutomationEvent("evt_1");
    assert.equal(recentResult.status, "CANCELLED");
    assert.equal(recentState.updates.at(-1).dispatchResult.reason, "REPEAT_BUYER_WINDOW_NOT_REACHED");

    while (restorers.length) restorers.pop()?.();
    mock.restoreAll();

    const optOutState = installDispatchMocks({
      event: makeEvent({ eventKey: repeatBuyer.eventKey, idempotencyKey: repeatBuyer.idempotencyKey, payload: repeatBuyer.payload }),
      preference: makePreference({ marketingEnabled: true, metadata: { repeatBuyerEnabled: true, repeatBuyerWindowDays: 30 } }),
      workflow: makeWorkflow({ key: "SM_21_REPEAT_BUYER", channelOrder: ["EMAIL"], frequencyCap: 1, quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")],
      optOut: { id: "optout_1" }
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("repeat buyer opt-out dispatch should not run");
    });
    const optOutResult = await dispatchAutomationEvent("evt_1");
    assert.equal(optOutResult.status, "CANCELLED");
    assert.equal(optOutState.logs[0].metadata.skipReason, "RECIPIENT_OPTED_OUT");

    while (restorers.length) restorers.pop()?.();
    mock.restoreAll();

    const quietState = installDispatchMocks({
      event: makeEvent({ eventKey: repeatBuyer.eventKey, idempotencyKey: repeatBuyer.idempotencyKey, payload: repeatBuyer.payload }),
      preference: makePreference({
        marketingEnabled: true,
        quietHoursStart: "00:00",
        quietHoursEnd: "23:59",
        metadata: { repeatBuyerEnabled: true, repeatBuyerWindowDays: 30 }
      }),
      workflow: makeWorkflow({ key: "SM_21_REPEAT_BUYER", channelOrder: ["EMAIL"], frequencyCap: 1, quietHoursMode: "respect" }),
      channelCredentials: [makeChannelCredential("EMAIL")]
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("repeat buyer quiet-hours dispatch should not run");
    });
    const quietResult = await dispatchAutomationEvent("evt_1");
    assert.equal(quietResult.status, "QUEUED");
    assert.equal(quietState.updates.at(-1).dispatchResult.reason, "QUIET_HOURS");

    while (restorers.length) restorers.pop()?.();
    mock.restoreAll();

    const frequencyState = installDispatchMocks({
      event: makeEvent({ eventKey: repeatBuyer.eventKey, idempotencyKey: repeatBuyer.idempotencyKey, payload: repeatBuyer.payload }),
      preference: makePreference({ marketingEnabled: true, metadata: { repeatBuyerEnabled: true, repeatBuyerWindowDays: 30 } }),
      workflow: makeWorkflow({ key: "SM_21_REPEAT_BUYER", channelOrder: ["EMAIL"], frequencyCap: 1, quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [makeChannelCredential("EMAIL")],
      frequencyLedger: { id: "ledger_1", count: 1 }
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("repeat buyer frequency-capped dispatch should not run");
    });
    const frequencyResult = await dispatchAutomationEvent("evt_1");
    assert.equal(frequencyResult.status, "CANCELLED");
    assert.equal(frequencyState.logs[0].metadata.skipReason, "REPEAT_BUYER_FREQUENCY_CAP_REACHED");
  });

  it("uses repeat buyer fallback email only when allowed and skips unapproved WhatsApp templates", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_21_REPEAT_BUYER: "https://workflow.internal.example/autopilot/repeat-buyer"
    });

    const repeatBuyer = buildRepeatBuyerAutomationEvent({
      merchantId: "merchant_1",
      storeName: "Urban Saree Co",
      buyerId: "buyer_1",
      buyerEmail: "buyer@example.com",
      buyerPhone: "+919999999999",
      emailMarketingConsent: true,
      whatsappMarketingConsent: true,
      lastOrderId: "order_1",
      lastOrderDate: "2026-04-01T10:00:00.000Z",
      daysSinceLastOrder: 45,
      preferredChannels: ["EMAIL", "WHATSAPP"]
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const state = installDispatchMocks({
      event: makeEvent({ eventKey: repeatBuyer.eventKey, idempotencyKey: repeatBuyer.idempotencyKey, payload: repeatBuyer.payload }),
      preference: makePreference({
        marketingEnabled: true,
        metadata: {
          repeatBuyerEnabled: true,
          repeatBuyerFallbackSenderAllowed: true,
          repeatBuyerWindowDays: 30
        }
      }),
      workflow: makeWorkflow({ key: "SM_21_REPEAT_BUYER", channelOrder: ["EMAIL", "WHATSAPP"], frequencyCap: 1, quietHoursMode: "ignore_internal_only" }),
      channelCredentials: [
        makeChannelCredential("WHATSAPP", {
          metadata: {
            whatsappBusinessNumber: "+919876543210",
            templateStatuses: { repeatBuyer: "PENDING" }
          }
        })
      ]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    const body = JSON.parse(String(requests[0]?.init.body));
    assert.equal(body.event.payload.channelPlan.emailEnabled, true);
    assert.equal(body.event.payload.channelPlan.emailSender, "noreply@shipmastr.com");
    assert.equal(body.event.payload.channelPlan.replyTo, "noreply@shipmastr.com");
    assert.equal(body.event.payload.channelPlan.whatsappEnabled, false);
    assert.equal(body.event.payload.channelPlan.skippedChannelReasons[0].reason, "WHATSAPP_REPEAT_BUYER_TEMPLATE_NOT_APPROVED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "SKIPPED");
    assert.equal(state.logs[0].templateKey, "repeat_buyer_v1");
  });

  it("requires a previous delivered order and configured repeat window for repeat buyer smoke", async () => {
    mockPrismaMethod("merchant", "findUnique", async () => ({
      id: "merchant_1",
      name: "Urban Saree Co",
      email: "seller@example.com",
      phone: "+919999999999"
    }));
    mockPrismaMethod("automationPreference", "upsert", async () => makePreference({
      metadata: { repeatBuyerEnabled: true, repeatBuyerWindowDays: 45 }
    }));
    let orderRecord: any = null;
    mockPrismaMethod("order", "findFirst", async () => orderRecord);

    await assert.rejects(
      () => runRepeatBuyerSmoke({ merchantId: "merchant_1", buyerPhone: "+919999999999" }),
      /REPEAT_BUYER_PREVIOUS_DELIVERED_ORDER_REQUIRED/
    );

    orderRecord = {
      id: "order_1",
      externalOrderId: "EXT-1",
      merchantId: "merchant_1",
      buyerPhone: "+919999999999",
      status: "DELIVERED",
      createdAt: new Date("2026-05-01T10:00:00.000Z")
    };

    await assert.rejects(
      () => runRepeatBuyerSmoke({
        merchantId: "merchant_1",
        lastOrderId: "order_1",
        buyerPhone: "+919999999999",
        lastOrderDate: "2026-05-01T10:00:00.000Z",
        daysSinceLastOrder: 10
      }),
      /REPEAT_BUYER_WINDOW_NOT_REACHED/
    );
  });

  it("cancels COD Shield workflows when the merchant disables COD Shield", async () => {
    const { updates } = installDispatchMocks({
      event: makeEvent({
        eventKey: "order.cod_risk_high",
        payload: { orderId: "order_1", buyerContact: { phone: "+919999999999" } }
      }),
      preference: makePreference({ codShieldEnabled: false }),
      workflow: makeWorkflow({ key: "SM_COD_RISK_HIGH" })
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("cod shield dispatch should not run when COD Shield is disabled");
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(updates.at(-1).dispatchResult.reason, "COD_SHIELD_DISABLED");
    assert.equal(updates.at(-1).dispatchResult.automationType, "transactional");
  });

  it("cancels NDR Rescue workflows when the merchant disables NDR Rescue", async () => {
    const { updates } = installDispatchMocks({
      event: makeEvent({
        eventKey: "shipment.ndr_created",
        idempotencyKey: "shipment.ndr_created:order_1:shipment_1:awb_1:ndr_1",
        payload: {
          orderId: "order_1",
          shipmentId: "shipment_1",
          awb: "awb_1",
          buyerContact: { phone: "+919999999999" },
          ndrReason: "CUSTOMER_NOT_REACHABLE"
        }
      }),
      preference: makePreference({ ndrRescueEnabled: false }),
      workflow: makeWorkflow({ key: "SM_14_NDR_RECOVERY" })
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("NDR Rescue dispatch should not run when NDR Rescue is disabled");
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(updates.at(-1).dispatchResult.reason, "NDR_RESCUE_DISABLED");
    assert.equal(updates.at(-1).dispatchResult.automationType, "transactional");
  });

  it("cancels Merchant Daily Digest when merchant email notifications are disabled", async () => {
    const { updates } = installDispatchMocks({
      event: makeEvent({
        eventKey: "merchant.daily_digest",
        idempotencyKey: "merchant-daily-digest:merchant_1:2026-05-16",
        payload: {
          merchantName: "Urban Saree Co",
          merchantEmail: "seller@example.com",
          digestDate: "2026-05-16",
          summary: {},
          email: {
            from: "noreply@shipmastr.com",
            to: "seller@example.com",
            subject: "Urban Saree Co Daily Summary 16 May 2026"
          }
        }
      }),
      preference: makePreference({ emailEnabled: false }),
      workflow: makeWorkflow({ key: "SM_60_MERCHANT_DAILY_DIGEST", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" })
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("daily digest dispatch should not run when email is disabled");
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "CANCELLED");
    assert.equal(updates.at(-1).dispatchResult.reason, "DIGEST_EMAIL_DISABLED");
    assert.equal(updates.at(-1).dispatchResult.channel, "EMAIL");
  });

  it("dispatches to n8n with signed env-driven requests and usage metering", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_DISPATCH_URL = "https://workflow.internal.example/autopilot/dispatch";
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";
    (env as any).N8N_AUTOPILOT_TIMEOUT_MS = 3000;

    const requests: Array<{ url: string; init: RequestInit }> = [];
    const { updates, usage } = installDispatchMocks();
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    const request = requests[0];
    assert.ok(request);
    const headers = request.init.headers as Record<string, string>;
    assert.equal(request.url, "https://workflow.internal.example/autopilot/dispatch");
    assert.equal(headers["X-Shipmastr-Task-Secret"], env.SHIPMASTR_INTERNAL_SECRET || env.WEBHOOK_SECRET);
    assert.ok(headers["X-Shipmastr-Signature"]);
    assert.ok(headers["X-Shipmastr-Timestamp"]);
    assert.equal(JSON.parse(String(request.init.body)).automationType, "transactional");
    assert.equal(usage[0].create.usageType, "N8N_EXECUTION");
    assert.equal(usage[0].create.merchantId, "merchant_1");
    assert.equal(updates.some((update) => update.status === "PROCESSING"), true);
    assert.equal(updates.some((update) => update.status === "DISPATCHED"), true);
  });

  it("dispatches COD Shield workflows to their mapped n8n webhook URLs", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_DISPATCH_URL = "https://workflow.internal.example/autopilot/order-created";
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_COD_RISK_HIGH: "https://workflow.internal.example/autopilot/cod-risk-high"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const requests: Array<{ url: string; init: RequestInit }> = [];
    const { usage } = installDispatchMocks({
      event: makeEvent({
        eventKey: "order.cod_risk_high",
        idempotencyKey: "order.cod_risk_high:order_1",
        payload: {
          orderId: "order_1",
          buyerContact: { phone: "+919999999999" },
          riskTier: "MEDIUM",
          sellerSafeRiskSummary: ["COD verification is required."],
          recommendedAction: "Confirm buyer intent before shipping."
        }
      }),
      workflow: makeWorkflow({ key: "SM_COD_RISK_HIGH" }),
      channelCredentials: [
        makeChannelCredential("WHATSAPP", {
          provider: "whatsapp:merchant-smoke",
          metadata: {
            whatsappBusinessNumber: "+919876543210",
            providerMode: "smoke",
            templateStatuses: { codRisk: "NOT_CONFIGURED" }
          }
        })
      ]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, "https://workflow.internal.example/autopilot/cod-risk-high");
    assert.equal(JSON.parse(String(request.init.body)).workflowKey, "SM_COD_RISK_HIGH");
    assert.equal(usage[0].create.workflowKey, "SM_COD_RISK_HIGH");
  });

  it("dispatches NDR Rescue workflows to their mapped n8n webhook URLs", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_DISPATCH_URL = "https://workflow.internal.example/autopilot/order-created";
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_14_NDR_RECOVERY: "https://workflow.internal.example/autopilot/ndr-recovery"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const requests: Array<{ url: string; init: RequestInit }> = [];
    const { usage } = installDispatchMocks({
      event: makeEvent({
        eventKey: "shipment.ndr_created",
        idempotencyKey: "shipment.ndr_created:order_1:shipment_1:awb_1:ndr_1",
        payload: {
          orderId: "order_1",
          shipmentId: "shipment_1",
          awb: "awb_1",
          buyerContact: { phone: "+919999999999" },
          ndrReason: "CUSTOMER_NOT_REACHABLE",
          attemptCount: 1,
          recommendedActions: ["reattempt_today", "reattempt_tomorrow", "update_address", "cancel_or_manual_review"]
        }
      }),
      workflow: makeWorkflow({ key: "SM_14_NDR_RECOVERY" }),
      channelCredentials: [
        makeChannelCredential("WHATSAPP", {
          provider: "whatsapp:merchant-smoke",
          metadata: {
            whatsappBusinessNumber: "+919876543210",
            providerMode: "smoke",
            templateStatuses: { ndrRecovery: "NOT_CONFIGURED" }
          }
        })
      ]
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, "https://workflow.internal.example/autopilot/ndr-recovery");
    const body = JSON.parse(String(request.init.body));
    assert.equal(body.workflowKey, "SM_14_NDR_RECOVERY");
    assert.equal(body.permissionScope, "automation:merchant:ndr-rescue");
    assert.equal(body.automationType, "transactional");
    assert.equal(usage[0].create.workflowKey, "SM_14_NDR_RECOVERY");
  });

  it("dispatches Merchant Daily Digest workflows as transactional email to mapped n8n webhook URLs", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_DISPATCH_URL = "https://workflow.internal.example/autopilot/order-created";
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = JSON.stringify({
      SM_60_MERCHANT_DAILY_DIGEST: "https://workflow.internal.example/autopilot/merchant-daily-digest"
    });
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";

    const requests: Array<{ url: string; init: RequestInit }> = [];
    const { usage } = installDispatchMocks({
      event: makeEvent({
        eventKey: "merchant.daily_digest",
        idempotencyKey: "merchant-daily-digest:merchant_1:2026-05-16",
        payload: {
          merchantName: "Urban Saree Co",
          merchantEmail: "seller@example.com",
          digestDate: "2026-05-16",
          summary: { ordersReceived: 4, recommendedActions: ["Review high-risk COD orders before pickup."] },
          email: {
            from: "noreply@shipmastr.com",
            to: "seller@example.com",
            subject: "Urban Saree Co Daily Summary 16 May 2026"
          }
        }
      }),
      workflow: makeWorkflow({ key: "SM_60_MERCHANT_DAILY_DIGEST", channelOrder: ["EMAIL"], quietHoursMode: "ignore_internal_only" })
    });
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "DISPATCHED");
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, "https://workflow.internal.example/autopilot/merchant-daily-digest");
    const body = JSON.parse(String(request.init.body));
    assert.equal(body.workflowKey, "SM_60_MERCHANT_DAILY_DIGEST");
    assert.equal(body.permissionScope, "automation:merchant:reporting");
    assert.equal(body.automationType, "transactional");
    assert.equal(body.event.payload.email.from, "noreply@shipmastr.com");
    assert.equal(body.event.payload.email.subject, "Urban Saree Co Daily Summary 16 May 2026");
    assert.equal(usage[0].create.workflowKey, "SM_60_MERCHANT_DAILY_DIGEST");
    assert.equal(usage[0].create.channel, "EMAIL");
  });

  it("fails retryably when the per-workflow n8n URL map is invalid", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_DISPATCH_URL = "https://workflow.internal.example/autopilot/order-created";
    (env as any).N8N_AUTOPILOT_WORKFLOW_URLS = "{not-json";

    const { updates, audits } = installDispatchMocks({
      event: makeEvent({
        eventKey: "order.cod_risk_high",
        payload: {
          orderId: "order_1",
          buyerContact: { phone: "+919999999999" },
          riskTier: "MEDIUM",
          sellerSafeRiskSummary: ["COD verification is required."],
          recommendedAction: "Confirm buyer intent before shipping."
        }
      }),
      workflow: makeWorkflow({ key: "SM_COD_RISK_HIGH" }),
      channelCredentials: [
        makeChannelCredential("WHATSAPP", {
          provider: "whatsapp:merchant-smoke",
          metadata: {
            whatsappBusinessNumber: "+919876543210",
            providerMode: "smoke"
          }
        })
      ]
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not run when workflow URL config is invalid");
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "FAILED");
    assert.equal(updates.at(-1).error, "N8N_AUTOPILOT_WORKFLOW_URLS_INVALID_JSON");
    assert.ok(updates.at(-1).nextAttemptAt instanceof Date);
    assert.equal(audits.at(-1).action, "automation.dispatch_config_failed");
  });

  it("does not overwrite a completed callback when n8n responds after callback", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = true;
    (env as any).N8N_AUTOPILOT_DISPATCH_URL = "https://workflow.internal.example/autopilot/dispatch";
    (env as any).N8N_AUTOPILOT_SIGNING_SECRET = "n8n-signing-secret-for-autopilot-tests";
    (env as any).N8N_AUTOPILOT_TIMEOUT_MS = 3000;

    const { event, updates } = installDispatchMocks();
    mock.method(globalThis, "fetch", async () => {
      event.status = "PROCESSED";
      return new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "PROCESSED");
    assert.equal(updates.some((update) => update.status === "PROCESSING"), true);
    assert.equal(updates.some((update) => update.status === "DISPATCHED"), false);
    assert.ok(updates.at(-1).dispatchResult);
  });

  it("keeps dispatch queued when N8N_AUTOPILOT_ENABLED is false", async () => {
    (env as any).N8N_AUTOPILOT_ENABLED = false;
    (env as any).N8N_AUTOPILOT_DISPATCH_URL = undefined;
    const { audits } = installDispatchMocks();
    mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not run while n8n dispatch is disabled");
    });

    const result = await dispatchAutomationEvent("evt_1");

    assert.equal(result.status, "QUEUED");
    assert.equal((result.dispatchResult as any).mode, "n8n_disabled");
    assert.equal(audits.at(-1).action, "automation.dispatch_skipped");
  });

  it("validates Autopilot callback signatures", () => {
    const body = JSON.stringify({ eventId: "evt_1", status: "PROCESSED" });
    const timestamp = new Date().toISOString();
    const signature = createAutomationSignature(body, timestamp);

    assert.equal(verifyAutomationSignature({ body, timestamp, signature }), true);
    assert.equal(verifyAutomationSignature({ body, timestamp, signature: "00" }), false);
  });

  it("processes a successful callback and creates a communication log", async () => {
    const { updates, logs } = installCallbackMocks();

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      status: "PROCESSED",
      result: { accepted: true },
      communication: {
        merchantId: "merchant_1",
        channel: "WHATSAPP",
        recipient: "+919999999999",
        templateKey: "order_created",
        provider: "mock",
        providerMessageId: "provider_msg_1",
        status: "SENT"
      }
    });

    assert.equal(result.event.status, "PROCESSED");
    assert.equal(updates.at(-1).status, "PROCESSED");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].idempotencyKey, "provider:mock:provider_msg_1");
    assert.equal(logs[0].metadata.eventKey, "order.created");
  });

  it("records COD Shield buyer action metadata from callback communication", async () => {
    const { logs } = installCallbackMocks({
      event: makeEvent({
        eventKey: "order.address_confirmation_required",
        status: "DISPATCHED",
        attempts: 1
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      status: "PROCESSED",
      result: { accepted: true },
      communication: {
        merchantId: "merchant_1",
        channel: "WHATSAPP",
        recipient: "+919999999999",
        templateKey: "address_confirmation",
        provider: "smoke",
        providerMessageId: "address_msg_1",
        status: "SENT",
        metadata: {
          buyerAction: "ADDRESS_CONFIRMATION_REQUESTED"
        }
      }
    });

    assert.equal(result.event.status, "PROCESSED");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].templateKey, "address_confirmation_v1");
    assert.equal(logs[0].metadata.eventKey, "order.address_confirmation_required");
    assert.equal(logs[0].metadata.workflowKey, "SM_ADDRESS_CONFIRMATION");
    assert.equal(logs[0].metadata.buyerAction, "ADDRESS_CONFIRMATION_REQUESTED");
  });

  it("normalizes legacy COD Shield callback template keys to versioned keys", async () => {
    const { logs } = installCallbackMocks({
      event: makeEvent({
        eventKey: "order.cod_risk_high",
        status: "DISPATCHED",
        attempts: 1
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      status: "PROCESSED",
      result: { accepted: true },
      communication: {
        merchantId: "merchant_1",
        channel: "WHATSAPP",
        recipient: "+919999999999",
        templateKey: "cod_risk_high",
        provider: "smoke",
        providerMessageId: "cod_msg_1",
        status: "SENT"
      }
    });

    assert.equal(result.event.status, "PROCESSED");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].templateKey, "cod_risk_high_v1");
    assert.equal(logs[0].metadata.eventKey, "order.cod_risk_high");
    assert.equal(logs[0].metadata.workflowKey, "SM_COD_RISK_HIGH");
  });

  it("processes NDR Rescue callbacks with versioned template keys and courier instruction metadata", async () => {
    const { logs } = installCallbackMocks({
      event: makeEvent({
        eventKey: "shipment.ndr_created",
        status: "DISPATCHED",
        attempts: 1
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      status: "PROCESSED",
      result: {
        workflowKey: "SM_14_NDR_RECOVERY",
        accepted: true,
        courierInstructionStatus: "smoke_sent"
      },
      communication: {
        merchantId: "merchant_1",
        channel: "WHATSAPP",
        recipient: "+919999999999",
        templateKey: "ndr_recovery_v1",
        provider: "smoke",
        providerMessageId: "ndr_msg_1",
        status: "SENT",
        metadata: {
          buyerAction: "NDR_REATTEMPT_OPTIONS_SENT",
          courierInstructionStatus: "smoke_sent"
        }
      }
    });

    assert.equal(result.event.status, "PROCESSED");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].templateKey, "ndr_recovery_v1");
    assert.equal(logs[0].metadata.eventKey, "shipment.ndr_created");
    assert.equal(logs[0].metadata.workflowKey, "SM_14_NDR_RECOVERY");
    assert.equal(logs[0].metadata.buyerAction, "NDR_REATTEMPT_OPTIONS_SENT");
    assert.equal(logs[0].metadata.courierInstructionStatus, "smoke_sent");
  });

  it("keeps NDR Rescue duplicate callbacks idempotent and meters message usage once", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "shipment.ndr_created",
        status: "DISPATCHED",
        attempts: 1
      })
    });
    const callback = {
      eventId: "evt_1",
      status: "PROCESSED" as const,
      communication: {
        merchantId: "merchant_1",
        channel: "WHATSAPP",
        recipient: "+919999999999",
        templateKey: "ndr_recovery_v1",
        provider: "smoke",
        providerMessageId: "smoke_ndr_evt_1",
        status: "SENT",
        metadata: {
          courierInstructionStatus: "smoke_sent"
        }
      }
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.logs.length, 1);
    assert.equal(messageSentUsage.length, 1);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_14_NDR_RECOVERY");
    assert.equal(messageSentUsage[0].create.eventKey, "shipment.ndr_created");
  });

  it("verifies WhatsApp provider signatures", () => {
    (env as any).WHATSAPP_PROVIDER_WEBHOOK_SECRET = "whatsapp-provider-webhook-secret";
    const body = JSON.stringify({ providerMessageId: "wa_msg_1", status: "DELIVERED" });
    const signature = createAutomationTestHmac("whatsapp-provider-webhook-secret", body);

    assert.equal(verifyWhatsappProviderSignature({ body, signature }), true);
    assert.equal(verifyWhatsappProviderSignature({ body, signature: "0".repeat(64) }), false);
  });

  it("updates WhatsApp CommunicationLog delivery status from provider callback", async () => {
    const log = {
      id: "log_wa_1",
      merchantId: "merchant_1",
      eventId: "evt_1",
      channel: "WHATSAPP",
      recipient: "+919999999999",
      templateKey: "cod_risk_high_v1",
      status: "SENT",
      provider: "gupshup",
      providerMessageId: "wa_msg_1",
      metadata: { workflowKey: "SM_COD_RISK_HIGH" },
      sentAt: now,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      createdAt: now,
      updatedAt: now
    } as any;
    const audits: any[] = [];
    mockPrismaMethod("communicationLog", "findFirst", async () => log);
    mockPrismaMethod("communicationLog", "update", async ({ data }: any) => {
      Object.assign(log, data, { updatedAt: now });
      return { ...log };
    });
    mockPrismaMethod("automationOptOut", "upsert", async () => {
      throw new Error("opt-out should not be written for delivery callback");
    });
    mockPrismaMethod("auditLog", "create", async ({ data }: any) => {
      audits.push(data);
      return { id: "audit_wa_1", ...data };
    });

    const result = await handleWhatsappProviderCallback({
      providerMessageId: "wa_msg_1",
      merchantId: "merchant_1",
      provider: "gupshup",
      status: "DELIVERED",
      sender: "+919876543210",
      recipient: "+919999999999",
      templateKey: "cod_risk_high_v1",
      metadata: { conversationId: "conversation_1", rawToken: "must_not_persist" } as any
    });

    assert.equal(result.communication.status, "DELIVERED");
    assert.ok(result.communication.deliveredAt);
    assert.equal((result.communication.metadata as any).providerStatus, "DELIVERED");
    assert.equal(JSON.stringify(result.communication.metadata).includes("rawToken"), false);
    assert.equal(audits[0].action, "automation.whatsapp_provider_callback");
  });

  it("records buyer WhatsApp STOP opt-outs and rejects wrong merchant callbacks", async () => {
    const log = {
      id: "log_wa_2",
      merchantId: "merchant_1",
      channel: "WHATSAPP",
      recipient: "+919999999999",
      templateKey: "abandoned_checkout_v1",
      status: "SENT",
      provider: "gupshup",
      providerMessageId: "wa_msg_2",
      metadata: {},
      sentAt: now,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      createdAt: now,
      updatedAt: now
    } as any;
    let optOutArgs: any;
    mockPrismaMethod("communicationLog", "findFirst", async () => log);
    mockPrismaMethod("communicationLog", "update", async ({ data }: any) => ({ ...log, ...data }));
    mockPrismaMethod("automationOptOut", "upsert", async (args: any) => {
      optOutArgs = args;
      return { id: "opt_1", ...args.create };
    });
    mockPrismaMethod("auditLog", "create", async ({ data }: any) => ({ id: "audit_1", ...data }));

    await assert.rejects(
      () => handleWhatsappProviderCallback({
        providerMessageId: "wa_msg_2",
        merchantId: "merchant_2",
        status: "READ"
      }),
      /WHATSAPP_CALLBACK_MERCHANT_MISMATCH/
    );

    const result = await handleWhatsappProviderCallback({
      providerMessageId: "wa_msg_2",
      merchantId: "merchant_1",
      status: "READ",
      recipient: "+919999999999",
      buyerMessage: "STOP"
    });

    assert.equal(result.optOut?.channel, "WHATSAPP");
    assert.equal(optOutArgs.where.merchantId_channel_subject.merchantId, "merchant_1");
    assert.equal(optOutArgs.where.merchantId_channel_subject.channel, "WHATSAPP");
    assert.equal(optOutArgs.create.reason, "BUYER_OPT_OUT");
  });

  it("processes Merchant Daily Digest callbacks with email metadata and versioned template keys", async () => {
    const { logs } = installCallbackMocks({
      event: makeEvent({
        eventKey: "merchant.daily_digest",
        status: "DISPATCHED",
        attempts: 1
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      status: "PROCESSED",
      result: {
        workflowKey: "SM_60_MERCHANT_DAILY_DIGEST",
        digestDate: "2026-05-16"
      },
      communication: {
        merchantId: "merchant_1",
        channel: "EMAIL",
        recipient: "seller@example.com",
        templateKey: "merchant_daily_digest",
        provider: "smoke",
        providerMessageId: "digest_msg_1",
        status: "SENT",
        metadata: {
          from: "noreply@shipmastr.com",
          to: "seller@example.com",
          subject: "Urban Saree Co Daily Summary 16 May 2026",
          digestDate: "2026-05-16"
        }
      }
    });

    assert.equal(result.event.status, "PROCESSED");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].channel, "EMAIL");
    assert.equal(logs[0].templateKey, "merchant_daily_digest_v1");
    assert.equal(logs[0].metadata.eventKey, "merchant.daily_digest");
    assert.equal(logs[0].metadata.workflowKey, "SM_60_MERCHANT_DAILY_DIGEST");
    assert.equal(logs[0].metadata.from, "noreply@shipmastr.com");
    assert.equal(logs[0].metadata.to, "seller@example.com");
    assert.equal(logs[0].metadata.subject, "Urban Saree Co Daily Summary 16 May 2026");
    assert.equal(logs[0].metadata.digestDate, "2026-05-16");
  });

  it("keeps Merchant Daily Digest duplicate callbacks idempotent and meters email usage once", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "merchant.daily_digest",
        status: "DISPATCHED",
        attempts: 1
      })
    });
    const callback = {
      eventId: "evt_1",
      status: "PROCESSED" as const,
      communication: {
        merchantId: "merchant_1",
        channel: "EMAIL",
        recipient: "seller@example.com",
        templateKey: "merchant_daily_digest_v1",
        provider: "smoke",
        providerMessageId: "smoke_digest_evt_1",
        status: "SENT",
        metadata: {
          from: "noreply@shipmastr.com",
          subject: "Urban Saree Co Daily Summary 16 May 2026",
          digestDate: "2026-05-16"
        }
      }
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.logs.length, 1);
    assert.equal(messageSentUsage.length, 1);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_60_MERCHANT_DAILY_DIGEST");
    assert.equal(messageSentUsage[0].create.eventKey, "merchant.daily_digest");
    assert.equal(messageSentUsage[0].create.channel, "EMAIL");
  });

  it("processes abandoned checkout multi-channel callback results once per channel", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "cart.abandoned",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          cartId: "cart_1",
          checkoutId: "checkout_1",
          recoveryUrl: "https://merchant.example/recover/cart_1"
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      result: { workflowKey: "SM_20_ABANDONED_CHECKOUT", accepted: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "merchant-smtp",
          providerMessageId: "email_cart_1",
          sender: "care@merchant.example",
          recipient: "b***@example.com",
          status: "sent"
        },
        {
          channel: "WHATSAPP",
          provider: "smoke",
          providerMessageId: "wa_cart_1",
          sender: "******3210",
          recipient: "******9999",
          status: "sent"
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs[0].templateKey, "abandoned_checkout_v1");
    assert.equal(state.logs[1].templateKey, "abandoned_checkout_v1");
    assert.deepEqual(state.logs.map((log) => log.channel).sort(), ["EMAIL", "WHATSAPP"]);
    assert.equal(messageSentUsage.length, 2);
    assert.equal(messageSentUsage.every((item) => item.create.workflowKey === "SM_20_ABANDONED_CHECKOUT"), true);
  });

  it("records abandoned checkout channel failures as retryable failed workflow callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "cart.abandoned",
        status: "DISPATCHED",
        attempts: 1,
        payload: { cartId: "cart_1" }
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "FAILED",
      error: "Provider rejected recovery email",
      result: { workflowKey: "SM_20_ABANDONED_CHECKOUT", retryable: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "merchant-smtp",
          providerMessageId: "email_failed_cart_1",
          sender: "care@merchant.example",
          recipient: "b***@example.com",
          status: "failed",
          error: "SMTP provider rejected message"
        }
      ]
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].templateKey, "abandoned_checkout_v1");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_20_ABANDONED_CHECKOUT");
  });

  it("processes repeat buyer multi-channel callback results once per channel", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "buyer.repeat_purchase_due",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          buyerId: "buyer_1",
          lastOrderId: "order_1",
          storeUrl: "https://merchant.example/"
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      result: { workflowKey: "SM_21_REPEAT_BUYER", accepted: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "merchant-smtp",
          providerMessageId: "email_repeat_buyer_1",
          sender: "care@merchant.example",
          replyTo: "care@merchant.example",
          recipient: "b***@example.com",
          status: "sent"
        },
        {
          channel: "WHATSAPP",
          provider: "smoke",
          providerMessageId: "wa_repeat_buyer_1",
          sender: "******3210",
          recipient: "******9999",
          status: "sent"
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs[0].templateKey, "repeat_buyer_v1");
    assert.equal(state.logs[1].templateKey, "repeat_buyer_v1");
    assert.deepEqual(state.logs.map((log) => log.channel).sort(), ["EMAIL", "WHATSAPP"]);
    assert.equal(state.logs[0].metadata.buyerId, "buyer_1");
    assert.equal(state.logs[0].metadata.lastOrderId, "order_1");
    assert.equal(state.logs[0].metadata.storeUrl, "https://merchant.example/");
    assert.equal(messageSentUsage.length, 2);
    assert.equal(messageSentUsage.every((item) => item.create.workflowKey === "SM_21_REPEAT_BUYER"), true);
    assert.equal(messageSentUsage.every((item) => item.create.eventKey === "buyer.repeat_purchase_due"), true);
  });

  it("records repeat buyer channel failures as retryable failed workflow callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "buyer.repeat_purchase_due",
        status: "DISPATCHED",
        attempts: 1,
        payload: { buyerId: "buyer_1", lastOrderId: "order_1" }
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "FAILED",
      error: "Provider rejected repeat buyer email",
      result: { workflowKey: "SM_21_REPEAT_BUYER", retryable: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "merchant-smtp",
          providerMessageId: "email_failed_repeat_buyer_1",
          sender: "care@merchant.example",
          recipient: "b***@example.com",
          status: "failed",
          error: "SMTP provider rejected message"
        }
      ]
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].templateKey, "repeat_buyer_v1");
    assert.equal(state.logs[0].metadata.buyerId, "buyer_1");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_21_REPEAT_BUYER");
    assert.equal(messageFailedUsage[0].create.eventKey, "buyer.repeat_purchase_due");
  });

  it("processes COD remittance channel callbacks with finance metadata and idempotency", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "cod.remittance_due",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          remittanceId: "remit_1",
          dueDate: "2026-05-16",
          ageingBucket: "0-3",
          codAmountPaise: 125000,
          financeSummaryUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control"
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      workflowKey: "SM_40_COD_REMITTANCE_ALERT",
      templateKey: "cod_remittance_due_v1",
      remittanceId: "remit_1",
      dueDate: "2026-05-16",
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:finance-smoke",
          providerMessageId: "email_cod_remit_1",
          sender: "care@merchant.example",
          replyTo: "care@merchant.example",
          recipient: "f***@merchant.example",
          status: "sent",
          metadata: {
            remittanceId: "remit_1",
            codAmountPaise: 125000
          }
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].templateKey, "cod_remittance_due_v1");
    assert.equal(state.logs[0].metadata.remittanceId, "remit_1");
    assert.equal(state.logs[0].metadata.dueDate, "2026-05-16");
    assert.equal(messageSentUsage.length, 1);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_40_COD_REMITTANCE_ALERT");
    assert.equal(messageSentUsage[0].create.eventKey, "cod.remittance_due");
    assert.equal(messageSentUsage[0].create.channel, "EMAIL");
  });

  it("records COD remittance provider failures as retryable failed workflow callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "cod.remittance_mismatch_detected",
        status: "DISPATCHED",
        attempts: 1,
        payload: { remittanceId: "remit_failed" }
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "FAILED",
      error: "Finance email provider rejected message",
      result: { workflowKey: "SM_40_COD_REMITTANCE_ALERT", retryable: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:finance-smoke",
          providerMessageId: "email_failed_remit_1",
          sender: "care@merchant.example",
          recipient: "f***@merchant.example",
          status: "failed",
          error: "SMTP provider rejected finance alert"
        }
      ]
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].templateKey, "cod_remittance_mismatch_v1");
    assert.equal(state.logs[0].metadata.remittanceId, "remit_failed");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_40_COD_REMITTANCE_ALERT");
  });

  it("processes seller settlement callbacks with safe settlement metadata and idempotency", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "seller.settlement_paid",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          settlementId: "settlement_1",
          settlementStatus: "PAID",
          settlementDate: "2026-05-16",
          expectedPayoutDate: "2026-05-18",
          paidAt: "2026-05-17T07:00:00.000Z",
          statementUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control",
          netPayableAmountPaise: 250000
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      workflowKey: "SM_41_SELLER_SETTLEMENT_SUMMARY",
      templateKey: "seller_settlement_paid_v1",
      settlementId: "settlement_1",
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:settlement-smoke",
          providerMessageId: "email_settlement_1",
          sender: "care@merchant.example",
          replyTo: "care@merchant.example",
          recipient: "f***@merchant.example",
          status: "sent",
          metadata: {
            settlementId: "settlement_1",
            netPayableAmountPaise: 250000
          }
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].templateKey, "seller_settlement_paid_v1");
    assert.equal(state.logs[0].metadata.settlementId, "settlement_1");
    assert.equal(state.logs[0].metadata.settlementStatus, "PAID");
    assert.equal(state.logs[0].metadata.expectedPayoutDate, "2026-05-18");
    assert.equal(messageSentUsage.length, 1);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_41_SELLER_SETTLEMENT_SUMMARY");
    assert.equal(messageSentUsage[0].create.eventKey, "seller.settlement_paid");
    assert.equal(messageSentUsage[0].create.channel, "EMAIL");
  });

  it("records seller settlement provider failures as retryable failed workflow callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "seller.settlement_held",
        status: "DISPATCHED",
        attempts: 1,
        payload: { settlementId: "settlement_failed", settlementStatus: "HELD" }
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "FAILED",
      error: "Settlement email provider rejected message",
      result: { workflowKey: "SM_41_SELLER_SETTLEMENT_SUMMARY", retryable: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:settlement-smoke",
          providerMessageId: "email_failed_settlement_1",
          sender: "care@merchant.example",
          recipient: "f***@merchant.example",
          status: "failed",
          error: "SMTP provider rejected settlement alert"
        }
      ]
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].templateKey, "seller_settlement_held_v1");
    assert.equal(state.logs[0].metadata.settlementId, "settlement_failed");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_41_SELLER_SETTLEMENT_SUMMARY");
  });

  it("processes invoice mismatch callbacks with safe finance metadata and idempotency", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "invoice.cod_fee_mismatch_detected",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          invoiceId: "invoice_1",
          mismatchId: "mismatch_1",
          mismatchType: "cod_fee_mismatch",
          severity: "HIGH",
          expectedAmountPaise: 175000,
          billedAmountPaise: 205000,
          mismatchAmountPaise: 30000,
          financeSummaryUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control"
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      workflowKey: "SM_42_INVOICE_MISMATCH",
      templateKey: "invoice_cod_fee_mismatch_v1",
      invoiceId: "invoice_1",
      mismatchId: "mismatch_1",
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:finance-smoke",
          providerMessageId: "email_invoice_1",
          sender: "care@merchant.example",
          replyTo: "care@merchant.example",
          recipient: "f***@merchant.example",
          status: "sent",
          metadata: {
            invoiceId: "invoice_1",
            mismatchId: "mismatch_1",
            mismatchAmountPaise: 30000
          }
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].templateKey, "invoice_cod_fee_mismatch_v1");
    assert.equal(state.logs[0].metadata.invoiceId, "invoice_1");
    assert.equal(state.logs[0].metadata.mismatchId, "mismatch_1");
    assert.equal(state.logs[0].metadata.severity, "HIGH");
    assert.equal(messageSentUsage.length, 1);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_42_INVOICE_MISMATCH");
    assert.equal(messageSentUsage[0].create.eventKey, "invoice.cod_fee_mismatch_detected");
    assert.equal(messageSentUsage[0].create.channel, "EMAIL");
  });

  it("records invoice mismatch provider failures as retryable failed workflow callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "invoice.mismatch_detected",
        status: "DISPATCHED",
        attempts: 1,
        payload: { invoiceId: "invoice_failed", mismatchId: "mismatch_failed" }
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "FAILED",
      error: "Finance email provider rejected invoice alert",
      result: { workflowKey: "SM_42_INVOICE_MISMATCH", retryable: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:finance-smoke",
          providerMessageId: "email_failed_invoice_1",
          sender: "care@merchant.example",
          recipient: "f***@merchant.example",
          status: "failed",
          error: "SMTP provider rejected invoice alert"
        }
      ]
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].templateKey, "invoice_mismatch_detected_v1");
    assert.equal(state.logs[0].metadata.invoiceId, "invoice_failed");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_42_INVOICE_MISMATCH");
  });

  it("records courier pickup delay channel results and idempotent duplicate callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "courier.pickup_failed",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          pickupId: "pickup_1",
          pickupDate: "2026-05-17",
          courierPartnerId: "courier_1",
          courierPartnerName: "Safe Courier",
          affectedShipmentCount: 12,
          delayMinutes: 95,
          severity: "HIGH"
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      workflowKey: "SM_30_COURIER_PICKUP_DELAY",
      templateKey: "courier_pickup_failed_v1",
      pickupId: "pickup_1",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:pickup-smoke",
          providerMessageId: "email_pickup_1",
          sender: "care@merchant.example",
          replyTo: "care@merchant.example",
          recipient: "s***@merchant.example",
          status: "sent",
          metadata: {
            pickupId: "pickup_1",
            courierPartnerId: "courier_1",
            affectedShipmentCount: 12
          }
        },
        {
          channel: "INTERNAL",
          provider: "shipmastr-ops",
          providerMessageId: "internal_pickup_1",
          sender: "Shipmastr Autopilot",
          recipient: "ops:courier-control",
          status: "sent",
          metadata: {
            pickupId: "pickup_1",
            courierPartnerId: "courier_1"
          }
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs[0].templateKey, "courier_pickup_failed_v1");
    assert.equal(state.logs[0].metadata.pickupId, "pickup_1");
    assert.equal(state.logs[0].metadata.courierPartnerId, "courier_1");
    assert.equal(state.logs[1].channel, "INTERNAL");
    assert.equal(messageSentUsage.length, 2);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_30_COURIER_PICKUP_DELAY");
    assert.equal(messageSentUsage[0].create.eventKey, "courier.pickup_failed");
  });

  it("records courier pickup provider failures as retryable failed workflow callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "courier.pickup_delay_detected",
        status: "DISPATCHED",
        attempts: 1,
        payload: { pickupId: "pickup_failed", courierPartnerId: "courier_1" }
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "FAILED",
      error: "Courier pickup email provider rejected alert",
      result: { workflowKey: "SM_30_COURIER_PICKUP_DELAY", retryable: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:pickup-smoke",
          providerMessageId: "email_failed_pickup_1",
          sender: "care@merchant.example",
          recipient: "s***@merchant.example",
          status: "failed",
          error: "SMTP provider rejected pickup alert"
        }
      ]
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].templateKey, "courier_pickup_delay_v1");
    assert.equal(state.logs[0].metadata.pickupId, "pickup_failed");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_30_COURIER_PICKUP_DELAY");
  });

  it("records courier SLA breach channel results and idempotent duplicate callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "courier.cod_remittance_sla_breach",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          breachId: "breach_1",
          breachType: "cod_remittance_sla",
          courierPartnerId: "courier_1",
          courierPartnerName: "Safe Courier",
          affectedShipmentCount: 12,
          breachMinutes: 240,
          severity: "CRITICAL"
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      workflowKey: "SM_31_COURIER_SLA_BREACH",
      templateKey: "courier_cod_remittance_sla_breach_v1",
      breachId: "breach_1",
      courierPartnerId: "courier_1",
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:sla-smoke",
          providerMessageId: "email_sla_1",
          sender: "care@merchant.example",
          replyTo: "care@merchant.example",
          recipient: "s***@merchant.example",
          status: "sent",
          metadata: {
            breachId: "breach_1",
            breachType: "cod_remittance_sla",
            courierPartnerId: "courier_1",
            affectedShipmentCount: 12
          }
        },
        {
          channel: "INTERNAL",
          provider: "shipmastr-ops",
          providerMessageId: "internal_sla_1",
          sender: "Shipmastr Autopilot",
          recipient: "ops:courier-control",
          status: "sent",
          metadata: {
            breachId: "breach_1",
            courierPartnerId: "courier_1"
          }
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs[0].templateKey, "courier_cod_remittance_sla_breach_v1");
    assert.equal(state.logs[0].metadata.breachId, "breach_1");
    assert.equal(state.logs[0].metadata.breachType, "cod_remittance_sla");
    assert.equal(state.logs[1].channel, "INTERNAL");
    assert.equal(messageSentUsage.length, 2);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_31_COURIER_SLA_BREACH");
    assert.equal(messageSentUsage[0].create.eventKey, "courier.cod_remittance_sla_breach");
  });

  it("records courier SLA provider failures as retryable failed workflow callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "courier.sla_breach_detected",
        status: "DISPATCHED",
        attempts: 1,
        payload: { breachId: "breach_failed", courierPartnerId: "courier_1" }
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "FAILED",
      error: "Courier SLA email provider rejected alert",
      result: { workflowKey: "SM_31_COURIER_SLA_BREACH", retryable: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:sla-smoke",
          providerMessageId: "email_failed_sla_1",
          sender: "care@merchant.example",
          recipient: "s***@merchant.example",
          status: "failed",
          error: "SMTP provider rejected SLA alert"
        }
      ]
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].templateKey, "courier_sla_breach_v1");
    assert.equal(state.logs[0].metadata.breachId, "breach_failed");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_31_COURIER_SLA_BREACH");
  });

  it("records fake scan review channel results and idempotent duplicate callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "courier.scan_location_mismatch",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          anomalyId: "anomaly_1",
          anomalyType: "location_mismatch",
          courierPartnerId: "courier_1",
          courierPartnerName: "Safe Courier",
          affectedShipmentCount: 2,
          scanStatus: "OFD",
          severity: "HIGH"
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      workflowKey: "SM_32_FAKE_SCAN_REVIEW",
      templateKey: "scan_location_mismatch_v1",
      anomalyId: "anomaly_1",
      courierPartnerId: "courier_1",
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:fake-scan-smoke",
          providerMessageId: "email_scan_1",
          sender: "care@merchant.example",
          replyTo: "care@merchant.example",
          recipient: "s***@merchant.example",
          status: "sent",
          metadata: {
            anomalyId: "anomaly_1",
            anomalyType: "location_mismatch",
            courierPartnerId: "courier_1",
            affectedShipmentCount: 2
          }
        },
        {
          channel: "INTERNAL",
          provider: "shipmastr-ops",
          providerMessageId: "internal_scan_1",
          sender: "Shipmastr Autopilot",
          recipient: "ops:courier-control",
          status: "sent",
          metadata: {
            anomalyId: "anomaly_1",
            courierPartnerId: "courier_1"
          }
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs[0].templateKey, "scan_location_mismatch_v1");
    assert.equal(state.logs[0].metadata.anomalyId, "anomaly_1");
    assert.equal(state.logs[0].metadata.anomalyType, "location_mismatch");
    assert.equal(state.logs[1].channel, "INTERNAL");
    assert.equal(messageSentUsage.length, 2);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_32_FAKE_SCAN_REVIEW");
    assert.equal(messageSentUsage[0].create.eventKey, "courier.scan_location_mismatch");
  });

  it("records courier daily digest channel results and idempotent duplicate callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "courier.ops_daily_digest_due",
        status: "DISPATCHED",
        attempts: 1,
        payload: {
          digestId: "digest_ops_1",
          digestDate: "2026-05-17",
          scope: "OPS",
          summary: {
            pendingPickupCount: 18,
            slaBreachCount: 7,
            affectedShipmentCount: 42
          }
        }
      })
    });
    const callback = {
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "PROCESSED" as const,
      workflowKey: "SM_33_COURIER_DAILY_DIGEST",
      templateKey: "courier_ops_daily_digest_v1",
      digestId: "digest_ops_1",
      digestDate: "2026-05-17",
      scope: "OPS" as const,
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:courier-digest-smoke",
          providerMessageId: "email_digest_1",
          sender: "noreply@shipmastr.com",
          replyTo: "noreply@shipmastr.com",
          recipient: "ops:courier-control",
          status: "sent",
          metadata: {
            digestId: "digest_ops_1",
            digestDate: "2026-05-17",
            scope: "OPS"
          }
        },
        {
          channel: "WHATSAPP",
          provider: "whatsapp:skipped",
          status: "skipped",
          skipReason: "WHATSAPP_REAL_PROVIDER_BLOCKED",
          metadata: {
            digestId: "digest_ops_1",
            scope: "OPS"
          }
        }
      ]
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    const messageSentUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_SENT");
    const skippedAttemptUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_ATTEMPT" && item.create.channel === "WHATSAPP");
    assert.equal(state.event.status, "PROCESSED");
    assert.equal(state.logs.length, 2);
    assert.equal(state.logs[0].templateKey, "courier_ops_daily_digest_v1");
    assert.equal(state.logs[0].metadata.digestId, "digest_ops_1");
    assert.equal(state.logs[0].metadata.scope, "OPS");
    assert.equal(state.logs[0].metadata.replyTo, "noreply@shipmastr.com");
    assert.equal(state.logs[1].status, "SKIPPED");
    assert.equal(state.logs[1].metadata.skipReason, "WHATSAPP_REAL_PROVIDER_BLOCKED");
    assert.equal(messageSentUsage.length, 1);
    assert.equal(skippedAttemptUsage.length, 1);
    assert.equal(messageSentUsage[0].create.workflowKey, "SM_33_COURIER_DAILY_DIGEST");
  });

  it("records fake scan provider failures as retryable failed workflow callbacks", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "courier.fake_scan_suspected",
        status: "DISPATCHED",
        attempts: 1,
        payload: { anomalyId: "anomaly_failed", courierPartnerId: "courier_1" }
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      merchantId: "merchant_1",
      status: "FAILED",
      error: "Fake scan review email provider rejected alert",
      result: { workflowKey: "SM_32_FAKE_SCAN_REVIEW", retryable: true },
      channelResults: [
        {
          channel: "EMAIL",
          provider: "smtp:fake-scan-smoke",
          providerMessageId: "email_failed_scan_1",
          sender: "care@merchant.example",
          recipient: "s***@merchant.example",
          status: "failed",
          error: "SMTP provider rejected fake scan alert"
        }
      ]
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].templateKey, "fake_scan_review_v1");
    assert.equal(state.logs[0].metadata.anomalyId, "anomaly_failed");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_32_FAKE_SCAN_REVIEW");
  });

  it("records Merchant Daily Digest provider failures as retryable failed email logs", async () => {
    const state = installCallbackMocks({
      event: makeEvent({
        eventKey: "merchant.daily_digest",
        status: "DISPATCHED",
        attempts: 1
      })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      status: "FAILED",
      error: "SMTP provider rejected digest",
      result: {
        workflowKey: "SM_60_MERCHANT_DAILY_DIGEST",
        retryable: true,
        digestDate: "2026-05-16"
      },
      communication: {
        merchantId: "merchant_1",
        channel: "EMAIL",
        recipient: "seller@example.com",
        templateKey: "merchant_daily_digest_v1",
        provider: "smtp:gmail",
        providerMessageId: "smtp_digest_failed_evt_1",
        status: "FAILED",
        metadata: {
          from: "noreply@shipmastr.com",
          subject: "Urban Saree Co Daily Summary 16 May 2026",
          digestDate: "2026-05-16"
        }
      }
    });

    const messageFailedUsage = state.usage.filter((item) => item.create.usageType === "MESSAGE_FAILED");
    assert.equal(result.event.status, "FAILED");
    assert.equal(state.logs.length, 1);
    assert.equal(state.logs[0].status, "FAILED");
    assert.equal(state.logs[0].provider, "smtp:gmail");
    assert.equal(state.logs[0].templateKey, "merchant_daily_digest_v1");
    assert.equal(messageFailedUsage.length, 1);
    assert.equal(messageFailedUsage[0].create.workflowKey, "SM_60_MERCHANT_DAILY_DIGEST");
    assert.equal(messageFailedUsage[0].create.eventKey, "merchant.daily_digest");
    assert.equal(messageFailedUsage[0].create.channel, "EMAIL");
  });

  it("rejects callback communication for the wrong merchant", async () => {
    installCallbackMocks();

    await assert.rejects(
      () => handleAutomationCallback({
        eventId: "evt_1",
        status: "PROCESSED",
        communication: {
          merchantId: "merchant_2",
          channel: "WHATSAPP",
          recipient: "+919999999999",
          templateKey: "order_created",
          status: "SENT"
        }
      }),
      (error) =>
        error instanceof AutomationCallbackError &&
        error.status === 403 &&
        error.message === "AUTOMATION_CALLBACK_MERCHANT_MISMATCH"
    );
  });

  it("does not duplicate communication logs for duplicate callbacks", async () => {
    const state = installCallbackMocks();
    const callback = {
      eventId: "evt_1",
      status: "PROCESSED" as const,
      communication: {
        merchantId: "merchant_1",
        channel: "WHATSAPP",
        recipient: "+919999999999",
        templateKey: "order_created",
        provider: "mock",
        providerMessageId: "provider_msg_1",
        status: "SENT"
      }
    };

    await handleAutomationCallback(callback);
    await handleAutomationCallback(callback);

    assert.equal(state.logs.length, 1);
  });

  it("marks failed callbacks as retryable automation failures", async () => {
    const { updates } = installCallbackMocks({
      event: makeEvent({ status: "DISPATCHED", attempts: 1 })
    });

    const result = await handleAutomationCallback({
      eventId: "evt_1",
      status: "FAILED",
      error: "Live workflow smoke failure"
    });

    assert.equal(result.event.status, "FAILED");
    assert.equal(updates.at(-1).status, "FAILED");
    assert.ok(updates.at(-1).nextAttemptAt instanceof Date);
  });

  it("builds seller-safe COD Shield order events without exposing raw risk internals", () => {
    const order = {
      id: "order_1",
      merchantId: "merchant_1",
      externalOrderId: "EXT-1",
      buyerName: "Smoke Buyer",
      buyerPhone: "+919999999999",
      addressLine1: "Unit 1",
      addressLine2: null,
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400001",
      orderValue: 2499,
      codAmount: 2499,
      paymentMode: "COD"
    };
    const decision = {
      codDecision: "REQUIRE_OTP",
      shipmentDecision: "VERIFY_BEFORE_SHIP",
      automationStatus: "ADDRESS_CORRECTION_SENT",
      pendingRequiredAction: "BUYER_ADDRESS_CONFIRMATION",
      sellerMessage: "Address confirmation is required before releasing this COD order.",
      shortReasons: [
        "Buyer verification is in progress.",
        "Address confirmation is pending."
      ],
      automation: {
        timeline: [
          { actionType: "SEND_ADDRESS_CORRECTION_LINK" }
        ]
      }
    } as any;

    const payloads = buildOrderAutomationPayloads(order, decision);
    const events = buildOrderAutomationEvents(order, decision);

    assert.deepEqual(events.map((event) => event.eventKey), [
      "order.created",
      "order.cod_risk_high",
      "order.address_confirmation_required"
    ]);
    assert.equal(payloads.codRiskHigh.buyerContact.phone, "+919999999999");
    assert.equal(payloads.codRiskHigh.riskTier, "MEDIUM");
    assert.equal(payloads.codRiskHigh.recommendedAction, "Confirm buyer address before shipment.");
    assert.equal(payloads.addressConfirmation.shippingAddress.pincode, "400001");
    const codRiskEvent = events[1];
    const addressEvent = events[2];
    assert.ok(codRiskEvent);
    assert.ok(addressEvent);
    assert.equal(codRiskEvent.idempotencyKey, "order.cod_risk_high:order_1");
    assert.equal(addressEvent.idempotencyKey, "order.address_confirmation_required:order_1");

    const serialized = JSON.stringify(payloads);
    for (const forbidden of [
      "phoneHash",
      "addressHash",
      "dataSnapshot",
      "consigneeScore",
      "codRiskScore",
      "fraudRiskScore",
      "pincodeRiskScore",
      "rtoRiskScore",
      "overallRiskScore",
      "riskScore",
      "features",
      "model"
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in COD Shield payload`);
    }
  });

  it("builds seller-safe NDR Rescue events with deterministic idempotency keys", () => {
    const event = buildNdrRecoveryAutomationEvent({
      merchantId: "merchant_1",
      orderId: "order_1",
      externalOrderId: "EXT-1",
      shipmentId: "shipment_1",
      awb: "AWB123",
      ndrEventId: "ndr_1",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      buyerName: "Smoke Buyer",
      buyerPhone: "+919999999999",
      ndrReason: "CUSTOMER_NOT_REACHABLE",
      attemptCount: 2,
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400001",
      ...( {
        phoneHash: "must_not_leak",
        addressHash: "must_not_leak",
        riskScore: 99,
        features: { debug: true },
        model: "internal"
      } as any)
    });

    assert.equal(event.eventKey, "shipment.ndr_created");
    assert.equal(event.source, "shipment-ndr");
    assert.equal(event.sourceId, "ndr_1");
    assert.equal(event.idempotencyKey, "shipment.ndr_created:order_1:shipment_1:AWB123:ndr_1");
    assert.equal((event.payload as any).buyerContact.phone, "+919999999999");
    assert.deepEqual((event.payload as any).recommendedActions, [
      "reattempt_today",
      "reattempt_tomorrow",
      "update_address",
      "cancel_or_manual_review"
    ]);
    assert.equal((event.payload as any).addressSummary, "Mumbai, Maharashtra, 400001");

    const serialized = JSON.stringify(event.payload);
    for (const forbidden of [
      "phoneHash",
      "addressHash",
      "consigneeScore",
      "codRiskScore",
      "fraudRiskScore",
      "pincodeRiskScore",
      "rtoRiskScore",
      "overallRiskScore",
      "riskScore",
      "features",
      "model"
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in NDR Rescue payload`);
    }
  });

  it("builds Merchant Daily Digest events with email sender, subject, and merchant-date idempotency", () => {
    const event = buildMerchantDailyDigestAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@example.com",
      digestDate: "2026-05-16",
      timezone: "Asia/Kolkata",
      summary: {
        ordersReceived: 7,
        codRiskHighCount: 2,
        recommendedActions: ["Review high-risk COD orders before pickup."]
      }
    });

    assert.equal(formatMerchantDigestSubjectDate("2026-05-16", "Asia/Kolkata"), "16 May 2026");
    assert.equal(formatMerchantDigestSubjectDate("2026-05-17T07:00:00.000Z", "Asia/Kolkata"), "17 May 2026");
    assert.equal(event.eventKey, "merchant.daily_digest");
    assert.equal(event.source, "merchant-daily-digest");
    assert.equal(event.sourceId, "2026-05-16");
    assert.equal(event.idempotencyKey, "merchant-daily-digest:merchant_1:2026-05-16");
    assert.equal((event.payload as any).email.from, "noreply@shipmastr.com");
    assert.equal((event.payload as any).email.to, "seller@example.com");
    assert.equal((event.payload as any).email.subject, "Urban Saree Co Daily Summary 16 May 2026");
  });

  it("builds merchant-scoped COD remittance alert events with safe amount fields", () => {
    const event = buildCodRemittanceAlertAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "cod.remittance_mismatch_detected",
      remittanceId: "remit_1",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      dueDate: "2026-05-16",
      settlementDate: "2026-05-17",
      codAmountPaise: 125000,
      expectedAmountPaise: 125000,
      receivedAmountPaise: 95000,
      shipmentCount: 12,
      awbCount: 12,
      financeSummaryUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control",
      ...( {
        providerToken: "must_not_leak",
        internalLedgerRows: ["must_not_leak"],
        rawCourierSettlementCsv: "must_not_leak"
      } as any)
    });

    assert.equal(event.eventKey, "cod.remittance_mismatch_detected");
    assert.equal(event.source, "cod-remittance-alert");
    assert.equal(event.sourceId, "remit_1");
    assert.equal(event.idempotencyKey, "cod-remittance-alert:merchant_1:cod.remittance_mismatch_detected:remit_1:2026-05-16");
    assert.equal((event.payload as any).templateKey, "cod_remittance_mismatch_v1");
    assert.equal((event.payload as any).amounts.currency, "INR");
    assert.equal((event.payload as any).expectedAmountPaise, 125000);
    assert.equal((event.payload as any).receivedAmountPaise, 95000);
    assert.equal((event.payload as any).mismatchAmountPaise, 30000);
    assert.equal((event.payload as any).email.subject, "Urban Saree Co COD Mismatch Detected 17 May 2026");
    assert.equal(buildCodRemittanceSubject({
      merchantName: "Urban Saree Co",
      eventKey: "cod.remittance_due",
      dueDate: "2026-05-16"
    }), "Urban Saree Co COD Remittance Due 16 May 2026");

    const serialized = JSON.stringify(event.payload);
    for (const forbidden of ["providerToken", "internalLedgerRows", "rawCourierSettlementCsv", "credentialRef", "webhookUrl"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in COD remittance payload`);
    }
  });

  it("builds merchant-scoped seller settlement events with safe amount fields", () => {
    const event = buildSellerSettlementSummaryAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "seller.settlement_paid",
      settlementId: "settlement_1",
      settlementStatus: "PAID",
      settlementDate: "2026-05-16",
      expectedPayoutDate: "2026-05-18",
      paidAt: "2026-05-17T07:00:00.000Z",
      grossCodAmountPaise: 300000,
      shippingChargesPaise: 45000,
      platformFeesPaise: 5000,
      adjustmentAmountPaise: 0,
      holdAmountPaise: 0,
      disputeAmountPaise: 0,
      netPayableAmountPaise: 250000,
      shipmentCount: 14,
      awbCount: 14,
      statementUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control",
      ...( {
        rawSettlementRows: ["must_not_leak"],
        providerToken: "must_not_leak",
        courierCredentialRef: "must_not_leak"
      } as any)
    });

    assert.equal(event.eventKey, "seller.settlement_paid");
    assert.equal(event.source, "seller-settlement-summary");
    assert.equal(event.sourceId, "settlement_1");
    assert.equal(event.idempotencyKey, "seller-settlement-summary:merchant_1:seller.settlement_paid:settlement_1:PAID");
    assert.equal((event.payload as any).templateKey, "seller_settlement_paid_v1");
    assert.equal((event.payload as any).amounts.currency, "INR");
    assert.equal((event.payload as any).grossCodAmountPaise, 300000);
    assert.equal((event.payload as any).shippingChargesPaise, 45000);
    assert.equal((event.payload as any).netPayableAmountPaise, 250000);
    assert.equal((event.payload as any).email.subject, "Urban Saree Co Settlement Paid 17 May 2026");
    assert.equal(buildSellerSettlementSubject({
      merchantName: "Urban Saree Co",
      eventKey: "seller.settlement_held",
      settlementDate: "2026-05-16"
    }), "Urban Saree Co Settlement Hold Alert 16 May 2026");

    const serialized = JSON.stringify(event.payload);
    for (const forbidden of ["rawSettlementRows", "providerToken", "courierCredentialRef", "credentialRef", "webhookUrl"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in seller settlement payload`);
    }
  });

  it("builds merchant-scoped invoice mismatch events with safe amount fields", () => {
    const event = buildInvoiceMismatchAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "finance@merchant.example",
      eventKey: "invoice.duplicate_awb_charge_detected",
      invoiceId: "invoice_1",
      mismatchId: "mismatch_1",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      severity: "CRITICAL",
      invoiceDate: "2026-05-16",
      detectedAt: "2026-05-17T08:00:00.000Z",
      expectedAmountPaise: 175000,
      billedAmountPaise: 205000,
      awbCount: 2,
      affectedShipmentCount: 2,
      financeSummaryUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=finance-control",
      disputeUrl: "https://shipmastr.com/seller/finance/disputes",
      ...( {
        rawInvoiceRows: ["must_not_leak"],
        providerToken: "must_not_leak",
        courierCredentialRef: "must_not_leak"
      } as any)
    });

    assert.equal(event.eventKey, "invoice.duplicate_awb_charge_detected");
    assert.equal(event.source, "invoice-mismatch-alert");
    assert.equal(event.sourceId, "invoice_1");
    assert.equal(event.idempotencyKey, "invoice-mismatch:merchant_1:invoice_1:mismatch_1:invoice.duplicate_awb_charge_detected");
    assert.equal((event.payload as any).templateKey, "invoice_duplicate_awb_charge_v1");
    assert.equal((event.payload as any).amounts.currency, "INR");
    assert.equal((event.payload as any).expectedAmountPaise, 175000);
    assert.equal((event.payload as any).billedAmountPaise, 205000);
    assert.equal((event.payload as any).mismatchAmountPaise, 30000);
    assert.equal((event.payload as any).severity, "CRITICAL");
    assert.equal((event.payload as any).email.subject, "Urban Saree Co Duplicate AWB Charge Detected 17 May 2026");
    assert.equal(buildInvoiceMismatchSubject({
      merchantName: "Urban Saree Co",
      eventKey: "invoice.cod_fee_mismatch_detected",
      detectedAt: "2026-05-16"
    }), "Urban Saree Co COD Fee Mismatch Alert 16 May 2026");

    const serialized = JSON.stringify(event.payload);
    for (const forbidden of ["rawInvoiceRows", "providerToken", "courierCredentialRef", "credentialRef", "webhookUrl"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in invoice mismatch payload`);
    }
  });

  it("builds courier-scoped pickup delay events with safe pickup fields", () => {
    const event = buildCourierPickupDelayAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@merchant.example",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      courierEmail: "ops@safe-courier.example",
      eventKey: "courier.pickup_missed",
      pickupId: "pickup_1",
      pickupDate: "2026-05-17",
      scheduledPickupWindow: "14:00-17:00",
      delayMinutes: 120,
      affectedShipmentCount: 8,
      awbCount: 8,
      oldestAwbAgeMinutes: 220,
      pickupLocationSummary: "Warehouse cluster, Andheri East",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400059",
      severity: "CRITICAL",
      pickupDashboardUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=courier-control-tower",
      ...( {
        rawPickupManifest: ["must_not_leak"],
        courierApiToken: "must_not_leak",
        credentialRef: "must_not_leak"
      } as any)
    });

    assert.equal(event.eventKey, "courier.pickup_missed");
    assert.equal(event.source, "courier-pickup-delay-alert");
    assert.equal(event.sourceId, "pickup_1");
    assert.equal(event.idempotencyKey, "courier-pickup-delay:courier_1:pickup_1:courier.pickup_missed:2026-05-17");
    assert.equal((event.payload as any).templateKey, "courier_pickup_missed_v1");
    assert.equal((event.payload as any).courierPartner.id, "courier_1");
    assert.equal((event.payload as any).affectedShipmentCount, 8);
    assert.equal((event.payload as any).oldestAwbAgeMinutes, 220);
    assert.equal((event.payload as any).severity, "CRITICAL");
    assert.equal((event.payload as any).email.subject, "Pickup Missed - Safe Courier - 17 May 2026");
    assert.equal(buildCourierPickupDelaySubject({
      eventKey: "courier.pickup_resolved",
      courierPartnerName: "Safe Courier",
      pickupDate: "2026-05-16"
    }), "Pickup Resolved - Safe Courier - 16 May 2026");

    const serialized = JSON.stringify(event.payload);
    for (const forbidden of ["rawPickupManifest", "courierApiToken", "credentialRef", "webhookUrl"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in courier pickup payload`);
    }
  });

  it("builds courier-scoped SLA breach events with safe shipment fields", () => {
    const event = buildCourierSlaBreachAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@merchant.example",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      courierEmail: "ops@safe-courier.example",
      eventKey: "courier.first_scan_sla_breach",
      breachId: "breach_1",
      detectedAt: "2026-05-17T10:00:00.000Z",
      slaTarget: "First scan within 2 hours",
      actualValue: "5 hours",
      breachMinutes: 180,
      affectedShipmentCount: 7,
      awbCount: 7,
      sampleAwbs: ["BLISS17774438577588613"],
      laneSummary: "Mumbai to Pune",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400059",
      severity: "HIGH",
      courierDashboardUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=courier-control-tower",
      ...( {
        rawCourierScanPayload: ["must_not_leak"],
        courierApiToken: "must_not_leak",
        credentialRef: "must_not_leak"
      } as any)
    });

    assert.equal(event.eventKey, "courier.first_scan_sla_breach");
    assert.equal(event.source, "courier-sla-breach-alert");
    assert.equal(event.sourceId, "breach_1");
    assert.equal(event.idempotencyKey, "courier-sla-breach:courier_1:first_scan_sla:breach_1:courier.first_scan_sla_breach");
    assert.equal((event.payload as any).templateKey, "courier_first_scan_sla_breach_v1");
    assert.equal((event.payload as any).courierPartner.id, "courier_1");
    assert.equal((event.payload as any).breachType, "first_scan_sla");
    assert.equal((event.payload as any).sampleAwbs[0], "BLI***613");
    assert.equal((event.payload as any).email.subject, "First Scan SLA Breach - Safe Courier - 17 May 2026");
    assert.equal(buildCourierSlaBreachSubject({
      eventKey: "courier.cod_remittance_sla_breach",
      courierPartnerName: "Safe Courier",
      detectedAt: "2026-05-16T08:30:00.000Z"
    }), "COD Remittance SLA Breach - Safe Courier - 16 May 2026");

    const serialized = JSON.stringify(event.payload);
    for (const forbidden of ["rawCourierScanPayload", "courierApiToken", "credentialRef", "webhookUrl"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in courier SLA payload`);
    }
  });

  it("maps every courier SLA breach event to a versioned template", () => {
    const cases = [
      ["courier.sla_breach_detected", "courier_sla_breach_v1"],
      ["courier.pickup_sla_breach", "courier_pickup_sla_breach_v1"],
      ["courier.first_scan_sla_breach", "courier_first_scan_sla_breach_v1"],
      ["courier.in_transit_sla_breach", "courier_in_transit_sla_breach_v1"],
      ["courier.ofd_sla_breach", "courier_ofd_sla_breach_v1"],
      ["courier.ndr_response_sla_breach", "courier_ndr_response_sla_breach_v1"],
      ["courier.reattempt_sla_breach", "courier_reattempt_sla_breach_v1"],
      ["courier.rto_sla_breach", "courier_rto_sla_breach_v1"],
      ["courier.cod_remittance_sla_breach", "courier_cod_remittance_sla_breach_v1"],
      ["courier.sla_breach_escalated", "courier_sla_breach_escalated_v1"],
      ["courier.sla_breach_resolved", "courier_sla_breach_resolved_v1"]
    ] as const;

    for (const [eventKey, templateKey] of cases) {
      const event = buildCourierSlaBreachAutomationEvent({
        merchantId: "merchant_1",
        merchantName: "Urban Saree Co",
        courierPartnerId: "courier_1",
        courierPartnerName: "Safe Courier",
        eventKey,
        breachId: `breach_${templateKey}`,
        detectedAt: "2026-05-17T10:00:00.000Z"
      });

      assert.equal((event.payload as any).templateKey, templateKey);
      assert.equal(String(event.idempotencyKey).includes(`:${eventKey}`), true);
    }
  });

  it("builds courier-scoped fake scan review events with safe anomaly fields", () => {
    const event = buildFakeScanReviewAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "seller@merchant.example",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      courierEmail: "scan@safe-courier.example",
      eventKey: "courier.scan_location_mismatch",
      anomalyId: "anomaly_1",
      detectedAt: "2026-05-17T10:00:00.000Z",
      shipmentId: "shipment_1",
      orderId: "order_1",
      awb: "BLISS17774438577588613",
      affectedShipmentCount: 2,
      awbCount: 2,
      scanStatus: "OFD",
      previousStatus: "IN_TRANSIT",
      nextStatus: "NDR",
      scanTimestamp: "2026-05-17T08:00:00.000Z",
      receivedAt: "2026-05-17T12:30:00.000Z",
      delayMinutes: 270,
      locationSummary: "Scan city: Delhi",
      expectedLocationSummary: "Expected city: Mumbai",
      routeSummary: "Mumbai local delivery lane",
      sellerSafeSummary: "Scan location does not match expected delivery route.",
      opsReviewSummary: "Check courier proof and route before applying score impact.",
      severity: "HIGH",
      evidenceRefs: ["evidence_scan_1"],
      courierDashboardUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=courier-control-tower",
      ...( {
        rawCourierWebhookPayload: { token: "must_not_leak" },
        courierApiToken: "must_not_leak",
        credentialRef: "must_not_leak",
        internalScanScoreTrace: ["must_not_leak"]
      } as any)
    });

    assert.equal(event.eventKey, "courier.scan_location_mismatch");
    assert.equal(event.source, "fake-scan-review-alert");
    assert.equal(event.sourceId, "anomaly_1");
    assert.equal(event.idempotencyKey, "fake-scan-review:courier_1:location_mismatch:anomaly_1:courier.scan_location_mismatch");
    assert.equal((event.payload as any).templateKey, "scan_location_mismatch_v1");
    assert.equal((event.payload as any).courierPartner.id, "courier_1");
    assert.equal((event.payload as any).anomalyType, "location_mismatch");
    assert.equal((event.payload as any).awbMasked, "BLI***613");
    assert.equal((event.payload as any).email.subject, "Scan Location Mismatch - Safe Courier - 17 May 2026");
    assert.equal(buildFakeScanReviewSubject({
      eventKey: "courier.late_scan_detected",
      courierPartnerName: "Safe Courier",
      detectedAt: "2026-05-16T08:30:00.000Z"
    }), "Late Scan Detected - Safe Courier - 16 May 2026");

    const serialized = JSON.stringify(event.payload);
    for (const forbidden of ["rawCourierWebhookPayload", "courierApiToken", "credentialRef", "internalScanScoreTrace", "webhookUrl"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in fake scan payload`);
    }
  });

  it("maps every fake scan review event to a versioned template", () => {
    const cases = [
      ["courier.fake_scan_suspected", "fake_scan_review_v1"],
      ["courier.pickup_scan_suspected_fake", "fake_pickup_scan_v1"],
      ["courier.delivery_attempt_suspected_fake", "fake_delivery_attempt_v1"],
      ["courier.ndr_scan_suspected_fake", "fake_ndr_scan_v1"],
      ["courier.late_scan_detected", "late_scan_detected_v1"],
      ["courier.impossible_scan_sequence", "impossible_scan_sequence_v1"],
      ["courier.scan_location_mismatch", "scan_location_mismatch_v1"],
      ["courier.duplicate_scan_pattern", "duplicate_scan_pattern_v1"],
      ["courier.scan_after_terminal_state", "scan_after_terminal_state_v1"],
      ["courier.scan_anomaly_escalated", "scan_anomaly_escalated_v1"],
      ["courier.scan_anomaly_resolved", "scan_anomaly_resolved_v1"],
      ["courier.scan_anomaly_dismissed", "scan_anomaly_dismissed_v1"]
    ] as const;

    for (const [eventKey, templateKey] of cases) {
      const event = buildFakeScanReviewAutomationEvent({
        merchantId: "merchant_1",
        merchantName: "Urban Saree Co",
        courierPartnerId: "courier_1",
        courierPartnerName: "Safe Courier",
        eventKey,
        anomalyId: `anomaly_${templateKey}`,
        detectedAt: "2026-05-17T10:00:00.000Z"
      });

      assert.equal((event.payload as any).templateKey, templateKey);
      assert.equal(String(event.idempotencyKey).includes(`:${eventKey}`), true);
    }
  });

  it("builds ops-scoped courier daily digest events with safe summary fields", () => {
    const event = buildCourierDailyDigestAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      merchantEmail: "ops@shipmastr.example",
      eventKey: "courier.ops_daily_digest_due",
      digestId: "digest_ops_1",
      digestDate: "2026-05-17",
      scope: "OPS",
      pendingPickupCount: 18,
      missedPickupCount: 3,
      failedPickupCount: 2,
      slaBreachCount: 7,
      ndrBacklogCount: 11,
      reattemptPendingCount: 5,
      fakeScanReviewCount: 4,
      rtoDelayCount: 6,
      codRemittanceSlaIssueCount: 2,
      invoiceMismatchCount: 3,
      invoiceMismatchAmountPaise: 45000,
      affectedMerchantCount: 6,
      affectedShipmentCount: 42,
      highSeverityCount: 5,
      criticalSeverityCount: 1,
      topIssues: [{ summary: "Pickup backlog needs action", count: 18, severity: "HIGH" }],
      recommendedActions: ["Review high severity first"],
      dashboardUrl: "https://shipmastr.com/seller/merchant/autopilot?tab=courier-control-tower",
      ...( {
        rawCourierWebhookPayload: ["must_not_leak"],
        rawInvoiceRows: ["must_not_leak"],
        courierApiToken: "must_not_leak",
        credentialRef: "must_not_leak"
      } as any)
    });

    assert.equal(event.eventKey, "courier.ops_daily_digest_due");
    assert.equal(event.source, "courier-daily-digest");
    assert.equal(event.sourceId, "digest_ops_1");
    assert.equal(event.idempotencyKey, "courier-daily-digest:OPS:OPS:2026-05-17");
    assert.equal((event.payload as any).templateKey, "courier_ops_daily_digest_v1");
    assert.equal((event.payload as any).scope, "OPS");
    assert.equal((event.payload as any).summary.pendingPickupCount, 18);
    assert.equal((event.payload as any).summary.invoiceMismatchAmountPaise, 45000);
    assert.equal((event.payload as any).email.subject, "Shipmastr Courier Ops Daily Digest - 17 May 2026");
    assert.equal(buildCourierDailyDigestSubject({
      scope: "COURIER_PARTNER",
      courierPartnerName: "Safe Courier",
      digestDate: "2026-05-16"
    }), "Safe Courier Daily Digest - 16 May 2026");

    const serialized = JSON.stringify(event.payload);
    for (const forbidden of ["rawCourierWebhookPayload", "rawInvoiceRows", "courierApiToken", "credentialRef", "webhookUrl"]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked in courier daily digest payload`);
    }
  });

  it("builds courier-partner daily digest events without cross-courier data", () => {
    const event = buildCourierDailyDigestAutomationEvent({
      merchantId: "merchant_1",
      merchantName: "Urban Saree Co",
      eventKey: "courier.partner_daily_digest_due",
      digestId: "digest_partner_1",
      digestDate: "2026-05-17",
      scope: "COURIER_PARTNER",
      courierPartnerId: "courier_1",
      courierPartnerName: "Safe Courier",
      courierEmail: "digest@safe-courier.example",
      pendingPickupCount: 8,
      slaBreachCount: 2,
      affectedMerchantCount: 2,
      affectedShipmentCount: 12
    });

    assert.equal(event.idempotencyKey, "courier-daily-digest:COURIER_PARTNER:courier_1:2026-05-17");
    assert.equal((event.payload as any).templateKey, "courier_partner_daily_digest_v1");
    assert.equal((event.payload as any).courierPartner.id, "courier_1");
    assert.equal((event.payload as any).summary.affectedMerchantCount, 2);
    assert.equal(JSON.stringify(event.payload).includes("courier_2"), false);
  });

  it("builds merchant-scoped digest summaries without other merchants' data", async () => {
    const observedWhere: any[] = [];
    const countDelegates = ["order", "automationEvent", "communicationLog", "ndrEvent", "shipmentDetails"];
    for (const delegate of countDelegates) {
      mockPrismaMethod(delegate, "count", async (args: any) => {
        observedWhere.push({ delegate, where: args.where });
        return delegate === "order" ? 4 : 1;
      });
    }
    mockPrismaMethod("financeAutomationAlert", "aggregate", async (args: any) => {
      observedWhere.push({ delegate: "financeAutomationAlert", where: args.where });
      return { _sum: { amountPaise: args.where.alertKey === "cod.remittance_due" ? 120000 : 30000 } };
    });
    mockPrismaMethod("marketingCampaign", "aggregate", async (args: any) => {
      observedWhere.push({ delegate: "marketingCampaign", where: args.where });
      return { _sum: { recoveredRevenuePaise: 45000 } };
    });

    const summary = await buildMerchantDailyDigestSummary({
      merchantId: "merchant_1",
      digestDate: "2026-05-16",
      timezone: "Asia/Kolkata"
    });

    assert.equal(summary.ordersReceived, 4);
    assert.equal(summary.codDueAmount, 120000);
    assert.equal(summary.codDelayedAmount, 30000);
    assert.equal(summary.abandonedCartRecoveredAmount, 45000);
    assert.ok(summary.recommendedActions.length > 0);
    for (const item of observedWhere) {
      assert.equal(item.where.merchantId, "merchant_1", `${item.delegate} did not stay merchant-scoped`);
      assert.equal(JSON.stringify(item.where).includes("merchant_2"), false);
    }
  });

  it("keeps NDR automation emission non-blocking from carrier webhooks", () => {
    const source = readFileSync("src/modules/webhooks/webhooks.routes.ts", "utf8");

    assert.match(source, /buildNdrRecoveryAutomationEvent/);
    assert.match(source, /void emitAutomationEvent\(automationEvent\)\.catch/);
    assert.match(source, /automation\.ndr_event_emit_failed/);
  });

  it("wires the internal daily digest trigger without exposing it to merchant routes", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const automationRoutes = readFileSync("src/modules/automation/automation.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/internal\/automation", requireInternalSecret, internalAutomationRouter\)/);
    assert.match(automationRoutes, /internalAutomationRouter\.post\("\/daily-digest\/run"/);
    assert.match(automationRoutes, /internalAutomationRouter\.post\("\/cod-remittance\/smoke"/);
    assert.match(automationRoutes, /internalAutomationRouter\.post\("\/seller-settlement\/smoke"/);
    assert.match(automationRoutes, /internalAutomationRouter\.post\("\/invoice-mismatch\/smoke"/);
    assert.match(automationRoutes, /internalAutomationRouter\.post\("\/courier-pickup-delay\/smoke"/);
    assert.match(automationRoutes, /internalAutomationRouter\.post\("\/courier-sla-breach\/smoke"/);
    assert.match(automationRoutes, /internalAutomationRouter\.post\("\/fake-scan-review\/smoke"/);
    assert.match(automationRoutes, /runMerchantDailyDigest/);
    assert.match(automationRoutes, /runCodRemittanceSmoke/);
    assert.match(automationRoutes, /runSellerSettlementSmoke/);
    assert.match(automationRoutes, /runInvoiceMismatchSmoke/);
    assert.match(automationRoutes, /runCourierPickupDelaySmoke/);
    assert.match(automationRoutes, /runCourierSlaBreachSmoke/);
    assert.match(automationRoutes, /runFakeScanReviewSmoke/);
  });

  it("wires the env-gated internal smoke callback route without weakening production callback", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const automationRoutes = readFileSync("src/modules/automation/automation.routes.ts", "utf8");
    const envSource = readFileSync("src/config/env.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/internal\/automation", requireInternalSecret, internalAutomationRouter\)/);
    assert.match(automationRoutes, /internalAutomationRouter\.post\("\/callback\/smoke"/);
    assert.match(automationRoutes, /SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED/);
    assert.match(automationRoutes, /AUTOMATION_SMOKE_CALLBACK_DISABLED/);
    assert.match(automationRoutes, /verifySignedAutomationCallback/);
    assert.match(automationRoutes, /startsWith\("SMOKE_"\)/);
    assert.match(automationRoutes, /SMOKE_CALLBACK_OTP_CODE_REJECTED/);
    assert.match(envSource, /SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED:\s*envBoolean\(false\)/);
  });

  it("wires merchant, internal, and admin automation routes through scoped auth", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const automationRoutes = readFileSync("src/modules/automation/automation.routes.ts", "utf8");
    const automationService = readFileSync("src/modules/automation/autopilot.service.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/automation", requireJwtAuth, requireReadyMerchantAutopilotAccess, automationRouter\)/);
    assert.match(routes, /apiRouter\.use\("\/internal\/automation", requireInternalSecret, internalAutomationRouter\)/);
    assert.match(routes, /apiRouter\.use\("\/admin\/automation", requireAdminJwt, adminAutomationRouter\)/);
    assert.match(automationRoutes, /automationRouter\.get\("\/overview"[\s\S]*const merchantId = req\.auth!\.merchantId/);
    assert.match(automationRoutes, /automationRouter\.get\("\/channel-readiness"[\s\S]*const merchantId = req\.auth!\.merchantId/);
    assert.match(automationRoutes, /automationRouter\.post\("\/channels\/email\/connect"[\s\S]*const merchantId = req\.auth!\.merchantId/);
    assert.match(automationRoutes, /automationRouter\.post\("\/channels\/whatsapp\/connect"[\s\S]*const merchantId = req\.auth!\.merchantId/);
    assert.match(automationRoutes, /automationRouter\.post\("\/campaigns"[\s\S]*const merchantId = req\.auth!\.merchantId/);
    assert.match(automationRoutes, /automationRouter\.patch\("\/workflows\/:key"[\s\S]*const merchantId = req\.auth!\.merchantId/);
    assert.match(automationService, /AUTOMATION_CALLBACK_MERCHANT_MISMATCH/);
    assert.match(automationRoutes, /verifySignedAutomationCallback/);
  });

  it("requires the internal task secret for internal automation routes", () => {
    const nextCalls: string[] = [];
    const makeReq = (secret?: string) => ({
      header(name: string) {
        if (name.toLowerCase() === "x-shipmastr-task-secret") return secret;
        return undefined;
      }
    });

    assert.throws(
      () => requireInternalSecret(makeReq() as any, {} as any, () => nextCalls.push("next")),
      /UNAUTHORIZED_INTERNAL_TASK/
    );
    assert.throws(
      () => requireInternalSecret(makeReq("wrong-secret") as any, {} as any, () => nextCalls.push("next")),
      /UNAUTHORIZED_INTERNAL_TASK/
    );
    requireInternalSecret(makeReq(env.SHIPMASTR_INTERNAL_SECRET || env.WEBHOOK_SECRET) as any, {} as any, () => nextCalls.push("next"));
    assert.deepEqual(nextCalls, ["next"]);
  });

  it("keeps production automation callback strict for unknown real events", async () => {
    configureCallbackTestEnv(true);
    mockPrismaMethod("automationEvent", "findUnique", async () => null);

    await assert.rejects(
      handleAutomationCallback({ eventId: "real_unknown_event", status: "PROCESSED" }),
      (error: unknown) => error instanceof AutomationCallbackError &&
        error.status === 404 &&
        error.message === "AUTOMATION_EVENT_NOT_FOUND"
    );
  });

  it("keeps the smoke callback route behind an explicit disabled-by-default env gate", () => {
    configureCallbackTestEnv(false);

    assert.equal(env.SHIPMASTR_AUTOMATION_SMOKE_CALLBACKS_ENABLED, false);
  });

  it("accepts valid synthetic smoke callback body shape", () => {
    configureCallbackTestEnv(true);
    const body = { synthetic: true, eventId: "SMOKE_SM_11_COD_RISK_HIGH", event: { id: "SMOKE_SM_11_COD_RISK_HIGH" }, status: "PROCESSED" };
    const result = validateAutomationSmokeCallbackBody(body);

    assert.equal(result.ok, true);
    assert.equal(result.eventId, "SMOKE_SM_11_COD_RISK_HIGH");
  });

  it("rejects smoke callbacks with non-SMOKE event IDs", () => {
    configureCallbackTestEnv(true);
    const body = { synthetic: true, eventId: "REAL_EVENT", event: { id: "REAL_EVENT" }, status: "PROCESSED" };
    const result = validateAutomationSmokeCallbackBody(body);

    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_SMOKE_CALLBACK_EVENT_ID");
  });

  it("rejects smoke callbacks with missing or bad timestamp", () => {
    configureCallbackTestEnv(true);
    const body = { synthetic: true, eventId: "SMOKE_BAD_TIMESTAMP", event: { id: "SMOKE_BAD_TIMESTAMP" }, status: "PROCESSED" };
    const bodyText = JSON.stringify(body);

    assert.equal(verifyAutomationSignature({
      body: bodyText,
      signature: createAutomationSignature(bodyText, new Date().toISOString())
    }), false);
    assert.equal(verifyAutomationSignature({
      body: bodyText,
      timestamp: "not-a-date",
      signature: createAutomationSignature(bodyText, "not-a-date")
    }), false);
  });

  it("rejects smoke callbacks with missing or bad signature", () => {
    configureCallbackTestEnv(true);
    const body = { synthetic: true, eventId: "SMOKE_BAD_SIGNATURE", event: { id: "SMOKE_BAD_SIGNATURE" }, status: "PROCESSED" };
    const bodyText = JSON.stringify(body);
    const timestamp = new Date().toISOString();

    assert.equal(verifyAutomationSignature({ body: bodyText, timestamp }), false);
    assert.equal(verifyAutomationSignature({ body: bodyText, timestamp, signature: "bad-signature" }), false);
  });

  it("rejects smoke callbacks when the signed body is tampered", () => {
    configureCallbackTestEnv(true);
    const signedBody = { synthetic: true, eventId: "SMOKE_SIGNED", event: { id: "SMOKE_SIGNED" }, status: "PROCESSED" };
    const tamperedBody = { synthetic: true, eventId: "SMOKE_TAMPERED", event: { id: "SMOKE_TAMPERED" }, status: "PROCESSED" };
    const timestamp = new Date().toISOString();
    const signature = createAutomationSignature(JSON.stringify(signedBody), timestamp);

    assert.equal(verifyAutomationSignature({
      body: JSON.stringify(tamperedBody),
      timestamp,
      signature
    }), false);
  });

  it("rejects OTP code fields in smoke callback payloads", () => {
    configureCallbackTestEnv(true);
    const body = {
      synthetic: true,
      eventId: "SMOKE_OTP_REJECTED",
      event: { id: "SMOKE_OTP_REJECTED" },
      status: "PROCESSED",
      result: { otpCode: "123456" }
    };
    const result = validateAutomationSmokeCallbackBody(body);

    assert.equal(result.ok, false);
    assert.equal(result.error, "SMOKE_CALLBACK_OTP_CODE_REJECTED");
  });

  it("keeps order creation automation emission non-blocking", () => {
    const source = readFileSync("src/modules/orders/orders.routes.ts", "utf8");

    assert.match(source, /void Promise\.all\(eventsToEmit\)\.catch/);
    assert.match(source, /automation\.order_event_emit_failed/);
  });

  it("documents the Autopilot migration indexes", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const migration = readFileSync(
      "prisma/migrations/20260514103000_add_shipmastr_autopilot/migration.sql",
      "utf8"
    );

    assert.match(schema, /@@unique\(\[merchantId, idempotencyKey\]\)/);
    assert.match(schema, /@@unique\(\[merchantId, idempotencyKey\]\)[\s\S]*model AutomationPreference/);
    assert.match(schema, /model CommunicationLog[\s\S]*idempotencyKey\s+String\?/);
    assert.match(schema, /model AutomationUsageMeter/);
    assert.match(migration, /CREATE UNIQUE INDEX "AutomationEvent_merchantId_idempotencyKey_key"/);
    assert.match(migration, /CREATE INDEX "AutomationEvent_idempotencyKey_idx"/);
    assert.match(migration, /CREATE UNIQUE INDEX "AutomationUsageMeter_merchantId_monthKey_usageType_eventKey_workflowKey_channel_key"/);
  });
});
