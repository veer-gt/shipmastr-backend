import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../../lib/httpError.js";
import {
  approveLivePilotCapability,
  disableLivePilotCapability,
  disableLivePilotMerchant,
  enableLivePilotCapability,
  enableLivePilotMerchant,
  getLivePilotMerchant,
  getLivePilotReadinessSnapshot,
  listLivePilotAuditLogs
} from "../live-pilot.service.js";
import { sanitizeLivePilotMeta } from "../live-pilot.serializer.js";

const now = new Date("2026-06-08T14:00:00.000Z");

function createFakeClient() {
  const state = {
    merchants: [] as any[],
    capabilities: [] as any[],
    approvals: [] as any[],
    auditLogs: [] as any[]
  };
  const id = (prefix: string, count: number) => `${prefix}_${count + 1}`;

  const client = {
    livePilotMerchant: {
      findUnique: async ({ where }: any) => state.merchants.find((row) => row.merchantId === where.merchantId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = state.merchants.find((row) => row.merchantId === where.merchantId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const row = {
          id: id("live_pilot_merchant", state.merchants.length),
          createdAt: now,
          updatedAt: now,
          enabledAt: null,
          disabledAt: null,
          enabledBy: null,
          disabledBy: null,
          notes: null,
          ...create
        };
        state.merchants.push(row);
        return row;
      }
    },
    livePilotCapability: {
      findUnique: async ({ where }: any) => state.capabilities.find((row) => (
        row.merchantId === where.merchantId_capability.merchantId &&
        row.capability === where.merchantId_capability.capability
      )) ?? null,
      findMany: async ({ where }: any = {}) => state.capabilities.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.status || row.status === where.status)
      )),
      upsert: async ({ where, create, update }: any) => {
        const existing = state.capabilities.find((row) => (
          row.merchantId === where.merchantId_capability.merchantId &&
          row.capability === where.merchantId_capability.capability
        ));
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const row = {
          id: id("live_pilot_capability", state.capabilities.length),
          createdAt: now,
          updatedAt: now,
          approvalId: null,
          enabledAt: null,
          disabledAt: null,
          notes: null,
          ...create
        };
        state.capabilities.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = state.capabilities.find((item) => (
          item.merchantId === where.merchantId_capability.merchantId &&
          item.capability === where.merchantId_capability.capability
        ));
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of state.capabilities) {
          if ((!where?.merchantId || row.merchantId === where.merchantId) && (!where?.status || row.status === where.status)) {
            Object.assign(row, data, { updatedAt: now });
            count += 1;
          }
        }
        return { count };
      }
    },
    livePilotApproval: {
      create: async ({ data }: any) => {
        const row = {
          id: id("live_pilot_approval", state.approvals.length),
          createdAt: now,
          updatedAt: now,
          revokedBy: null,
          revokedAt: null,
          ...data
        };
        state.approvals.push(row);
        return row;
      },
      findMany: async ({ where }: any = {}) => state.approvals.filter((row) => (
        !where?.merchantId || row.merchantId === where.merchantId
      ))
    },
    livePilotAuditLog: {
      create: async ({ data }: any) => {
        const row = {
          id: id("live_pilot_audit", state.auditLogs.length),
          createdAt: now,
          ...data
        };
        state.auditLogs.push(row);
        return row;
      },
      findMany: async ({ where, skip = 0, take = 20 }: any = {}) => state.auditLogs.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.action || row.action === where.action)
      )).slice(skip, skip + take),
      count: async ({ where }: any = {}) => state.auditLogs.filter((row) => (
        (!where?.merchantId || row.merchantId === where.merchantId) &&
        (!where?.action || row.action === where.action)
      )).length
    }
  };
  return { client: client as any, state };
}

