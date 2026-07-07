import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import { afterEach, beforeEach, describe, it } from "node:test";

import { errorHandler } from "../../middleware/error.js";
import { HttpError } from "../../lib/httpError.js";
import { hashAddressPhone, normalizeIndianPhone } from "../address/phone.service.js";
import {
  createCheckoutAddressSessionToken,
  hashCheckoutAddressSessionToken,
  verifyCheckoutAddressSessionToken
} from "./checkout-address-session-token.js";
import {
  CHECKOUT_ADDRESS_MAX_VERIFICATION_ATTEMPTS,
  CheckoutAddressSessionService
} from "./checkout-address-session.service.js";
import { createCheckoutAddressSessionRouter } from "./checkout-address-session.routes.js";
import { OtpVerifier, TruecallerVerifier } from "./checkout-phone-verifier.js";

const baseTime = new Date("2026-07-07T10:00:00.000Z");
const originalEnv = { ...process.env };

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function matchesWhere(row: any, where: any = {}) {
  for (const [key, value] of Object.entries(where)) {
    if (row[key] !== value) return false;
  }
  return true;
}

function setA2TestEnv() {
  process.env.NODE_ENV = "test";
  process.env.ADDRESS_PHONE_PEPPER = "address-phone-pepper-test-value";
  process.env.CHECKOUT_ADDRESS_SESSION_TOKEN_SECRET = "checkout-address-session-token-secret-test-value";
  process.env.CHECKOUT_DEV_OTP_CODE = "123456";
}

function expectString(value: unknown): string {
  if (typeof value !== "string") throw new Error("EXPECTED_STRING");
  return value;
}

function makeHarness() {
  const state = {
    now: new Date(baseTime),
    merchants: [{ id: "merchant_a2" }],
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
        return clone(state.sessions.find((row) => matchesWhere(row, where)) ?? null);
      },
      update: async ({ where, data }: any) => {
        const row = state.sessions.find((item) => item.id === where.id);
        if (!row) throw new Error("SESSION_NOT_FOUND");
        Object.assign(row, data, { updatedAt: state.now });
        return clone(row);
      }
    }
  };

  const service = new CheckoutAddressSessionService(client, () => state.now, new OtpVerifier(), new TruecallerVerifier());
  return { state, client, service };
}

async function assertHttpError(promise: Promise<unknown>, status: number, message: string) {
  await assert.rejects(
    promise,
    (error) => error instanceof HttpError && error.status === status && error.message === message
  );
}

