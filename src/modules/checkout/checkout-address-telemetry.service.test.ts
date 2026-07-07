import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { afterEach, beforeEach, describe, it } from "node:test";

import { errorHandler } from "../../middleware/error.js";
import { HttpError } from "../../lib/httpError.js";
import {
  ADDRESS_EVENTS_BATCH_LIMIT,
  CheckoutAddressTelemetryService,
  sanitizeAddressEventMeta,
  type AddressEventInput
} from "./checkout-address-telemetry.service.js";
import { createCheckoutAddressEventsRouter } from "./checkout-address-events.routes.js";
import {
  CheckoutAddressSessionService,
  type CheckoutAddressSessionContext,
  type VerifiedCheckoutSessionContext
} from "./checkout-address-session.service.js";
import { OtpVerifier, TruecallerVerifier } from "./checkout-phone-verifier.js";
import { CheckoutAddressGraphService } from "./checkout-address-graph.service.js";

const baseTime = new Date("2026-07-07T13:30:00.000Z");
const originalEnv = { ...process.env };

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function setAddressTelemetryTestEnv() {
  process.env.NODE_ENV = "test";
  process.env.ADDRESS_PHONE_PEPPER = "address-phone-pepper-test-value";
  process.env.CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET = "checkout-address-session-token-secret-test-value";
  process.env.CHECKOUT_DEV_OTP_CODE = "123456";
}

beforeEach(setAddressTelemetryTestEnv);

afterEach(() => {
  process.env = { ...originalEnv };
});

function makeAddressEventClient() {
  const state = {
    events: [] as any[]
  };
  const client: any = {
    addressEvent: {
      create: async ({ data }: any) => {
        const row = {
          id: `address_event_${state.events.length + 1}`,
          createdAt: baseTime,
          ...data
        };
        state.events.push(row);
        return clone(row);
      },
      createMany: async ({ data }: any) => {
        for (const item of data) {
          state.events.push({
            id: `address_event_${state.events.length + 1}`,
            createdAt: baseTime,
            ...item
          });
        }
        return { count: data.length };
      }
    }
  };
  return { client, state };
}

function makeAddressTelemetryService() {
  const { client, state } = makeAddressEventClient();
  return { state, service: new CheckoutAddressTelemetryService(client) };
}

async function assertHttpError(promise: Promise<unknown>, status: number, message: string) {
  await assert.rejects(
    promise,
    (error) => error instanceof HttpError && error.status === status && error.message === message
  );
}

function baseEvent(input: Partial<AddressEventInput> = {}): AddressEventInput {
  return {
    sessionId: "address_session_1",
    merchantId: "merchant_a",
    event: "abandoned_at_address",
    meta: {},
    ...input
  };
}

function expectEvent(events: AddressEventInput[], index = 0) {
  const event = events[index];
  if (!event) throw new Error("ADDRESS_EVENT_EXPECTED");
  return event;
}

describe("Checkout Address A4 telemetry service", () => {
  it("records allowed events with sanitized meta and defaults meta to empty object", async () => {
    const { state, service } = makeAddressTelemetryService();
    const event = await service.recordAddressEvent(baseEvent({
      event: "pincode_resolved",
      meta: { pincode: "110001", provider: "otp" }
    }));
    const defaultMeta = await service.recordAddressEvent(baseEvent({ event: "graph_miss" }));

    assert.equal(event.event, "pincode_resolved");
    assert.deepEqual(event.meta, { pincode: "110001", provider: "otp" });
    assert.deepEqual(defaultMeta.meta, {});
    assert.equal(state.events.length, 2);
  });

  it("rejects unknown events and enforces batch limits", async () => {
    const { service } = makeAddressTelemetryService();
    await assertHttpError(service.recordAddressEvent(baseEvent({ event: "unknown_event" })), 400, "ADDRESS_EVENT_UNKNOWN");

    const oversized = Array.from({ length: ADDRESS_EVENTS_BATCH_LIMIT + 1 }, (_, index) => baseEvent({
      sessionId: `session_${index}`,
      event: "abandoned_at_address"
    }));
    await assertHttpError(service.recordAddressEventsBatch(oversized), 400, "ADDRESS_EVENT_BATCH_TOO_LARGE");
  });

  it("records batches with a single createMany append-only path", async () => {
    const { state, service } = makeAddressTelemetryService();
    const result = await service.recordAddressEventsBatch([
      baseEvent({ event: "prefill_offered", meta: { count: 1 } }),
      baseEvent({ event: "prefill_edited", meta: { field: "city" } })
    ]);
    const prototypeMethods = Object.getOwnPropertyNames(CheckoutAddressTelemetryService.prototype).join("\n");

    assert.deepEqual(result, { count: 2 });
    assert.equal(state.events.length, 2);
    assert.equal(/update|delete/i.test(prototypeMethods), false);
  });
});

