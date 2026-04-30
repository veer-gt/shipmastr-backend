import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import type { Request, Response, NextFunction } from "express";
import admin from "../lib/firebase.js";
import { prisma } from "../lib/prisma.js";
import { requireFirebaseAuth } from "./firebaseAuth.js";

type ResponseCapture = {
  statusCode?: number;
  body?: unknown;
};

function createResponse(capture: ResponseCapture): Response {
  return {
    status(code: number) {
      capture.statusCode = code;
      return this;
    },
    json(body: unknown) {
      capture.body = body;
      return this;
    },
  } as Response;
}

function createRequest(token?: string): Request {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as Request;
}

const originalAuth = admin.auth.bind(admin);
const originalFindUnique = prisma.user.findUnique.bind(prisma.user);
const originalUpdate = prisma.user.update.bind(prisma.user);

function mockFirebaseVerifier(verifyIdToken: (token: string) => Promise<unknown>) {
  Object.defineProperty(admin, "auth", {
    configurable: true,
    value: () => ({ verifyIdToken }),
  });
}

function mockUserFindUnique(fn: (args: unknown) => Promise<unknown>) {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: fn,
  });
}

function mockUserUpdate(fn: (args: unknown) => Promise<unknown>) {
  Object.defineProperty(prisma.user, "update", {
    configurable: true,
    value: fn,
  });
}

async function runMiddleware(token?: string) {
  const req = createRequest(token);
  const capture: ResponseCapture = {};
  const res = createResponse(capture);
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await requireFirebaseAuth(req, res, next);

  return { req, capture, nextCalled };
}

describe("requireFirebaseAuth", () => {
  beforeEach(() => {
    mock.restoreAll();
    Object.defineProperty(admin, "auth", {
      configurable: true,
      value: originalAuth,
    });
    Object.defineProperty(prisma.user, "findUnique", {
      configurable: true,
      value: originalFindUnique,
    });
    Object.defineProperty(prisma.user, "update", {
      configurable: true,
      value: originalUpdate,
    });
  });

  it("returns 401 when the Bearer token is missing", async () => {
    const result = await runMiddleware();

    assert.equal(result.capture.statusCode, 401);
    assert.deepEqual(result.capture.body, { error: "Missing Firebase token" });
    assert.equal(result.nextCalled, false);
  });

  it("returns 401 when Firebase rejects the ID token", async () => {
    mockFirebaseVerifier(async () => {
      throw new Error("bad token");
    });

    const result = await runMiddleware("invalid-token");

    assert.equal(result.capture.statusCode, 401);
    assert.deepEqual(result.capture.body, { error: "Invalid Firebase token" });
    assert.equal(result.nextCalled, false);
  });

  it("allows a valid Firebase token with a mapped user and merchant", async () => {
    mockFirebaseVerifier(async () => ({
        uid: "firebase-user-1",
        email: "owner@merchant.test",
        phone_number: "+15555550123",
      }));

    mockUserFindUnique(async () => ({
      id: "user_1",
      firebaseUid: "firebase-user-1",
      email: "owner@merchant.test",
      merchantId: "merchant_1",
      role: "OWNER",
      merchant: { id: "merchant_1" },
    }));

    const result = await runMiddleware("valid-token");

    assert.equal(result.nextCalled, true);
    assert.deepEqual(result.req.user, {
      firebaseUid: "firebase-user-1",
      email: "owner@merchant.test",
      phone: "+15555550123",
    });
    assert.equal(result.req.auth?.userId, "user_1");
    assert.equal(result.req.auth?.merchantId, "merchant_1");
    assert.equal(result.req.auth?.role, "OWNER");
    assert.equal(result.req.auth?.firebaseUid, "firebase-user-1");
  });

  it("attaches firebaseUid to an existing email-matched user", async () => {
    mockFirebaseVerifier(async () => ({
        uid: "firebase-user-2",
        email: "seller@merchant.test",
      }));

    const findUniqueCalls: unknown[] = [];

    mockUserFindUnique(async (args: unknown) => {
      findUniqueCalls.push(args);

      if (findUniqueCalls.length === 1) return null;

      return {
        id: "user_2",
        firebaseUid: null,
        email: "seller@merchant.test",
        merchantId: "merchant_2",
        role: "ADMIN",
        merchant: { id: "merchant_2" },
      };
    });

    mockUserUpdate(async (args: unknown) => {
      assert.deepEqual(args, {
        where: { id: "user_2" },
        data: { firebaseUid: "firebase-user-2" },
        include: { merchant: true },
      });

      return {
        id: "user_2",
        firebaseUid: "firebase-user-2",
        email: "seller@merchant.test",
        merchantId: "merchant_2",
        role: "ADMIN",
        merchant: { id: "merchant_2" },
      };
    });

    const result = await runMiddleware("valid-token");

    assert.equal(result.nextCalled, true);
    assert.equal(result.req.auth?.merchantId, "merchant_2");
    assert.equal(result.req.auth?.firebaseUid, "firebase-user-2");
  });
});
