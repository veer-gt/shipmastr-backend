import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  CheckoutTelemetryService,
  deriveCheckoutTelemetryDeviceType
} from "./checkout-telemetry.service.js";

const baseTime = new Date("2026-07-06T10:00:00.000Z");

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function uniqueConflict() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

function matchesWhere(row: any, where: any = {}) {
  for (const [key, value] of Object.entries(where)) {
    if (row[key] !== value) return false;
  }
  return true;
}

function makeTelemetryClient() {
  const state = {
    sessions: [] as any[],
    events: [] as any[],
    paymentAttempts: [] as any[],
    failures: [] as any[]
  };

  const client: any = {
    checkoutTelemetrySession: {
      upsert: async ({ where, create, update }: any) => {
        const unique = where.merchantId_sessionId;
        const existing = state.sessions.find((row) => row.merchantId === unique.merchantId && row.sessionId === unique.sessionId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: baseTime });
          return clone(existing);
        }
        const row = {
          id: `telemetry_session_${state.sessions.length + 1}`,
          createdAt: baseTime,
          updatedAt: baseTime,
          ...create
        };
        state.sessions.push(row);
        return clone(row);
      }
    },
    checkoutTelemetryEvent: {
      create: async ({ data }: any) => {
        if (data.idempotencyKey) {
          const existing = state.events.find((row) =>
            row.telemetrySessionId === data.telemetrySessionId
            && row.eventName === data.eventName
            && row.idempotencyKey === data.idempotencyKey
          );
          if (existing) throw uniqueConflict();
        }
        const row = {
          id: `telemetry_event_${state.events.length + 1}`,
          createdAt: baseTime,
          ...data
        };
        state.events.push(row);
        return clone(row);
      },
      findUnique: async ({ where }: any) => {
        const unique = where.telemetrySessionId_eventName_idempotencyKey;
        return clone(state.events.find((row) => matchesWhere(row, unique)) ?? null);
      }
    },
    checkoutTelemetryPaymentAttempt: {
      create: async ({ data }: any) => {
        const row = {
          id: `telemetry_payment_attempt_${state.paymentAttempts.length + 1}`,
          createdAt: baseTime,
          updatedAt: baseTime,
          ...data
        };
        state.paymentAttempts.push(row);
        return clone(row);
      }
    },
    checkoutTelemetryFailure: {
      create: async ({ data }: any) => {
        const row = {
          id: `telemetry_failure_${state.failures.length + 1}`,
          createdAt: baseTime,
          ...data
        };
        state.failures.push(row);
        return clone(row);
      }
    }
  };

  return { client, state };
}

function makeService(client: any) {
  return new CheckoutTelemetryService(client, () => baseTime);
}

function baseSessionInput(overrides: Record<string, unknown> = {}) {
  return {
    merchantId: "merchant_telemetry",
    sessionId: "session_telemetry",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    ...overrides
  };
}