describe("Checkout Address A4 telemetry sanitization", () => {
  it("redacts unsafe scalar values and strips unsafe keys while preserving safe metrics", () => {
    const sanitized = sanitizeAddressEventMeta({
      phone: "9876543243",
      mobile: "+919876543243",
      email: "buyer@example.com",
      ip: "203.0.113.15",
      line1: "Flat 4B, Connaught Place",
      line2: "Near Market",
      landmark: "Gate 2",
      fullName: "Riya Sharma",
      name: "Riya",
      proof: "123456",
      otp: "123456",
      token: "secret-token",
      phoneHash: "hash_should_not_survive",
      pincode: "110001",
      provider: "otp",
      source: "manual",
      quality: 2,
      deduped: false,
      consentScope: "network",
      latencyMs: 42,
      field: "line1",
      count: 3,
      reason: "buyer paused at the address screen",
      status: "started",
      route: "/checkout/address",
      step: "address",
      safeNested: {
        emailValue: "nested@example.com",
        values: [
          "merchant-safe",
          "buyer@example.com",
          "9876543210",
          "2001:db8::1",
          "This is a long Flat 99 Building Road address-like string with obvious location words"
        ]
      }
    });

    assert.deepEqual(Object.keys(sanitized).filter((key) => /phone|mobile|email|ip|line|landmark|fullName|fullname|name|proof|otp|token|hash/i.test(key)), []);
    assert.equal(sanitized.pincode, "110001");
    assert.equal(sanitized.provider, "otp");
    assert.equal(sanitized.source, "manual");
    assert.equal(sanitized.quality, 2);
    assert.equal(sanitized.deduped, false);
    assert.equal(sanitized.consentScope, "network");
    assert.equal(sanitized.latencyMs, 42);
    assert.equal(sanitized.field, "line1");
    assert.equal(sanitized.count, 3);
    assert.equal(sanitized.reason, "buyer paused at the address screen");
    assert.equal(sanitized.status, "started");
    assert.equal(sanitized.route, "/checkout/address");
    assert.equal(sanitized.step, "address");
    assert.deepEqual((sanitized.safeNested as any).values, [
      "merchant-safe",
      "[redacted]",
      "[redacted]",
      "[redacted]",
      "[redacted]"
    ]);
    assert.equal("emailValue" in (sanitized.safeNested as any), false);
    assert.equal(JSON.stringify(sanitized).includes("hash_should_not_survive"), false);
  });

  it("normalizes non-object meta to an empty object", () => {
    assert.deepEqual(sanitizeAddressEventMeta(null), {});
    assert.deepEqual(sanitizeAddressEventMeta(["phone", "9876543210"]), {});
    assert.deepEqual(sanitizeAddressEventMeta("buyer@example.com"), {});
  });
});

