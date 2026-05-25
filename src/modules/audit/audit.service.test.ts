import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getSellerAuditSummary, listSellerAuditLogs } from "./audit.service.js";

const now = new Date("2026-05-18T10:00:00.000Z");

function makeAuditLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit_1",
    merchantId: "merchant_1",
    actorId: "user_1",
    action: "ORDER_CREATED",
    entityType: "order",
    entityId: "order_1",
    metadata: { orderId: "order_1" },
    createdAt: now,
    ...overrides
  } as any;
}

describe("seller audit API", () => {
  it("mounts seller audit routes behind JWT auth", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const auditRoutes = readFileSync("src/modules/audit/audit.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/audit", requireJwtAuth, auditRouter\);/);
    assert.match(auditRoutes, /auditRouter\.get\("\/"/);
    assert.match(auditRoutes, /auditRouter\.get\("\/summary"/);
  });

  it("returns a stable empty merchant-scoped list", async () => {
    const client = {
      auditLog: {
        findMany: async (args: any) => {
          assert.deepEqual(args.where, { merchantId: "merchant_1" });
          assert.equal(args.take, 50);
          return [];
        }
      }
    };

    const result = await listSellerAuditLogs("merchant_1", {}, client as any);
    assert.deepEqual(result, { events: [], data: [], count: 0 });
  });

  it("filters accidental cross-merchant records and redacts sensitive metadata", async () => {
    const client = {
      auditLog: {
        findMany: async (args: any) => {
          assert.deepEqual(args.where, { merchantId: "merchant_1" });
          assert.equal(args.take, 20);
          return [
            makeAuditLog({
              metadata: {
                orderId: "order_1",
                token: "must-not-leak",
                nested: {
                  webhookSecret: "also-secret",
                  note: "Bearer abc.def.ghi"
                }
              }
            }),
            makeAuditLog({ id: "audit_other", merchantId: "merchant_2" })
          ];
        }
      }
    };

    const result = await listSellerAuditLogs("merchant_1", { limit: 20 }, client as any);
    const serialized = JSON.stringify(result);

    assert.equal(result.count, 1);
    assert.equal(result.events.length, 1);
    assert.equal(result.data[0]?._id, "audit_1");
    assert.equal(result.data[0]?.resourceType, "order");
    assert.equal(result.data[0]?.status, "success");
    assert.equal(serialized.includes("must-not-leak"), false);
    assert.equal(serialized.includes("also-secret"), false);
    assert.equal(serialized.includes("abc.def.ghi"), false);
  });

  it("summarizes seller audit statuses and action names", async () => {
    const client = {
      auditLog: {
        count: async (args: any) => {
          assert.deepEqual(args.where, { merchantId: "merchant_1" });
          return 3;
        },
        findMany: async (args: any) => {
          assert.deepEqual(args.where, { merchantId: "merchant_1" });
          return [
            makeAuditLog({ action: "ORDER_CREATED" }),
            makeAuditLog({ id: "audit_2", action: "CHECKOUT_QUEUED", metadata: { status: "queued" } }),
            makeAuditLog({ id: "audit_3", action: "PAYMENT_FAILED", metadata: { status: "failed" } }),
            makeAuditLog({ id: "audit_other", merchantId: "merchant_2", action: "OTHER_MERCHANT" })
          ];
        }
      }
    };

    const result = await getSellerAuditSummary("merchant_1", client as any);

    assert.equal(result.total, 3);
    assert.equal(result.critical, 1);
    assert.equal(result.warning, 1);
    assert.equal(result.info, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.queued, 1);
    assert.deepEqual(result.actions, ["ORDER_CREATED", "CHECKOUT_QUEUED", "PAYMENT_FAILED"]);
  });
});