describe("CheckoutTelemetryService", () => {
  it("creates telemetry sessions and defaults sellerId to null", async () => {
    const { client, state } = makeTelemetryClient();
    const session = await makeService(client).createOrUpdateSession(baseSessionInput({
      cartValueMinor: "159900",
      cartSize: 2
    }));

    assert.equal(session.id, "telemetry_session_1");
    assert.equal(session.sellerId, null);
    assert.equal(session.deviceType, "DESKTOP");
    assert.equal(session.status, "STARTED");
    assert.equal(session.cartValueMinor, 159900n);
    assert.equal(state.sessions.length, 1);
  });

  it("derives checkout telemetry device type from user agent deterministically", () => {
    assert.equal(deriveCheckoutTelemetryDeviceType("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148"), "MOBILE");
    assert.equal(deriveCheckoutTelemetryDeviceType("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"), "DESKTOP");
    assert.equal(deriveCheckoutTelemetryDeviceType("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15"), "TABLET");
    assert.equal(deriveCheckoutTelemetryDeviceType("Googlebot/2.1 (+http://www.google.com/bot.html)"), "BOT");
    assert.equal(deriveCheckoutTelemetryDeviceType("shipmastr-test-agent"), "UNKNOWN");
  });

  it("hashes buyer email and phone without storing raw contact values", async () => {
    const { client, state } = makeTelemetryClient();
    const service = makeService(client);

    const session = await service.createOrUpdateSession(baseSessionInput({
      email: "Buyer@Example.com",
      phone: "+91 98765 43210"
    }));

    assert.ok(session.emailHash);
    assert.ok(session.phoneHash);
    assert.notEqual(session.emailHash, "Buyer@Example.com");
    assert.notEqual(session.phoneHash, "+91 98765 43210");
    assert.equal("email" in session, false);
    assert.equal("phone" in session, false);

    await service.recordEvent({
      telemetrySessionId: session.id,
      merchantId: session.merchantId,
      eventName: "checkout_started",
      source: "FRONTEND",
      payloadJson: {
        email: "buyer@example.com",
        phone: "9876543210",
        nested: {
          whatsapp: "9876543210",
          emailHash: "already-safe"
        },
        label: "contact buyer@example.com",
        note: "call +91 98765 43210"
      }
    });

    assert.deepEqual(state.events[0].payloadJson, {
      nested: {
        emailHash: "already-safe"
      },
      label: "[redacted]",
      note: "[redacted]"
    });
  });

  it("records immutable telemetry events and dedupes keyed event retries", async () => {
    const { client, state } = makeTelemetryClient();
    const service = makeService(client);
    const session = await service.createOrUpdateSession(baseSessionInput());

    const first = await service.recordEvent({
      telemetrySessionId: session.id,
      merchantId: session.merchantId,
      eventName: "checkout_started",
      idempotencyKey: "request_1",
      source: "FRONTEND",
      payloadJson: { cartSize: 1 }
    });
    const retry = await service.recordEvent({
      telemetrySessionId: session.id,
      merchantId: session.merchantId,
      eventName: "checkout_started",
      idempotencyKey: "request_1",
      source: "FRONTEND",
      payloadJson: { cartSize: 1 }
    });

    assert.equal(first.id, retry.id);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].payloadJson.cartSize, 1);
  });

  it("handles concurrent duplicate keyed writes without creating duplicate events", async () => {
    const { client, state } = makeTelemetryClient();
    const service = makeService(client);
    const session = await service.createOrUpdateSession(baseSessionInput());

    const [first, second] = await Promise.all([
      service.recordEvent({
        telemetrySessionId: session.id,
        merchantId: session.merchantId,
        eventName: "payment_succeeded",
        checkoutOrderId: "checkout_order_1",
        checkoutPaymentId: "checkout_payment_1",
        idempotencyKey: "payment_event_1",
        source: "PAYMENT_WEBHOOK"
      }),
      service.recordEvent({
        telemetrySessionId: session.id,
        merchantId: session.merchantId,
        eventName: "payment_succeeded",
        checkoutOrderId: "checkout_order_1",
        checkoutPaymentId: "checkout_payment_1",
        idempotencyKey: "payment_event_1",
        source: "PAYMENT_WEBHOOK"
      })
    ]);

    assert.equal(first.id, second.id);
    assert.equal(state.events.length, 1);
  });

  it("requires authoritative checkout links for order_placed and payment_succeeded events", async () => {
    const { client } = makeTelemetryClient();
    const service = makeService(client);
    const session = await service.createOrUpdateSession(baseSessionInput());

    await assert.rejects(
      service.recordEvent({
        telemetrySessionId: session.id,
        merchantId: session.merchantId,
        eventName: "order_placed",
        source: "ORDER_SERVICE"
      }),
      (error: any) => error.status === 400
        && error.message === "CHECKOUT_TELEMETRY_AUTHORITATIVE_LINK_REQUIRED"
        && error.details?.field === "checkoutOrderId"
    );

    await assert.rejects(
      service.recordEvent({
        telemetrySessionId: session.id,
        merchantId: session.merchantId,
        eventName: "payment_succeeded",
        checkoutOrderId: "checkout_order_1",
        source: "PAYMENT_WEBHOOK"
      }),
      (error: any) => error.status === 400
        && error.message === "CHECKOUT_TELEMETRY_AUTHORITATIVE_LINK_REQUIRED"
        && error.details?.field === "checkoutPaymentId"
    );
  });

  it("allows unkeyed repeat events", async () => {
    const { client, state } = makeTelemetryClient();
    const service = makeService(client);
    const session = await service.createOrUpdateSession(baseSessionInput());

    await service.recordEvent({
      telemetrySessionId: session.id,
      merchantId: session.merchantId,
      eventName: "checkout_started",
      source: "FRONTEND"
    });
    await service.recordEvent({
      telemetrySessionId: session.id,
      merchantId: session.merchantId,
      eventName: "checkout_started",
      source: "FRONTEND"
    });

    assert.equal(state.events.length, 2);
    assert.notEqual(state.events[0].id, state.events[1].id);
  });

  it("creates payment attempt telemetry linked to CheckoutPayment when available", async () => {
    const { client } = makeTelemetryClient();
    const service = makeService(client);
    const session = await service.createOrUpdateSession(baseSessionInput());

    const attempt = await service.createPaymentAttempt({
      telemetrySessionId: session.id,
      merchantId: session.merchantId,
      checkoutOrderId: "checkout_order_1",
      checkoutPaymentId: "checkout_payment_1",
      paymentMethod: "upi",
      gatewayUsed: "mock",
      amountMinor: "103920",
      status: "STARTED",
      attemptNumber: 1
    });

    assert.equal(attempt.checkoutPaymentId, "checkout_payment_1");
    assert.equal(attempt.amountMinor, 103920n);
    assert.equal(attempt.status, "STARTED");
  });

  it("creates failure telemetry with stage and payment attempt fields", async () => {
    const { client } = makeTelemetryClient();
    const service = makeService(client);
    const session = await service.createOrUpdateSession(baseSessionInput());

    const failure = await service.createFailure({
      telemetrySessionId: session.id,
      merchantId: session.merchantId,
      checkoutOrderId: "checkout_order_1",
      checkoutPaymentId: "checkout_payment_1",
      telemetryPaymentAttemptId: "telemetry_payment_attempt_1",
      failureStage: "PAYMENT",
      failureReason: "gateway_timeout",
      failureCode: "GATEWAY_TIMEOUT",
      amountAtRiskMinor: "299900",
      isRecoverable: true,
      source: "PAYMENT_WEBHOOK"
    });

    assert.equal(failure.failureStage, "PAYMENT");
    assert.equal(failure.checkoutPaymentId, "checkout_payment_1");
    assert.equal(failure.telemetryPaymentAttemptId, "telemetry_payment_attempt_1");
    assert.equal(failure.amountAtRiskMinor, 299900n);
    assert.equal(failure.isRecoverable, true);
  });

  it("accepts an explicit transaction client", async () => {
    const defaultHarness = makeTelemetryClient();
    const txHarness = makeTelemetryClient();
    const service = makeService(defaultHarness.client);

    await service.createOrUpdateSession(baseSessionInput({ sessionId: "tx_session" }), {
      client: txHarness.client
    });

    assert.equal(defaultHarness.state.sessions.length, 0);
    assert.equal(txHarness.state.sessions.length, 1);
    assert.equal(txHarness.state.sessions[0].sessionId, "tx_session");
  });
});