function makeA2Harness() {
  const telemetryEvents: AddressEventInput[] = [];
  const state = {
    now: new Date(baseTime),
    merchants: [{ id: "merchant_a" }],
    sessions: [] as any[]
  };
  const client: any = {
    merchant: {
      findUnique: async ({ where }: any) => clone(state.merchants.find((row) => row.id === where.id) ?? null)
    },
    checkoutAddressSession: {
      create: async ({ data }: any) => {
        const row = {
          provider: null,
          verificationHandleHash: null,
          verificationExpiresAt: null,
          verificationAttempts: 0,
          phoneHash: null,
          phoneLast2: null,
          profileName: null,
          verifiedAt: null,
          createdAt: state.now,
          updatedAt: state.now,
          ...data
        };
        state.sessions.push(row);
        return clone(row);
      },
      findUnique: async ({ where }: any) => {
        if (where.tokenHash) return clone(state.sessions.find((row) => row.tokenHash === where.tokenHash) ?? null);
        if (where.id) return clone(state.sessions.find((row) => row.id === where.id) ?? null);
        return null;
      },
      update: async ({ where, data }: any) => {
        const row = state.sessions.find((item) => item.id === where.id);
        if (!row) throw new Error("SESSION_NOT_FOUND");
        Object.assign(row, data, { updatedAt: state.now });
        return clone(row);
      }
    }
  };
  const telemetryRecorder = async (event: AddressEventInput) => {
    telemetryEvents.push(clone(event));
  };
  const service = new CheckoutAddressSessionService(
    client,
    () => state.now,
    new OtpVerifier(),
    new TruecallerVerifier(),
    telemetryRecorder
  );
  return { state, service, telemetryEvents };
}

describe("Checkout Address A4 A2 integration", () => {
  it("records phone_verified after successful phone confirmation with provider-only meta", async () => {
    const { state, service, telemetryEvents } = makeA2Harness();
    const created = await service.createSession({ merchantId: "merchant_a", cartId: "cart_a" });
    const started = await service.startPhoneVerification({
      sessionToken: created.sessionToken,
      phone: "9876543243",
      provider: "otp"
    });
    await service.confirmPhoneVerification({
      sessionToken: created.sessionToken,
      verificationHandle: String(started.verificationHandle),
      proof: "123456"
    });

    assert.equal(telemetryEvents.length, 1);
    const event = expectEvent(telemetryEvents);
    const session = state.sessions[0];
    if (!session) throw new Error("CHECKOUT_SESSION_EXPECTED");
    assert.equal(event.event, "phone_verified");
    assert.equal(event.sessionId, session.id);
    assert.equal(event.merchantId, "merchant_a");
    assert.equal(event.shopperId, undefined);
    assert.deepEqual(event.meta, { provider: "otp" });
    assert.equal(/phone|phoneHash|proof|handle|token|email|ip|address/i.test(JSON.stringify(event.meta)), false);
  });
});

function makeA3Harness() {
  const telemetryEvents: AddressEventInput[] = [];
  const verified: VerifiedCheckoutSessionContext = {
    sessionId: "session_verified",
    merchantId: "merchant_a",
    cartId: "cart_a",
    phoneHash: "phone_hash_private",
    phoneLast2: "43",
    profileName: "Private Profile"
  };
  const state = {
    now: new Date(baseTime),
    identitySeq: 0,
    addressSeq: 0,
    consentSeq: 0,
    identities: [] as any[],
    addresses: [] as any[],
    consents: [] as any[]
  };
  const client: any = {
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(client),
    shopperIdentity: {
      upsert: async ({ where, create, update }: any) => {
        const existing = state.identities.find((row) => row.phoneHash === where.phoneHash);
        if (existing) {
          Object.assign(existing, update);
          return clone(existing);
        }
        const row = {
          id: `shopper_${++state.identitySeq}`,
          createdAt: state.now,
          lastSeenAt: state.now,
          ...create
        };
        state.identities.push(row);
        return clone(row);
      }
    },
    shopperAddress: {
      findMany: async ({ where }: any) => clone(state.addresses.filter((row) => row.shopperId === where.shopperId && row.pincode === where.pincode)),
      create: async ({ data }: any) => {
        const row = { id: `address_${++state.addressSeq}`, createdAt: state.now, updatedAt: state.now, ...data };
        state.addresses.push(row);
        return clone(row);
      },
      update: async ({ where, data }: any) => {
        const row = state.addresses.find((item) => item.id === where.id);
        if (!row) throw new Error("ADDRESS_NOT_FOUND");
        const next = { ...data };
        if (data.useCount?.increment) next.useCount = row.useCount + data.useCount.increment;
        Object.assign(row, next, { updatedAt: state.now });
        return clone(row);
      }
    },
    addressConsent: {
      create: async ({ data }: any) => {
        const row = { id: `consent_${++state.consentSeq}`, grantedAt: state.now, expiresAt: null, revokedAt: null, ...data };
        state.consents.push(row);
        return clone(row);
      }
    }
  };
  const pincodeLookup = {
    lookup: async () => ({ city: "New Delhi", district: "Central Delhi", state: "Delhi", localities: [] })
  };
  const telemetryRecorder = async (event: AddressEventInput) => {
    telemetryEvents.push(clone(event));
  };
  const service = new CheckoutAddressGraphService(
    client,
    async () => clone(verified),
    pincodeLookup,
    () => state.now,
    telemetryRecorder
  );
  return { state, client, verified, pincodeLookup, service, telemetryEvents };
}

