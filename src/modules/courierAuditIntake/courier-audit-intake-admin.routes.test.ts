import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

process.env.COURIER_AUDIT_INTAKE_ENABLED = "false";
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
process.env.JWT_SECRET ??= "j".repeat(32);
process.env.APP_SECRET_PEPPER ??= "p".repeat(16);
process.env.WEBHOOK_SECRET ??= "w".repeat(32);

const { env } = await import("../../config/env.js");
const { errorHandler } = await import("../../middleware/error.js");
const { requireMasterAdminJwt } = await import("../../middleware/jwtAuth.js");
const { prisma } = await import("../../lib/prisma.js");
const { logger } = await import("../../lib/logger.js");
const { CourierAuditIntakeCursorError } = await import("./courier-audit-intake.service.js");
const { createCourierAuditIntakeAdminRouter } = await import("./courier-audit-intake-admin.routes.js");
logger.level = "silent";

const ROUTE_PATH = "/api/admin/courier-audit-intakes";
const INTAKE_ID = "00000000-0000-4000-8000-000000000001";
const ORIGINAL_USER_FIND_UNIQUE = prisma.user.findUnique.bind(prisma.user);

const listItem = {
  id: INTAKE_ID,
  sourceProvider: "GMAIL" as const,
  sourceReceivedAt: new Date("2026-08-07T15:58:45.123Z"),
  createdAt: new Date("2026-08-07T16:00:01.000Z"),
  senderSummary: "A***@example.test",
  companySummary: "Acme Logistics",
  warningCount: 2,
  attachmentCount: 1,
  ingestionStatus: "VALIDATED" as const,
  reviewStatus: "NEEDS_REVIEW" as const
};

const detail = {
  id: INTAKE_ID,
  createdAt: new Date("2026-08-07T16:00:01.000Z"),
  source: {
    provider: "GMAIL" as const,
    accountId: "mailbox-workflow-01",
    messageId: "gmail-message-1001",
    threadId: "gmail-thread-77",
    receivedAt: new Date("2026-08-07T15:58:45.123Z"),
    senderName: "Acme Billing",
    senderEmail: "billing@example.test",
    subject: "July courier statement",
    bodySha256: "a".repeat(64),
    snippet: "Bounded source snippet"
  },
  attachments: [{
    sourceAttachmentId: "gmail-attachment-1",
    filename: "invoice-july.pdf",
    declaredMimeType: "application/pdf",
    detectedMimeType: "application/pdf",
    sizeBytes: 1024,
    sha256: "b".repeat(64),
    artifactKind: "PDF" as const,
    processingStatus: "PARSED_DETERMINISTIC" as const,
    parser: "pdf-text-v1"
  }],
  revision: {
    revision: 1 as const,
    schemaVersion: "courier-audit-intake.v1",
    parserName: "courier-audit-parser",
    parserVersion: "1.2.3",
    mode: "DETERMINISTIC" as const,
    modelProvider: null,
    modelName: null,
    promptVersion: null,
    extractedAt: new Date("2026-08-07T15:59:30.456Z"),
    extractionResult: {
      companyName: "Acme Logistics",
      contactName: "Asha Rao",
      contactEmail: null,
      contactPhone: "919876543210",
      courierName: "Safe Courier",
      documentKinds: ["COURIER_INVOICE"],
      invoiceNumbers: ["INV-001"],
      billingPeriodStart: "2026-07-01",
      billingPeriodEnd: "2026-07-31",
      currency: "INR",
      totalBilledAmount: "123.40",
      shipmentCount: 42,
      awbSamples: ["AWB-001"],
      summary: "Monthly invoice"
    },
    normalizedProjection: {
      companyName: "Acme Logistics",
      contactName: "Asha Rao",
      contactEmail: null,
      contactPhoneE164: "+919876543210",
      courierName: "Safe Courier",
      documentKinds: ["COURIER_INVOICE"],
      invoiceNumbers: ["INV-001"],
      billingPeriodStart: "2026-07-01",
      billingPeriodEnd: "2026-07-31",
      currency: "INR",
      totalBilledMinorUnits: "12340",
      shipmentCount: 42,
      awbSamples: ["AWB-001"],
      summary: "Monthly invoice"
    },
    warnings: [{ code: "SOURCE_WARNING", message: "Producer supplied warning.", field: "summary" }],
    confidence: 0.91,
    createdAt: new Date("2026-08-07T16:00:01.000Z")
  },
  ingestionStatus: "VALIDATED" as const,
  reviewStatus: "NEEDS_REVIEW" as const
};