describe("live pilot gate", () => {
  it("cannot enable a capability unless the merchant is allowlisted and approved", async () => {
    const { client } = createFakeClient();
    await assert.rejects(
      () => enableLivePilotCapability("merchant_1", "LIVE_KMS", {}, client),
      (error) => error instanceof HttpError && error.message === "LIVE_PILOT_MERCHANT_NOT_FOUND"
    );

    await enableLivePilotMerchant("merchant_1", {}, client);
    await assert.rejects(
      () => enableLivePilotCapability("merchant_1", "LIVE_KMS", {}, client),
      (error) => error instanceof HttpError && error.message === "LIVE_PILOT_CAPABILITY_APPROVAL_REQUIRED"
    );
  });

  it("approves and enables a capability only after merchant allowlist", async () => {
    const { client, state } = createFakeClient();
    await enableLivePilotMerchant("merchant_1", { notes: "Pilot account" }, client);
    const approval = await approveLivePilotCapability("merchant_1", "LIVE_KMS", { reason: "Pilot KMS review complete" }, client);
    assert.equal(approval.capability.status, "APPROVED");

    const enabled = await enableLivePilotCapability("merchant_1", "LIVE_KMS", {}, client);
    assert.equal(enabled.capability.status, "ENABLED");
    assert.equal(state.auditLogs.length, 3);
  });

  it("disable rollback always works for merchants and capabilities", async () => {
    const { client } = createFakeClient();
    const disabledCapability = await disableLivePilotCapability("merchant_1", "LIVE_EMAIL_SANDBOX", {}, client);
    assert.equal(disabledCapability.capability.status, "DISABLED");

    await enableLivePilotMerchant("merchant_1", {}, client);
    await approveLivePilotCapability("merchant_1", "LIVE_KMS", {}, client);
    await enableLivePilotCapability("merchant_1", "LIVE_KMS", {}, client);
    const disabledMerchant = await disableLivePilotMerchant("merchant_1", {}, client);
    assert.equal(disabledMerchant.merchant.status, "DISABLED");
    assert.equal(disabledMerchant.readiness.allowlisted, false);
  });

  it("readiness snapshot reflects allowlist, capability approvals, and rollback", async () => {
    const { client } = createFakeClient();
    await enableLivePilotMerchant("merchant_1", {}, client);
    await approveLivePilotCapability("merchant_1", "LIVE_KMS", {}, client);
    const snapshot = await getLivePilotReadinessSnapshot("merchant_1", client);
    assert.equal(snapshot.allowlisted, true);
    assert.deepEqual(snapshot.approvedCapabilities, ["LIVE_KMS"]);
    assert.equal(snapshot.rollbackReady, true);
  });

  it("audit list is merchant scoped and safe", async () => {
    const { client } = createFakeClient();
    await enableLivePilotMerchant("merchant_1", { actorId: "admin-user", notes: "safe" }, client);
    await enableLivePilotMerchant("merchant_2", {}, client);
    const logs = await listLivePilotAuditLogs("merchant_1", { page: 1, per_page: 20 }, client);
    assert.equal(logs.audit_logs.length, 1);
    assert.equal(logs.audit_logs[0]?.actor, "recorded");
  });

  it("merchant detail includes default disabled capability rows", async () => {
    const { client } = createFakeClient();
    const detail = await getLivePilotMerchant("merchant_1", client);
    assert.equal(detail.merchant.status, "DISABLED");
    assert.ok(detail.capabilities.some((capability) => capability.capability === "LIVE_AWB_LABEL"));
  });

  it("serializers do not expose unsafe metadata", () => {
    const sanitized = JSON.stringify(sanitizeLivePilotMeta({
      token: "secret-token",
      rawPayload: { order: 1 },
      safeCount: 1,
      providerName: "internal-provider",
      nested: { webhookSecret: "secret", status: "ok" }
    }));
    assert.match(sanitized, /safeCount/);
    assert.match(sanitized, /status/);
    assert.doesNotMatch(sanitized, /secret-token|rawPayload|providerName|webhookSecret|internal-provider/i);
  });

  it("does not add external calls, email sends, platform writes, shipping actions, or schedulers", () => {
    const source = [
      readFileSync("src/modules/livePilot/live-pilot.service.ts", "utf8"),
      readFileSync("src/modules/livePilot/live-pilot.routes.ts", "utf8")
    ].join("\n");
    assert.doesNotMatch(source, /fetch\(|axios|sendMail|nodemailer|createLabel|getLabel|manifestOrder|getRates|shipNow|webhook registration|setInterval|cron/i);
  });
});