describe("Checkout Address A4 A3 integration", () => {
  it("records manual_completed after address persistence with safe meta only", async () => {
    const { service, telemetryEvents } = makeA3Harness();
    await service.persistCheckoutAddress("verified_token", {
      fullName: "Riya Sharma",
      line1: "Flat 4B, Connaught Place",
      line2: "Near Market",
      landmark: "Gate 2",
      pincode: "110001",
      source: "manual",
      quality: 2,
      consentScope: "network",
      consentTextVersion: "address-save-v1"
    });

    assert.equal(telemetryEvents.length, 1);
    const event = expectEvent(telemetryEvents);
    assert.equal(event.event, "manual_completed");
    assert.equal(event.sessionId, "session_verified");
    assert.equal(event.merchantId, "merchant_a");
    assert.equal(event.shopperId, "shopper_1");
    assert.deepEqual(event.meta, {
      source: "manual",
      quality: 2,
      consentScope: "network",
      deduped: false,
      pincode: "110001"
    });
    assert.equal(/fullName|line1|line2|landmark|phone|phoneHash|profileName/i.test(JSON.stringify(event)), false);
  });

  it("does not block address persistence when telemetry recording fails", async () => {
    const { state, client, verified, pincodeLookup } = makeA3Harness();
    const service = new CheckoutAddressGraphService(
      client,
      async () => clone(verified),
      pincodeLookup,
      () => baseTime,
      async () => { throw new Error("TELEMETRY_DOWN"); }
    );
    const result = await service.persistCheckoutAddress("verified_token", {
      fullName: "Riya Sharma",
      line1: "Flat 4B, Connaught Place",
      pincode: "110001",
      consentTextVersion: "address-save-v1"
    });

    assert.deepEqual(result, { addressId: "address_1", deduped: false });
    assert.equal(state.addresses.length, 1);
  });
});

