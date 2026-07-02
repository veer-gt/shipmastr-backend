import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildMerchantControlPlane,
  requestMerchantControlPlaneAction,
  requestMerchantControlPlaneWorkspaceAction
} from "./merchant-control-plane.service.js";

function findManyFrom(rows: any[]) {
  return async () => rows;
}

function makeClient(overrides: Record<string, any> = {}) {
  const auditLogs: any[] = [];
  return {
    platformConnection: {
      findMany: findManyFrom([
        {
          id: "conn_1",
          platform: "SHOPIFY",
          status: "ACTIVE",
          syncDirection: "IMPORT_ONLY",
          credentialsRef: "projects/demo/secrets/should-not-leak",
          lastOrderImportAt: new Date("2026-07-01T08:00:00.000Z"),
          lastTrackingSyncAt: null,
          lastErrorCode: null,
          updatedAt: new Date("2026-07-01T09:00:00.000Z")
        },
        {
          id: "conn_2",
          platform: "WOOCOMMERCE",
          status: "ERROR",
          syncDirection: "BIDIRECTIONAL",
          lastOrderImportAt: null,
          lastTrackingSyncAt: null,
          lastErrorCode: "AUTH_FAILED",
          updatedAt: new Date("2026-07-01T10:00:00.000Z")
        }
      ])
    },
    platformCredential: {
      findMany: findManyFrom([
        {
          platform: "SHOPIFY",
          credentialType: "SHOPIFY_CUSTOM_APP_TOKEN",
          status: "ACTIVE",
          secretRef: "secret-ref-should-not-leak",
          secretFingerprint: "fingerprint-should-not-leak",
          lastUsedAt: new Date("2026-07-01T08:30:00.000Z"),
          expiresAt: null,
          rotatedAt: null,
          updatedAt: new Date("2026-07-01T09:00:00.000Z")
        },
        {
          platform: "WOOCOMMERCE",
          credentialType: "WOOCOMMERCE_REST_KEYS",
          status: "EXPIRED",
          lastUsedAt: null,
          expiresAt: new Date("2026-07-01T00:00:00.000Z"),
          rotatedAt: null,
          updatedAt: new Date("2026-07-01T10:00:00.000Z")
        }
      ])
    },
    platformConnectionHealthCheck: {
      findMany: findManyFrom([
        {
          platform: "SHOPIFY",
          checkType: "OVERALL",
          status: "HEALTHY",
          message: "safe message not serialized",
          errorCode: null,
          checkedAt: new Date("2026-07-01T09:30:00.000Z")
        }
      ])
    },
    platformImportJob: {
      findMany: findManyFrom([
        {
          platform: "SHOPIFY",
          mode: "IMPORT_FOUNDATION",
          source: "POLLING_PLACEHOLDER",
          status: "COMPLETED_WITH_WARNINGS",
          totalItems: 12,
          importedItems: 10,
          failedItems: 0,
          warningCount: 2,
          safeSummary: { note: "not serialized" },
          createdAt: new Date("2026-07-01T08:00:00.000Z"),
          completedAt: new Date("2026-07-01T08:15:00.000Z")
        }
      ])
    },
    webhookSubscription: {
      findMany: findManyFrom([
        {
          status: "FAILING",
          events: ["order.created", "shipment.updated"],
          failureCount: 3,
          url: "https://example.test/should-not-leak",
          secretHash: "should-not-leak",
          lastDeliveredAt: null,
          lastFailedAt: new Date("2026-07-01T08:45:00.000Z"),
          updatedAt: new Date("2026-07-01T09:00:00.000Z")
        }
      ])
    },
    webhookEventOutbox: {
      findMany: findManyFrom([
        {
          eventType: "merchant.updated",
          status: "PENDING",
          payload: { password: "should-not-leak" },
          attemptCount: 1,
          nextAttemptAt: new Date("2026-07-01T09:15:00.000Z"),
          lastAttemptAt: null,
          deliveredAt: null,
          failedAt: null,
          createdAt: new Date("2026-07-01T09:00:00.000Z")
        }
      ])
    },
    platformWebhookEvent: {
      findMany: findManyFrom([
        {
          platform: "SHOPIFY",
          topic: "orders/create",
          status: "RECEIVED",
          externalEventId: "external-id-should-not-leak",
          eventHash: "hash-should-not-leak",
          receivedAt: new Date("2026-07-01T09:00:00.000Z"),
          processedAt: null
        }
      ])
    },
    platformWebhookRegistration: {
      findMany: findManyFrom([
        {
          platform: "SHOPIFY",
          topic: "orders/create",
          status: "DRAFT",
          callbackUrlSafe: "https://example.test/safe-but-not-serialized",
          externalWebhookId: "external-hook-should-not-leak",
          registeredAt: null,
          disabledAt: null,
          updatedAt: new Date("2026-07-01T09:00:00.000Z")
        }
      ])
    },
    automationWorkflowSetting: {
      findMany: findManyFrom([
        {
          key: "ndr_rescue",
          status: "ACTIVE",
          retryLimit: 3,
          quietHoursMode: "respect",
          settings: { token: "should-not-leak" },
          updatedAt: new Date("2026-07-01T09:00:00.000Z")
        }
      ])
    },
    automationEvent: {
      findMany: findManyFrom([
        {
          eventKey: "ndr.rescue",
          status: "FAILED",
          source: "shipmastr",
          sourceId: "source-id-should-not-leak",
          payload: { secret: "should-not-leak" },
          attempts: 2,
          nextAttemptAt: null,
          processedAt: null,
          failedAt: new Date("2026-07-01T09:00:00.000Z"),
          createdAt: new Date("2026-07-01T08:00:00.000Z")
        }
      ])
    },
    automationTemplate: {
      findMany: findManyFrom([
        {
          key: "ndr_rescue",
          channel: "EMAIL",
          active: true,
          systemTemplate: true,
          body: "message body should not leak",
          updatedAt: new Date("2026-07-01T09:00:00.000Z")
        }
      ])
    },
    communicationLog: {
      findMany: findManyFrom([
        {
          channel: "EMAIL",
          templateKey: "ndr_rescue",
          status: "FAILED",
          recipient: "buyer@example.test",
          renderedMessage: "should not leak",
          sentAt: null,
          deliveredAt: null,
          failedAt: new Date("2026-07-01T09:00:00.000Z"),
          createdAt: new Date("2026-07-01T08:00:00.000Z")
        }
      ])
    },
    auditLog: {
      findMany: findManyFrom([
        {
          action: "merchant.integration.reviewed",
          entityType: "PlatformConnection",
          metadata: { apiKey: "should-not-leak" },
          createdAt: new Date("2026-07-01T09:00:00.000Z")
        }
      ]),
      create: async ({ data }: any) => {
        const record = {
          id: `audit_${auditLogs.length + 1}`,
          createdAt: new Date("2026-07-01T10:00:00.000Z"),
          ...data
        };
        auditLogs.push(record);
        return record;
      },
      records: auditLogs
    },
    ...overrides
  };
}

