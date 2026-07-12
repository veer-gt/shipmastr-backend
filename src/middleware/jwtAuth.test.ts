import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAdminJwt, requireCourierJwt, requireMasterAdminJwt } from "./jwtAuth.js";

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

async function runMasterAdminMiddleware(token?: string, requestOverrides: Partial<Request> = {}) {
  const req = Object.assign(createRequest(token), requestOverrides) as Request;
  const capture: ResponseCapture = {};
  const res = createResponse(capture);
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await requireMasterAdminJwt(req, res, next);

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

  it("allows every approved internal admin role", async () => {
    for (const role of ["MASTER_ADMIN", "ADMIN", "OPS_MANAGER", "FINANCE_MANAGER", "RISK_MANAGER", "COURIER_MANAGER", "SUPPORT_AGENT"]) {
      mockUserFindUnique(async () => ({
        id: "user_1",
        merchantId: "merchant_1",
        email: `${role.toLowerCase()}@shipmastr.test`,
        userType: "INTERNAL_SHIPMASTR",
        role
      }));

      const result = await runAdminMiddleware(signRole(role));

      assert.equal(result.nextCalled, true, role);
      assert.equal(result.req.auth?.role, "ADMIN", role);
    }
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

  it("blocks unknown internal roles", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "unknown@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role: "UNKNOWN_INTERNAL_ROLE"
    }));

    const result = await runAdminMiddleware(signRole("ADMIN"));

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, { error: "INTERNAL_ADMIN_ONLY" });
  });

  it("allows normal internal ADMIN users through the general admin guard", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "ops-admin@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role: "ADMIN"
    }));

    const result = await runAdminMiddleware(signRole("ADMIN"));

    assert.equal(result.nextCalled, true);
    assert.equal(result.req.auth?.role, "ADMIN");
  });
});

describe("requireMasterAdminJwt", () => {
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

  it("allows exact MASTER_ADMIN users and preserves the master role on req.auth", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "indraveer.chauhan@gmail.com",
      userType: "INTERNAL_SHIPMASTR",
      role: "MASTER_ADMIN"
    }));

    const result = await runMasterAdminMiddleware(signRole("MASTER_ADMIN"));

    assert.equal(result.nextCalled, true);
    assert.equal(result.req.auth?.userId, "user_1");
    assert.equal(result.req.auth?.role, "MASTER_ADMIN");
  });

  it("blocks stale protected-email ADMIN users from exact MASTER_ADMIN-only endpoints", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "indraveer.chauhan@gmail.com",
      userType: "INTERNAL_SHIPMASTR",
      role: "ADMIN"
    }));

    const result = await runMasterAdminMiddleware(signRole("ADMIN"));

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, { error: "MASTER_ADMIN_ONLY" });
    assert.equal(result.req.auth?.role, "ADMIN");
  });

  it("blocks normal internal ADMIN users from exact MASTER_ADMIN-only endpoints", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "ops-admin@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role: "ADMIN"
    }));

    const result = await runMasterAdminMiddleware(signRole("ADMIN"));

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, { error: "INTERNAL_ADMIN_ONLY" });
  });

  it("blocks non-master internal operator roles from checkout intelligence style endpoints", async () => {
    for (const role of ["OPS_MANAGER", "FINANCE_MANAGER", "RISK_MANAGER", "COURIER_MANAGER", "SUPPORT_AGENT"]) {
      mockUserFindUnique(async () => ({
        id: "user_1",
        merchantId: "merchant_1",
        email: `${role.toLowerCase()}@shipmastr.test`,
        userType: "INTERNAL_SHIPMASTR",
        role
      }));

      const result = await runMasterAdminMiddleware(signRole(role));

      assert.equal(result.nextCalled, false);
      assert.equal(result.capture.statusCode, 403);
      assert.deepEqual(result.capture.body, { error: "INTERNAL_ADMIN_ONLY" });
    }
  });

  it("reads active JWT req.auth rather than stale req.user fields", async () => {
    mockUserFindUnique(async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: "ops-admin@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role: "ADMIN"
    }));

    const result = await runMasterAdminMiddleware(signRole("ADMIN"), {
      user: {
        id: "stale_user",
        role: "MASTER_ADMIN"
      } as never
    } as Partial<Request>);

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.equal(result.req.auth?.userId, "user_1");
  });

  it("blocks non-admin roles before master-admin route logic", async () => {
    const result = await runMasterAdminMiddleware(signRole("SELLER"));

    assert.equal(result.nextCalled, false);
    assert.equal(result.capture.statusCode, 403);
    assert.deepEqual(result.capture.body, { error: "ADMIN_ONLY" });
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