async function createApp(service: CheckoutAddressTelemetryService, sessionResolver: (token: string) => Promise<CheckoutAddressSessionContext>) {
  const app = express();
  app.use(express.json());
  app.use("/v1/events/address", createCheckoutAddressEventsRouter({ service, sessionResolver }));
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_BIND_FAILED");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

describe("Checkout Address A4 client ingest route", () => {
  it("mounts POST /v1/events/address through the API router", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    assert.match(routes, /import \{ checkoutAddressEventsRouter \}/);
    assert.match(routes, /apiRouter\.use\("\/events\/address", checkoutAddressEventsRouter\);/);
  });

  it("accepts a valid batch without a token using explicit session and merchant ids", async () => {
    const { state, service } = makeAddressTelemetryService();
    const app = await createApp(service, async () => { throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_INVALID"); });
    try {
      const response = await request(app.baseUrl, "/v1/events/address", {
        method: "POST",
        body: JSON.stringify({
          events: [baseEvent({
            event: "abandoned_at_address",
            meta: { pincode: "110001", phone: "9876543243" }
          })]
        })
      });

      assert.equal(response.status, 204);
      assert.equal(state.events.length, 1);
      assert.equal(state.events[0].sessionId, "address_session_1");
      assert.equal(state.events[0].merchantId, "merchant_a");
      assert.deepEqual(state.events[0].meta, { pincode: "110001" });
    } finally {
      await closeServer(app.server);
    }
  });

  it("derives session and merchant from x-checkout-session-token without requiring verified status", async () => {
    const { state, service } = makeAddressTelemetryService();
    const app = await createApp(service, async (token) => {
      assert.equal(token, "created_session_token");
      return {
        sessionId: "derived_session",
        merchantId: "derived_merchant",
        cartId: "cart_1",
        status: "created"
      };
    });
    try {
      const response = await request(app.baseUrl, "/v1/events/address", {
        method: "POST",
        headers: { "x-checkout-session-token": "created_session_token" },
        body: JSON.stringify({
          events: [{
            sessionId: "client_session",
            merchantId: "client_merchant",
            event: "abandoned_at_address",
            meta: { pincode: "110001", status: "started" }
          }]
        })
      });

      assert.equal(response.status, 204);
      assert.equal(state.events[0].sessionId, "derived_session");
      assert.equal(state.events[0].merchantId, "derived_merchant");
      assert.deepEqual(state.events[0].meta, { pincode: "110001", status: "started" });
    } finally {
      await closeServer(app.server);
    }
  });

  it("rejects invalid or expired session tokens", async () => {
    const { service } = makeAddressTelemetryService();
    const app = await createApp(service, async (token) => {
      if (token === "expired") throw new HttpError(401, "CHECKOUT_SESSION_EXPIRED");
      throw new HttpError(401, "CHECKOUT_SESSION_TOKEN_INVALID");
    });
    try {
      const invalid = await request(app.baseUrl, "/v1/events/address", {
        method: "POST",
        headers: { "x-checkout-session-token": "invalid" },
        body: JSON.stringify({ events: [{ event: "abandoned_at_address", meta: {} }] })
      });
      const expired = await request(app.baseUrl, "/v1/events/address", {
        method: "POST",
        headers: { "x-checkout-session-token": "expired" },
        body: JSON.stringify({ events: [{ event: "abandoned_at_address", meta: {} }] })
      });

      assert.equal(invalid.status, 401);
      assert.equal(invalid.body.error, "CHECKOUT_SESSION_TOKEN_INVALID");
      assert.equal(expired.status, 401);
      assert.equal(expired.body.error, "CHECKOUT_SESSION_EXPIRED");
    } finally {
      await closeServer(app.server);
    }
  });

  it("rejects unknown events, invalid payloads, and oversized batches", async () => {
    const { service } = makeAddressTelemetryService();
    const app = await createApp(service, async () => ({ sessionId: "s", merchantId: "m", cartId: null, status: "created" }));
    try {
      const unknown = await request(app.baseUrl, "/v1/events/address", {
        method: "POST",
        body: JSON.stringify({ events: [{ sessionId: "s", merchantId: "m", event: "unknown_event" }] })
      });
      const invalid = await request(app.baseUrl, "/v1/events/address", {
        method: "POST",
        body: JSON.stringify({ event: "abandoned_at_address" })
      });
      const oversized = await request(app.baseUrl, "/v1/events/address", {
        method: "POST",
        body: JSON.stringify({
          events: Array.from({ length: ADDRESS_EVENTS_BATCH_LIMIT + 1 }, () => ({
            sessionId: "s",
            merchantId: "m",
            event: "abandoned_at_address"
          }))
        })
      });

      assert.equal(unknown.status, 400);
      assert.equal(invalid.status, 400);
      assert.equal(oversized.status, 400);
    } finally {
      await closeServer(app.server);
    }
  });
});

describe("Checkout Address A4 safety boundaries", () => {
  it("adds no external API calls in address telemetry code", () => {
    const sources = [
      "src/modules/checkout/checkout-address-telemetry.service.ts",
      "src/modules/checkout/checkout-address-events.routes.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");

    assert.equal(/twilio|msg91|gupshup|interakt|wati|aisensy|truecaller\.com|places\.googleapis|addressvalidation|fetch\s*\(|axios|https?:\/\//i.test(sources), false);
  });

  it("does not touch payment, wallet, settlement, payout, Razorpay, Cashfree, or COD ledger source paths", () => {
    const changedSurface = [
      "prisma/schema.prisma",
      "prisma/migrations/20260707133000_address_a4_telemetry/migration.sql",
      "src/modules/checkout/checkout-address-telemetry.service.ts",
      "src/modules/checkout/checkout-address-events.routes.ts",
      "src/modules/checkout/checkout-address-telemetry.service.test.ts",
      "src/modules/checkout/checkout-address-session.service.ts",
      "src/modules/checkout/checkout-address-graph.service.ts",
      "src/routes/index.ts"
    ].join("\n");

    assert.equal(/payment|wallet|settlement|payout|razorpay|cashfree|cod.?ledger/i.test(changedSurface), false);
  });
});
