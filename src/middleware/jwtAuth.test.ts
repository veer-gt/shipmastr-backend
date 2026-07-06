import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAdminJwt, requireCourierJwt } from "./jwtAuth.js";

type ResponseCapture = {
  statusCode?: number;
  body?: unknown;
};

const originalFindUnique = prisma.user.findUnique.bind(prisma.user);
const originalCourierFindUnique = prisma.courierUser.findUnique.bind(prisma.courierUser);

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
    header(name: string) {
      if (name.toLowerCase() === "authorization" && token) return `Bearer ${token}`;
      return undefined;
    }
  } as Request;
}

function mockUserFindUnique(fn: (args: unknown) => Promise<unknown>) {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: fn,
  });
}

function mockCourierUserFindUnique(fn: (args: unknown) => Promise<unknown>) {
  Object.defineProperty(prisma.courierUser, "findUnique", {
    configurable: true,
    value: fn,
  });
}

async function runAdminMiddleware(token?: string) {
  const req = createRequest(token);
  const capture: ResponseCapture = {};
  const res = createResponse(capture);
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await requireAdminJwt(req, res, next);

  return { req, capture, nextCalled };
}

function signRole(role: string) {
  return jwt.sign({
    userId: "user_1",
    merchantId: "merchant_1",
    role
  }, env.JWT_SECRET);
}

function signCourierRole(input: { role?: string; courierId?: string } = {}) {
  return jwt.sign({
    userId: "courier_user_1",
    courierId: input.courierId ?? "courier_1",
    role: input.role ?? "COURIER"
  }, env.JWT_SECRET);
}

describe("requireAdminJwt", () => {
  beforeEach(() => {
    Object.defineProperty(prisma.user, "findUnique", {
      configurable: true,
      value: originalFindUnique,
    });
    Object.defineProperty(prisma.courierUser, "findUnique", {
      configurable: true,
      value: originalCourierFindUnique,
    });
  });

  it("allows an internal admin token", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "master-admin@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role: "MASTER_ADMIN"
    }));

    const result = await runAdminMiddleware(signRole("ADMIN"));

    assert.equal(result.nextCalled, true);
    assert.equal(result.req.auth?.userId, "user_1");
    assert.equal(result.req.auth?.role, "ADMIN");
  });

  it("allows the protected master admin email even if the stored role is stale", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "indraveer.chauhan@gmail.com",
      userType: "INTERNAL_SHIPMASTR",
      role: "ADMIN"
    }));

    const result = await runAdminMiddleware(signRole("ADMIN"));

    assert.equal(result.nextCalled, true);
    assert.equal(result.req.auth?.userId, "user_1");
    assert.equal(result.req.auth?.role, "ADMIN");
  });

  it("blocks a non-admin token before admin routes", async () => {
    const result = await runAdminMiddleware(signRole("SELLER"));

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, { error: "ADMIN_ONLY" });
  });

  it("blocks admin role tokens that are not internal Shipmastr users", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "admin@example.test",
      userType: "SELLER_ACCOUNT",
      role: "ADMIN"
    }));

    const result = await runAdminMiddleware(signRole("ADMIN"));

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, { error: "INTERNAL_ADMIN_ONLY" });
  });

  it("blocks normal internal ADMIN users from master-admin endpoints", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "ops-admin@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role: "ADMIN"
    }));

    const result = await runAdminMiddleware(signRole("ADMIN"));

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, { error: "INTERNAL_ADMIN_ONLY" });
  });
});

describe("requireCourierJwt", () => {
  beforeEach(() => {
    Object.defineProperty(prisma.courierUser, "findUnique", {
      configurable: true,
      value: originalCourierFindUnique,
    });
  });

  async function runCourierMiddleware(token?: string) {
    const req = createRequest(token);
    const capture: ResponseCapture = {};
    const res = createResponse(capture);
    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    await requireCourierJwt(req, res, next);

    return { req, capture, nextCalled };
  }

  it("allows an active courier token scoped to the matching courier", async () => {
    mockCourierUserFindUnique(async () => ({
      id: "courier_user_1",
      courierId: "courier_1",
      active: true,
      courier: { active: true }
    }));

    const result = await runCourierMiddleware(signCourierRole());

    assert.equal(result.nextCalled, true);
    assert.equal(result.req.auth?.userId, "courier_user_1");
    assert.equal(result.req.auth?.courierId, "courier_1");
    assert.equal(result.req.auth?.role, "COURIER");
  });

  it("blocks courier tokens when the partner is disabled", async () => {
    mockCourierUserFindUnique(async () => ({
      id: "courier_user_1",
      courierId: "courier_1",
      active: true,
      courier: { active: false }
    }));

    const result = await runCourierMiddleware(signCourierRole());

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, { error: "COURIER_ACCESS_DISABLED" });
  });
});