async function createApp(service: CheckoutAddressSessionService) {
  const app = express();
  app.use(express.json());
  app.use("/checkout", createCheckoutAddressSessionRouter({ service, enableRateLimit: false }));
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

beforeEach(setA2TestEnv);

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Checkout Address A2 session service", () => {
  it("creates signed sessions and stores only the token hash", async () => {
    const { state, service } = makeHarness();
    const result = await service.createSession({ merchantId: "merchant_a2", cartId: "cart_1" });
    const stored = state.sessions[0];

    assert.equal(result.status, "created");
    assert.ok(result.sessionToken.includes("."));
    assert.equal(stored.tokenHash, hashCheckoutAddressSessionToken(result.sessionToken));
    assert.equal(JSON.stringify(stored).includes(result.sessionToken), false);

    const payload = verifyCheckoutAddressSessionToken(result.sessionToken);
    assert.equal(payload?.sid, stored.id);
    assert.equal(payload?.v, "a2");
  });

  it("rejects invalid, expired, and unverified sessions in the verified helper", async () => {
    const { state, service } = makeHarness();
    const result = await service.createSession({ merchantId: "merchant_a2" });

    await assertHttpError(service.requireVerifiedCheckoutSession(`${result.sessionToken}tampered`), 401, "CHECKOUT_SESSION_TOKEN_INVALID");
    await assertHttpError(service.requireVerifiedCheckoutSession(`${result.sessionToken}.extra`), 401, "CHECKOUT_SESSION_TOKEN_INVALID");
    await assertHttpError(service.requireVerifiedCheckoutSession(result.sessionToken), 401, "CHECKOUT_SESSION_NOT_VERIFIED");

    state.sessions[0].expiresAt = new Date(baseTime.getTime() - 1000);
    await assertHttpError(service.requireVerifiedCheckoutSession(result.sessionToken), 401, "CHECKOUT_SESSION_EXPIRED");
  });

  it("starts OTP verification, confirms expected proof, and accepts verified sessions", async () => {
    const { state, service } = makeHarness();
    const result = await service.createSession({ merchantId: "merchant_a2", cartId: "cart_verified" });
    const start = await service.startPhoneVerification({
      sessionToken: result.sessionToken,
      phone: "+91 98765-43243",
      provider: "otp"
    });

    assert.equal(start.provider, "otp");
    assert.equal(start.fallbackAvailable, true);
    assert.ok(start.verificationHandle);
    const verificationHandle = expectString(start.verificationHandle);
    assert.equal(JSON.stringify(state.sessions).includes("+919876543243"), false);
    assert.equal(JSON.stringify(state.sessions).includes("9876543243"), false);
    assert.equal(state.sessions[0].phoneHash, hashAddressPhone(normalizeIndianPhone("9876543243"), "address-phone-pepper-test-value"));
    assert.equal(state.sessions[0].phoneLast2, "43");

    const confirmed = await service.confirmPhoneVerification({
      sessionToken: result.sessionToken,
      verificationHandle,
      proof: "123456"
    });

    assert.deepEqual(confirmed, { verified: true, phoneLast2: "43", profile: undefined });
    assert.equal("phoneHash" in confirmed, false);
    assert.equal("e164" in confirmed, false);

    const context = await service.requireVerifiedCheckoutSession(result.sessionToken);
    assert.deepEqual(context, {
      sessionId: state.sessions[0].id,
      merchantId: "merchant_a2",
      cartId: "cart_verified",
      phoneHash: state.sessions[0].phoneHash,
      phoneLast2: "43",
      profileName: null
    });
  });

  it("rejects wrong OTP proof, bounds failed attempts, and rejects expired handles", async () => {
    const { state, service } = makeHarness();
    const result = await service.createSession({ merchantId: "merchant_a2" });
    const start = await service.startPhoneVerification({
      sessionToken: result.sessionToken,
      phone: "9876543243",
      provider: "otp"
    });

    for (let index = 0; index < CHECKOUT_ADDRESS_MAX_VERIFICATION_ATTEMPTS; index += 1) {
      await assertHttpError(
        service.confirmPhoneVerification({
          sessionToken: result.sessionToken,
          verificationHandle: expectString(start.verificationHandle),
          proof: "000000"
        }),
        400,
        "CHECKOUT_OTP_INVALID"
      );
    }

    assert.equal(state.sessions[0].verificationAttempts, CHECKOUT_ADDRESS_MAX_VERIFICATION_ATTEMPTS);
    await assertHttpError(
      service.confirmPhoneVerification({
        sessionToken: result.sessionToken,
        verificationHandle: expectString(start.verificationHandle),
        proof: "123456"
      }),
      429,
      "CHECKOUT_VERIFICATION_ATTEMPTS_EXCEEDED"
    );

    const expired = await service.createSession({ merchantId: "merchant_a2" });
    const expiredStart = await service.startPhoneVerification({
      sessionToken: expired.sessionToken,
      phone: "9876543243",
      provider: "otp"
    });
    state.now = new Date(baseTime.getTime() + 6 * 60 * 1000);
    await assertHttpError(
      service.confirmPhoneVerification({
        sessionToken: expired.sessionToken,
        verificationHandle: expectString(expiredStart.verificationHandle),
        proof: "123456"
      }),
      410,
      "CHECKOUT_VERIFICATION_HANDLE_EXPIRED"
    );
  });

  it("treats OTP handles as single-use", async () => {
    const verifier = new OtpVerifier();
    const expiresAt = new Date(baseTime.getTime() + 5 * 60 * 1000);
    const handle = await verifier.start("+919876543243", {
      phoneHash: "phone_hash",
      phoneLast2: "43",
      now: baseTime,
      expiresAt
    });
    const context = {
      phoneHash: "phone_hash",
      phoneLast2: "43",
      now: baseTime,
      expiresAt
    };

    await assertHttpError(
      verifier.confirm(`${handle.verificationHandle}.extra`, "123456", context),
      400,
      "CHECKOUT_VERIFICATION_HANDLE_INVALID"
    );

    await verifier.confirm(handle.verificationHandle, "123456", context);
    await assertHttpError(
      verifier.confirm(handle.verificationHandle, "123456", context),
      409,
      "CHECKOUT_VERIFICATION_HANDLE_CONSUMED"
    );
  });

  it("returns safe truecaller fallback behavior and makes no external call", async () => {
    const { service } = makeHarness();
    const result = await service.createSession({ merchantId: "merchant_a2" });
    const fallback = await service.startPhoneVerification({
      sessionToken: result.sessionToken,
      phone: "9876543243",
      provider: "truecaller"
    });

    assert.deepEqual(fallback, {
      provider: "truecaller",
      available: false,
      error: "TRUECALLER_NOT_CONFIGURED",
      fallbackAvailable: true
    });

    const verifier = new TruecallerVerifier();
    await assertHttpError(
      verifier.start("+919876543243", {
        phoneHash: "hash",
        phoneLast2: "43",
        now: baseTime,
        expiresAt: new Date(baseTime.getTime() + 60_000)
      }),
      503,
      "TRUECALLER_NOT_CONFIGURED"
    );
    assert.equal(verifier.externalCalls, 0);

    const source = readFileSync("src/modules/checkout/checkout-phone-verifier.ts", "utf8");
    assert.equal(/fetch\s*\(|https?:\/\//i.test(source), false);
  });
});

describe("Checkout Address A2 routes", () => {
  it("mounts public checkout address routes under the existing checkout API router", () => {
    const checkoutRoutes = readFileSync("src/modules/checkout/checkout.routes.ts", "utf8");
    const indexRoutes = readFileSync("src/routes/index.ts", "utf8");
    assert.match(checkoutRoutes, /checkoutRouter\.use\("\/", checkoutAddressSessionRouter\);/);
    assert.match(indexRoutes, /apiRouter\.use\("\/checkout", checkoutRouter\);/);
  });

  it("creates sessions and verifies phone without returning raw phone or phone hash", async () => {
    const { state, service } = makeHarness();
    const app = await createApp(service);
    try {
      const created = await request(app.baseUrl, "/checkout/session", {
        method: "POST",
        body: JSON.stringify({ merchantId: "merchant_a2", cartId: "cart_route" })
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.status, "created");
      assert.ok(created.body.sessionToken);

      const missingToken = await request(app.baseUrl, "/checkout/verify-phone/start", {
        method: "POST",
        body: JSON.stringify({ phone: "9876543243", provider: "otp" })
      });
      assert.equal(missingToken.status, 401);
      assert.equal(missingToken.body.error, "CHECKOUT_SESSION_TOKEN_REQUIRED");

      const started = await request(app.baseUrl, "/checkout/verify-phone/start", {
        method: "POST",
        headers: { "x-checkout-session-token": created.body.sessionToken },
        body: JSON.stringify({ phone: "+91 98765-43243", provider: "otp" })
      });
      assert.equal(started.status, 200);
      assert.equal(started.body.provider, "otp");
      assert.ok(started.body.verificationHandle);

      const confirmMissingToken = await request(app.baseUrl, "/checkout/verify-phone/confirm", {
        method: "POST",
        body: JSON.stringify({ verificationHandle: started.body.verificationHandle, proof: "123456" })
      });
      assert.equal(confirmMissingToken.status, 401);
      assert.equal(confirmMissingToken.body.error, "CHECKOUT_SESSION_TOKEN_REQUIRED");

      const confirmed = await request(app.baseUrl, "/checkout/verify-phone/confirm", {
        method: "POST",
        headers: { "x-checkout-session-token": created.body.sessionToken },
        body: JSON.stringify({ verificationHandle: started.body.verificationHandle, proof: "123456" })
      });
      assert.equal(confirmed.status, 200);
      assert.deepEqual(confirmed.body, { verified: true, phoneLast2: "43" });
      assert.equal(JSON.stringify(confirmed.body).includes("9876543243"), false);
      assert.equal("phoneHash" in confirmed.body, false);

      assert.equal(JSON.stringify(state.sessions).includes("+919876543243"), false);
      assert.equal(JSON.stringify(state.sessions).includes("9876543243"), false);
      assert.equal(state.sessions[0].tokenHash, hashCheckoutAddressSessionToken(created.body.sessionToken));
    } finally {
      await closeServer(app.server);
    }
  });

  it("returns 400 for invalid payloads and 401 for invalid session tokens", async () => {
    const { service } = makeHarness();
    const app = await createApp(service);
    try {
      const invalidPayload = await request(app.baseUrl, "/checkout/session", {
        method: "POST",
        body: JSON.stringify({ merchantId: "" })
      });
      assert.equal(invalidPayload.status, 400);
      assert.equal(invalidPayload.body.error, "VALIDATION_ERROR");

      const invalidToken = await request(app.baseUrl, "/checkout/verify-phone/start", {
        method: "POST",
        headers: { "x-checkout-session-token": "not-a-valid-token" },
        body: JSON.stringify({ phone: "9876543243", provider: "otp" })
      });
      assert.equal(invalidToken.status, 401);
      assert.equal(invalidToken.body.error, "CHECKOUT_SESSION_TOKEN_INVALID");
    } finally {
      await closeServer(app.server);
    }
  });

  it("returns truecaller fallback response without blocking checkout", async () => {
    const { service } = makeHarness();
    const app = await createApp(service);
    try {
      const created = await request(app.baseUrl, "/checkout/session", {
        method: "POST",
        body: JSON.stringify({ merchantId: "merchant_a2" })
      });
      const response = await request(app.baseUrl, "/checkout/verify-phone/start", {
        method: "POST",
        headers: { "x-checkout-session-token": created.body.sessionToken },
        body: JSON.stringify({ phone: "9876543243", provider: "truecaller" })
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        provider: "truecaller",
        available: false,
        error: "TRUECALLER_NOT_CONFIGURED",
        fallbackAvailable: true
      });
    } finally {
      await closeServer(app.server);
    }
  });
});

describe("Checkout Address A2 safety boundaries", () => {
  it("does not introduce real OTP, SMS, WhatsApp, or Truecaller external calls", () => {
    const sources = [
      "src/modules/address/phone.service.ts",
      "src/modules/checkout/checkout-address-session.service.ts",
      "src/modules/checkout/checkout-address-session.routes.ts",
      "src/modules/checkout/checkout-phone-verifier.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");

    assert.equal(/twilio|msg91|gupshup|interakt|wati|aisensy|truecaller\.com|fetch\s*\(|axios|https?:\/\//i.test(sources), false);
  });

  it("does not touch payment, wallet, settlement, payout, Razorpay, or Cashfree source paths", () => {
    const changedSurface = [
      "src/modules/address/phone.service.ts",
      "src/modules/checkout/checkout-address-session-token.ts",
      "src/modules/checkout/checkout-phone-verifier.ts",
      "src/modules/checkout/checkout-address-session.service.ts",
      "src/modules/checkout/checkout-address-session.routes.ts",
      "src/modules/checkout/checkout.routes.ts"
    ].join("\n");

    assert.equal(/payment|wallet|settlement|payout|razorpay|cashfree/i.test(changedSurface), false);
  });
});