describe("checkout telemetry Prisma schema contract", () => {
  const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");
  const migration = readFileSync(
    new URL("../../../prisma/migrations/20260706130000_checkout_intelligence_c11_telemetry_foundation/migration.sql", import.meta.url),
    "utf8"
  );

  it("uses CheckoutTelemetry model names only and does not create forbidden generic checkout models", () => {
    assert.match(schema, /model CheckoutTelemetrySession\b/);
    assert.match(schema, /model CheckoutTelemetryEvent\b/);
    assert.match(schema, /model CheckoutTelemetryPaymentAttempt\b/);
    assert.match(schema, /model CheckoutTelemetryFailure\b/);
    for (const modelName of ["Checkout" + "Event", "Checkout" + "Failure", "Checkout" + "PaymentAttempt"]) {
      assert.doesNotMatch(schema, new RegExp(`model ${modelName}\\b`, "u"));
    }
    assert.doesNotMatch(schema, /model CheckoutTelemetryAbandonment\b/);
  });

  it("maps telemetry tables to snake_case checkout_telemetry names", () => {
    assert.match(schema, /@@map\("checkout_telemetry_sessions"\)/);
    assert.match(schema, /@@map\("checkout_telemetry_events"\)/);
    assert.match(schema, /@@map\("checkout_telemetry_payment_attempts"\)/);
    assert.match(schema, /@@map\("checkout_telemetry_failures"\)/);
    assert.doesNotMatch(schema, /@@map\("CheckoutTelemetry/);
    assert.doesNotMatch(migration, /CREATE TABLE "CheckoutTelemetry/);
  });

  it("keeps taxonomy fields as strings and documents idempotency uniqueness", () => {
    assert.doesNotMatch(schema, /enum CheckoutTelemetry/);
    assert.match(schema, /deviceType\s+String\s+@map\("device_type"\)/);
    assert.match(schema, /status\s+String\s+@default\("STARTED"\)/);
    assert.match(schema, /@@unique\(\[telemetrySessionId, eventName, idempotencyKey\]\)/);
    assert.match(
      migration,
      /CREATE UNIQUE INDEX "checkout_telemetry_events_telemetry_session_id_event_name_idempotency_key_key"/
    );
  });
});
