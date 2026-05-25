import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { requireReadyMerchantAutopilotAccess } from "./merchantAutopilotAccess.js";

type ResponseCapture = {
  statusCode?: number;
  body?: unknown;
};

const originalUserFindUnique = prisma.user.findUnique.bind(prisma.user);

afterEach(() => {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: originalUserFindUnique
  });
});

function mockUserFindUnique(fn: (args: unknown) => Promise<unknown>) {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: fn
  });
}

function createResponse(capture: ResponseCapture): Response {
  return {
    status(code: number) {
      capture.statusCode = code;
      return this;
    },
    json(body: unknown) {
      capture.body = body;
      return this;
    }
  } as Response;
}

function createRequest(auth?: Request["auth"]): Request {
  return { auth } as Request;
}

async function runReadyMerchantGuard(auth?: Request["auth"]) {
  const req = createRequest(auth);
  const capture: ResponseCapture = {};
  const res = createResponse(capture);
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await requireReadyMerchantAutopilotAccess(req, res, next);

  return { capture, nextCalled };
}

describe("requireReadyMerchantAutopilotAccess", () => {
  it("rejects unauthenticated requests", async () => {
    const result = await runReadyMerchantGuard();

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 401);
    assert.deepEqual(result.capture.body, { error: "AUTHENTICATION_REQUIRED" });
  });

  it("rejects authenticated accounts without a merchantId", async () => {
    const result = await runReadyMerchantGuard({
      userId: "user_1",
      merchantId: "",
      role: "SELLER"
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, {
      error: "MERCHANT_AUTOPILOT_REQUIRES_READY_MERCHANT",
      message: "Shipmastr Autopilot opens for ready Merchant accounts that use Shipmastr Website Hosting, Checkout, and Shipping."
    });
  });

  it("rejects sellers with merchantId before READY_TO_SHIP onboarding", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      merchant: {
        id: "merchant_1",
        onboardingStatus: "IN_PROGRESS"
      }
    }));

    const result = await runReadyMerchantGuard({
      userId: "user_1",
      merchantId: "merchant_1",
      role: "SELLER"
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, {
      error: "MERCHANT_AUTOPILOT_REQUIRES_READY_MERCHANT",
      message: "Shipmastr Autopilot opens for ready Merchant accounts that use Shipmastr Website Hosting, Checkout, and Shipping."
    });
  });

  it("allows ready Merchant accounts with merchantId and READY_TO_SHIP onboarding", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      merchant: {
        id: "merchant_1",
        onboardingStatus: "READY_TO_SHIP"
      }
    }));

    const result = await runReadyMerchantGuard({
      userId: "user_1",
      merchantId: "merchant_1",
      role: "SELLER"
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.capture.statusCode, undefined);
  });

  it("rejects mismatched token and user merchant scopes", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_2",
      merchant: {
        id: "merchant_2",
        onboardingStatus: "READY_TO_SHIP"
      }
    }));

    const result = await runReadyMerchantGuard({
      userId: "user_1",
      merchantId: "merchant_1",
      role: "SELLER"
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
  });
});

describe("automation route protection boundaries", () => {
  it("guards merchant automation routes after JWT auth", () => {
    const routesSource = readFileSync("src/routes/index.ts", "utf8");

    assert.match(
      routesSource,
      /apiRouter\.use\("\/automation", requireJwtAuth, requireReadyMerchantAutopilotAccess, automationRouter\);/
    );
  });

  it("keeps internal automation routes on internal auth", () => {
    const routesSource = readFileSync("src/routes/index.ts", "utf8");

    assert.match(
      routesSource,
      /apiRouter\.use\("\/internal\/automation", requireInternalSecret, internalAutomationRouter\);/
    );
    assert.doesNotMatch(
      routesSource,
      /apiRouter\.use\("\/internal\/automation",[^;]*requireReadyMerchantAutopilotAccess/
    );
  });

  it("keeps admin automation routes on admin auth", () => {
    const routesSource = readFileSync("src/routes/index.ts", "utf8");

    assert.match(
      routesSource,
      /apiRouter\.use\("\/admin\/automation", requireAdminJwt, adminAutomationRouter\);/
    );
    assert.doesNotMatch(
      routesSource,
      /apiRouter\.use\("\/admin\/automation",[^;]*requireReadyMerchantAutopilotAccess/
    );
  });
});