type TestOptions = {
  list?: (input: any) => Promise<any>;
  detail?: (id: string) => Promise<any>;
  audit?: (input: any) => Promise<any>;
};

function signRole(role: string) {
  return jwt.sign({ userId: "user_1", merchantId: "merchant_1", role }, env.JWT_SECRET);
}

function mockUser(role: "MASTER_ADMIN" | "ADMIN") {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: async () => ({
      id: "user_1",
      merchantId: "merchant_1",
      email: role === "MASTER_ADMIN" ? "indraveer.chauhan@gmail.com" : "ops-admin@shipmastr.test",
      userType: "INTERNAL_SHIPMASTR",
      role
    })
  });
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withAdminApp<T>(
  options: TestOptions,
  callback: (baseUrl: string) => Promise<T>,
  role: "MASTER_ADMIN" | "ADMIN" | undefined = "MASTER_ADMIN"
) {
  if (role) mockUser(role);

  const app = express();
  app.use(
    ROUTE_PATH,
    requireMasterAdminJwt,
    createCourierAuditIntakeAdminRouter({
      listCourierAuditIntakes: options.list ?? (async () => ({ items: [listItem], nextCursor: null })),
      getCourierAuditIntakeDetail: options.detail ?? (async () => detail),
      audit: options.audit ?? (async () => ({ id: "audit-1" }))
    })
  );
  app.use(errorHandler);

  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ADMIN_TEST_SERVER_ADDRESS_UNAVAILABLE");

  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  token?: string
) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${baseUrl}${ROUTE_PATH}${path}`, {
    method,
    headers
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) as unknown : undefined;
  } catch {
    // Express's default unmatched-route response is HTML; callers assert its status only.
  }
  return {
    status: response.status,
    body
  };
}

afterEach(() => {
  Object.defineProperty(prisma.user, "findUnique", {
    configurable: true,
    value: ORIGINAL_USER_FIND_UNIQUE
  });
});

describe("courier audit intake admin routes", () => {
  it("denies unauthenticated list access before calling the service", async () => {
    let listCalls = 0;

    await withAdminApp({
      list: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null };
      }
    }, async (baseUrl) => {
      const response = await request(baseUrl, "GET", "/");
      assert.equal(response.status, 401);
    }, undefined);

    assert.equal(listCalls, 0);
  });

  it("denies an authenticated non-Master-Admin before calling the service", async () => {
    let listCalls = 0;

    await withAdminApp({
      list: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null };
      }
    }, async (baseUrl) => {
      const response = await request(baseUrl, "GET", "/", signRole("ADMIN"));
      assert.equal(response.status, 403);
    }, "ADMIN");

    assert.equal(listCalls, 0);
  });

  it("allows a Master Admin to list the minimized projection with the default limit", async () => {
    const calls: any[] = [];

    await withAdminApp({
      list: async (input) => {
        calls.push(input);
        return { items: [listItem], nextCursor: null };
      }
    }, async (baseUrl) => {
      const response = await request(baseUrl, "GET", "/", signRole("MASTER_ADMIN"));
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        items: [{
          id: INTAKE_ID,
          sourceProvider: "GMAIL",
          sourceReceivedAt: "2026-08-07T15:58:45.123Z",
          createdAt: "2026-08-07T16:00:01.000Z",
          senderSummary: "A***@example.test",
          companySummary: "Acme Logistics",
          warningCount: 2,
          attachmentCount: 1,
          ingestionStatus: "VALIDATED",
          reviewStatus: "NEEDS_REVIEW"
        }],
        nextCursor: null
      });
      const serialized = JSON.stringify(response.body);
      assert.equal(serialized.includes("extractionResult"), false);
      assert.equal(serialized.includes("Bounded source snippet"), false);
      assert.equal(serialized.includes("sha256"), false);
      assert.equal(serialized.includes("provenance"), false);
    }, "MASTER_ADMIN");

    assert.deepEqual(calls, [{ limit: 25 }]);
  });

  it("accepts the maximum page size and rejects a larger page size", async () => {
    const calls: any[] = [];

    await withAdminApp({
      list: async (input) => {
        calls.push(input);
        return { items: [], nextCursor: null };
      }
    }, async (baseUrl) => {
      const maximum = await request(baseUrl, "GET", "/?limit=50", signRole("MASTER_ADMIN"));
      assert.equal(maximum.status, 200);

      const tooLarge = await request(baseUrl, "GET", "/?limit=51", signRole("MASTER_ADMIN"));
      assert.equal(tooLarge.status, 400);
    });

    assert.deepEqual(calls, [{ limit: 50 }]);
  });

  it("returns a stable 400 when the service rejects an invalid opaque cursor", async () => {
    let receivedCursor: string | undefined;

    await withAdminApp({
      list: async (input) => {
        receivedCursor = input.cursor;
        throw new CourierAuditIntakeCursorError();
      }
    }, async (baseUrl) => {
      const response = await request(baseUrl, "GET", "/?cursor=not-a-valid-cursor", signRole("MASTER_ADMIN"));
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: "INVALID_COURIER_AUDIT_INTAKE_CURSOR" });
    });

    assert.equal(receivedCursor, "not-a-valid-cursor");
  });

  it("rejects a from/to interval longer than 90 days without querying", async () => {
    let listCalls = 0;

    await withAdminApp({
      list: async () => {
        listCalls += 1;
        return { items: [], nextCursor: null };
      }
    }, async (baseUrl) => {
      const response = await request(
        baseUrl,
        "GET",
        "/?from=2026-01-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z",
        signRole("MASTER_ADMIN")
      );
      assert.equal(response.status, 400);
    });

    assert.equal(listCalls, 0);
  });

  it("returns bounded detail data, audits the successful read, and omits PII from audit metadata", async () => {
    const auditCalls: any[] = [];

    await withAdminApp({
      detail: async (id) => {
        assert.equal(id, INTAKE_ID);
        return detail;
      },
      audit: async (input) => {
        auditCalls.push(input);
        return { id: "audit-1" };
      }
    }, async (baseUrl) => {
      const response = await request(baseUrl, "GET", `/${INTAKE_ID}`, signRole("MASTER_ADMIN"));
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, JSON.parse(JSON.stringify(detail)));
    });

    assert.deepEqual(auditCalls, [{
      actorId: "user_1",
      action: "courier_audit_intake.detail_viewed",
      entityType: "CourierAuditIntake",
      entityId: INTAKE_ID,
      metadata: { status: "success" }
    }]);
    const auditJson = JSON.stringify(auditCalls[0]);
    assert.equal(auditJson.includes("billing@example.test"), false);
    assert.equal(auditJson.includes("invoice-july.pdf"), false);
    assert.equal(auditJson.includes("extractionResult"), false);
  });

  it("returns 404 for a missing detail and does not audit the failed read", async () => {
    let auditCalls = 0;

    await withAdminApp({
      detail: async () => null,
      audit: async () => {
        auditCalls += 1;
        return { id: "audit-1" };
      }
    }, async (baseUrl) => {
      const response = await request(baseUrl, "GET", "/missing-intake", signRole("MASTER_ADMIN"));
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: "COURIER_AUDIT_INTAKE_NOT_FOUND" });
    });

    assert.equal(auditCalls, 0);
  });

  it("has no POST, PATCH, or DELETE mutation route and preserves the Task 8 inbound mount", async () => {
    await withAdminApp({}, async (baseUrl) => {
      const token = signRole("MASTER_ADMIN");
      for (const method of ["POST", "PATCH", "DELETE"]) {
        const response = await request(baseUrl, method, `/${INTAKE_ID}`, token);
        assert.equal(response.status, 404, method);
      }
    });

    const routesSource = readFileSync(new URL("../../routes/index.js", import.meta.url), "utf8");
    assert.match(routesSource, /apiRouter\.use\("\/admin\/courier-audit-intakes", requireMasterAdminJwt, courierAuditIntakeAdminRouter\);/u);
    assert.doesNotMatch(routesSource, /apiRouter\.use\("\/admin\/courier-audit-intakes", requireAdminJwt/u);
    assert.match(routesSource, /if \(env\.COURIER_AUDIT_INTAKE_ENABLED\) \{\s*apiRouter\.use\("\/v1\/integrations\/intakes\/courier-audit", courierAuditIntakeRouter\);\s*\}/su);
  });
});