describe("merchant control plane read model", () => {
  it("mounts the control-plane route behind the merchant account router", () => {
    const routes = readFileSync("src/modules/merchantAccount/merchant-account.routes.ts", "utf8");
    assert.match(routes, /merchantAccountRouter\.get\("\/control-plane"/);
    assert.match(routes, /merchantAccountRouter\.post\("\/control-plane\/actions"/);
    assert.match(routes, /merchantAccountRouter\.post\("\/control-plane\/workspace-actions"/);
    assert.match(routes, /requireMerchantCommandCenterActor/);
  });

  it("builds a merchant-scoped control plane without unsafe fields", async () => {
    const result = await buildMerchantControlPlane("merchant_1", makeClient() as any);
    const serialized = JSON.stringify(result);

    assert.equal(result.scope, "merchant_control_plane");
    assert.equal(result.integrations.connections.total, 2);
    assert.equal(result.integrations.connections.active, 1);
    assert.equal(result.integrations.connections.needsAttention, 1);
    assert.equal(result.integrations.credentials.needsAttention, 1);
    assert.equal(result.integrations.imports.warningCount, 2);
    assert.equal(result.webhooks.subscriptions.needsAttention, 1);
    assert.equal(result.webhooks.outbox.pending, 1);
    assert.equal(result.automation.events.failed, 1);
    assert.equal(result.aiOps.signals.integrationWarnings, 3);
    assert.equal(result.aiOps.summaries.length, 2);
    assert.equal(result.operationalMaturity.webhooks.retryPolicyVisibility, "available");
    assert.equal(result.operationalMaturity.automation.approvalGate, "operator_review_required");
    assert.ok(result.nextActions.some((item: any) => item.key === "review-integrations"));
    assert.ok(result.actions.guarded.every((item: any) => item.status === "contract_required"));
    assert.ok(result.actions.workspace.some((item: any) => item.key === "webhook-retry-review"));
    assert.ok(result.actions.workspace.every((item: any) => item.safety.externalMutation === false));
    assert.equal(serialized.includes("should-not-leak"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes("password"), false);
    assert.equal(serialized.includes("credentialRef"), false);
    assert.equal(serialized.includes("secretRef"), false);
    assert.equal(serialized.includes("payload"), false);
    assert.equal(serialized.includes("recipient"), false);
    assert.equal(serialized.includes("renderedMessage"), false);
  });

  it("returns safe empty states when optional models are unavailable", async () => {
    const result = await buildMerchantControlPlane("merchant_1", {} as any);

    assert.equal(result.integrations.connections.total, 0);
    assert.equal(result.webhooks.subscriptions.total, 0);
    assert.equal(result.automation.workflows.total, 0);
    assert.equal(result.aiOps.signals.integrationWarnings, 0);
    assert.ok(result.nextActions.some((item: any) => item.key === "connect-store"));
    assert.ok(result.nextActions.some((item: any) => item.key === "configure-webhooks"));
  });

  it("records guarded action requests without external side effects", async () => {
    const client = makeClient();
    const result = await requestMerchantControlPlaneAction({
      merchantId: "merchant_1",
      actorId: "user_1",
      actionKey: "configure-webhook",
      note: "Prepare test endpoint. token=should-not-leak"
    }, client as any);

    assert.equal(result.status, "queued_for_review");
    assert.equal(result.route, "/merchant/webhooks");
    assert.equal(result.safety.operatorReviewRequired, true);
    assert.equal(result.safety.externalMutation, false);
    assert.equal(result.safety.providerCall, false);
    assert.equal(result.safety.messageSend, false);
    assert.equal(result.safety.paymentAction, false);
    assert.equal(result.safety.shipmentAction, false);

    const auditRecord = (client.auditLog as any).records[0];
    assert.equal(auditRecord.action, "MERCHANT_CONTROL_PLANE_ACTION_REQUESTED");
    assert.equal(auditRecord.entityType, "merchant_control_plane_action");
    assert.equal(auditRecord.entityId, "configure-webhook");
    assert.equal(auditRecord.metadata.externalMutation, false);
    assert.equal(auditRecord.metadata.note.includes("should-not-leak"), false);
  });

  it("keeps guarded action responses free of secret-bearing fields", async () => {
    const client = makeClient();
    const result = await requestMerchantControlPlaneAction({
      merchantId: "merchant_1",
      actorId: "user_1",
      actionKey: "rotate-credential",
      note: "password=should-not-leak"
    }, client as any);
    const serialized = JSON.stringify(result);

    assert.equal(serialized.includes("should-not-leak"), false);
    assert.equal(serialized.includes("password"), false);
    assert.equal(result.safety.externalMutation, false);
    assert.equal(result.safety.providerCall, false);
  });

  it("records workspace action requests without delivery or automation side effects", async () => {
    const client = makeClient();
    const result = await requestMerchantControlPlaneWorkspaceAction({
      merchantId: "merchant_1",
      actorId: "user_1",
      actionKey: "webhook-test-event-sandbox",
      note: "authorization=should-not-leak"
    }, client as any);

    assert.equal(result.status, "queued_for_operator_review");
    assert.equal(result.workspace, "webhooks");
    assert.equal(result.safety.externalMutation, false);
    assert.equal(result.safety.deliveryAttempt, false);
    assert.equal(result.safety.testEventDelivered, false);
    assert.equal(result.safety.automationExecuted, false);
    assert.equal(result.safety.aiActionApplied, false);
    assert.equal(result.safety.credentialChanged, false);
    assert.equal(result.safety.providerCall, false);
    assert.equal(result.safety.messageSend, false);

    const auditRecord = (client.auditLog as any).records[0];
    assert.equal(auditRecord.action, "MERCHANT_CONTROL_PLANE_WORKSPACE_ACTION_REQUESTED");
    assert.equal(auditRecord.entityType, "merchant_control_plane_workspace_action");
    assert.equal(auditRecord.entityId, "webhook-test-event-sandbox");
    assert.equal(auditRecord.metadata.testEventDelivered, false);
    assert.equal(auditRecord.metadata.automationExecuted, false);
    assert.equal(auditRecord.metadata.note.includes("should-not-leak"), false);
  });
});
