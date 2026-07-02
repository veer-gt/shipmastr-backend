import { prisma } from "../../lib/prisma.js";

type DbClient = typeof prisma | Record<string, any>;

const ATTENTION_STATUSES = new Set(["ERROR", "FAILED", "FAILING", "DEGRADED", "EXPIRED", "REVOKED"]);
const ACTIVE_STATUSES = new Set(["ACTIVE", "HEALTHY", "PROCESSED", "DELIVERED", "COMPLETED"]);

function numberValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

async function safeCount(model: any, args: Record<string, unknown>) {
  if (!model?.count) return 0;
  try {
    return numberValue(await model.count(args));
  } catch {
    return 0;
  }
}

async function safeFindMany(model: any, args: Record<string, unknown>) {
  if (!model?.findMany) return [];
  try {
    const rows = await model.findMany(args);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function isoDate(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stateCategory(status: unknown) {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (ATTENTION_STATUSES.has(normalized)) return "needs_attention";
  if (ACTIVE_STATUSES.has(normalized)) return "healthy";
  if (["QUEUED", "PENDING", "DRAFT", "PROCESSING", "RUNNING", "PAUSED"].includes(normalized)) return "pending";
  return "unknown";
}

function recentSafe(rows: any[], mapper: (row: any) => Record<string, unknown>) {
  return rows.slice(0, 5).map(mapper);
}

function countWhere(rows: any[], predicate: (row: any) => boolean) {
  return rows.filter(predicate).length;
}

function sum(rows: any[], key: string) {
  return rows.reduce((total, row) => total + numberValue(row?.[key]), 0);
}

function action(key: string, label: string, route: string, severity: string, detail: string) {
  return { key, label, route, severity, detail };
}

function assertControlPlaneResponseSafe(value: unknown) {
  const serialized = JSON.stringify(value);
  const unsafeMatch = serialized.match(/(secret|token|password|credentialRef|secretRef|secretFingerprint|DATABASE_URL|payload|contextSnapshot|dispatchResult|renderedMessage|recipient|signedUrl|uploadUrl|objectKey|bucket|Bearer|cookie|private_key|api[_-]?key)/i);
  if (unsafeMatch) {
    throw new Error("MERCHANT_CONTROL_PLANE_UNSAFE_RESPONSE");
  }
}

export async function buildMerchantControlPlane(merchantId: string, client: DbClient = prisma) {
  const [
    connections,
    credentials,
    healthChecks,
    importJobs,
    webhookSubscriptions,
    webhookOutbox,
    platformWebhookEvents,
    webhookRegistrations,
    workflows,
    automationEvents,
    templates,
    communications,
    auditLogs
  ] = await Promise.all([
    safeFindMany((client as any).platformConnection, {
      where: { merchantId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true,
        platform: true,
        status: true,
        syncDirection: true,
        lastOrderImportAt: true,
        lastTrackingSyncAt: true,
        lastErrorCode: true,
        updatedAt: true
      }
    }),
    safeFindMany((client as any).platformCredential, {
      where: { merchantId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        platform: true,
        status: true,
        lastUsedAt: true,
        expiresAt: true,
        rotatedAt: true,
        updatedAt: true
      }
    }),
    safeFindMany((client as any).platformConnectionHealthCheck, {
      where: { merchantId },
      orderBy: { checkedAt: "desc" },
      take: 10,
      select: {
        platform: true,
        checkType: true,
        status: true,
        errorCode: true,
        checkedAt: true
      }
    }),
    safeFindMany((client as any).platformImportJob, {
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        platform: true,
        mode: true,
        source: true,
        status: true,
        totalItems: true,
        importedItems: true,
        failedItems: true,
        warningCount: true,
        createdAt: true,
        completedAt: true
      }
    }),
    safeFindMany((client as any).webhookSubscription, {
      where: { merchantId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        status: true,
        events: true,
        failureCount: true,
        lastDeliveredAt: true,
        lastFailedAt: true,
        updatedAt: true
      }
    }),
    safeFindMany((client as any).webhookEventOutbox, {
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        eventType: true,
        status: true,
        attemptCount: true,
        nextAttemptAt: true,
        lastAttemptAt: true,
        deliveredAt: true,
        failedAt: true,
        createdAt: true
      }
    }),
    safeFindMany((client as any).platformWebhookEvent, {
      where: { merchantId },
      orderBy: { receivedAt: "desc" },
      take: 10,
      select: {
        platform: true,
        topic: true,
        status: true,
        receivedAt: true,
        processedAt: true
      }
    }),
    safeFindMany((client as any).platformWebhookRegistration, {
      where: { merchantId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        platform: true,
        topic: true,
        status: true,
        registeredAt: true,
        disabledAt: true,
        updatedAt: true
      }
    }),
    safeFindMany((client as any).automationWorkflowSetting, {
      where: { merchantId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        key: true,
        status: true,
        retryLimit: true,
        quietHoursMode: true,
        updatedAt: true
      }
    }),
    safeFindMany((client as any).automationEvent, {
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        eventKey: true,
        status: true,
        source: true,
        attempts: true,
        nextAttemptAt: true,
        processedAt: true,
        failedAt: true,
        createdAt: true
      }
    }),
    safeFindMany((client as any).automationTemplate, {
      where: { OR: [{ merchantId }, { merchantId: null }] },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        key: true,
        channel: true,
        active: true,
        systemTemplate: true,
        updatedAt: true
      }
    }),
    safeFindMany((client as any).communicationLog, {
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        channel: true,
        templateKey: true,
        status: true,
        sentAt: true,
        deliveredAt: true,
        failedAt: true,
        createdAt: true
      }
    }),
    safeFindMany((client as any).auditLog, {
      where: { merchantId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        action: true,
        entityType: true,
        createdAt: true
      }
    })
  ]);

  const connectionAttention = countWhere(connections, (row) => stateCategory(row.status) === "needs_attention");
  const webhookAttention = countWhere(webhookSubscriptions, (row) => stateCategory(row.status) === "needs_attention")
    + countWhere(webhookOutbox, (row) => stateCategory(row.status) === "needs_attention")
    + countWhere(platformWebhookEvents, (row) => stateCategory(row.status) === "needs_attention");
  const automationAttention = countWhere(automationEvents, (row) => stateCategory(row.status) === "needs_attention");
  const credentialAttention = countWhere(credentials, (row) => stateCategory(row.status) === "needs_attention");
  const importAttention = countWhere(importJobs, (row) => stateCategory(row.status) === "needs_attention" || numberValue(row.failedItems) > 0 || numberValue(row.warningCount) > 0);

  const nextActions = [
    connectionAttention || credentialAttention
      ? action("review-integrations", "Review integration health", "/merchant/integrations", "warning", "One or more storefront connections or credentials need merchant review.")
      : null,
    webhookAttention
      ? action("review-webhooks", "Review webhook delivery", "/merchant/webhooks", "warning", "Webhook subscriptions or deliveries need attention before automation is expanded.")
      : null,
    automationAttention
      ? action("review-automation", "Review automation queue", "/merchant/automation", "warning", "Automation events show failed or stuck processing states.")
      : null,
    importAttention
      ? action("review-imports", "Review import jobs", "/merchant/integrations", "info", "Recent import jobs have warnings, failures, or pending work.")
      : null,
    !connections.length
      ? action("connect-store", "Connect a store", "/merchant/integrations", "info", "Connect Shopify, WooCommerce, Magento, or a custom commerce source when ready.")
      : null,
    !webhookSubscriptions.length && !webhookRegistrations.length
      ? action("configure-webhooks", "Configure webhook endpoints", "/merchant/webhooks", "info", "Create signed webhook endpoints before relying on event-driven workflows.")
      : null
  ].filter(Boolean);

  const response = {
    generatedAt: new Date().toISOString(),
    scope: "merchant_control_plane",
    integrations: {
      connections: {
        total: connections.length,
        active: countWhere(connections, (row) => String(row.status).toUpperCase() === "ACTIVE"),
        draft: countWhere(connections, (row) => String(row.status).toUpperCase() === "DRAFT"),
        needsAttention: connectionAttention,
        recent: recentSafe(connections, (row) => ({
          platform: row.platform,
          status: row.status,
          stateCategory: stateCategory(row.status),
          syncDirection: row.syncDirection,
          lastOrderImportAt: isoDate(row.lastOrderImportAt),
          lastTrackingSyncAt: isoDate(row.lastTrackingSyncAt),
          lastErrorCode: row.lastErrorCode ?? null,
          updatedAt: isoDate(row.updatedAt)
        }))
      },
      credentials: {
        total: credentials.length,
        active: countWhere(credentials, (row) => String(row.status).toUpperCase() === "ACTIVE"),
        needsAttention: credentialAttention,
        recent: recentSafe(credentials, (row) => ({
          platform: row.platform,
          status: row.status,
          stateCategory: stateCategory(row.status),
          lastUsedAt: isoDate(row.lastUsedAt),
          expiresAt: isoDate(row.expiresAt),
          rotatedAt: isoDate(row.rotatedAt),
          updatedAt: isoDate(row.updatedAt)
        }))
      },
      healthChecks: {
        total: healthChecks.length,
        healthy: countWhere(healthChecks, (row) => String(row.status).toUpperCase() === "HEALTHY"),
        needsAttention: countWhere(healthChecks, (row) => stateCategory(row.status) === "needs_attention"),
        recent: recentSafe(healthChecks, (row) => ({
          platform: row.platform,
          checkType: row.checkType,
          status: row.status,
          stateCategory: stateCategory(row.status),
          errorCode: row.errorCode ?? null,
          checkedAt: isoDate(row.checkedAt)
        }))
      },
      imports: {
        total: importJobs.length,
        queued: countWhere(importJobs, (row) => ["QUEUED", "RUNNING", "DRAFT"].includes(String(row.status).toUpperCase())),
        completed: countWhere(importJobs, (row) => ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(String(row.status).toUpperCase())),
        needsAttention: importAttention,
        totalItems: sum(importJobs, "totalItems"),
        importedItems: sum(importJobs, "importedItems"),
        failedItems: sum(importJobs, "failedItems"),
        warningCount: sum(importJobs, "warningCount"),
        recent: recentSafe(importJobs, (row) => ({
          platform: row.platform,
          mode: row.mode,
          source: row.source,
          status: row.status,
          stateCategory: stateCategory(row.status),
          totalItems: numberValue(row.totalItems),
          importedItems: numberValue(row.importedItems),
          failedItems: numberValue(row.failedItems),
          warningCount: numberValue(row.warningCount),
          createdAt: isoDate(row.createdAt),
          completedAt: isoDate(row.completedAt)
        }))
      }
    },
    webhooks: {
      subscriptions: {
        total: webhookSubscriptions.length,
        active: countWhere(webhookSubscriptions, (row) => String(row.status).toUpperCase() === "ACTIVE"),
        needsAttention: countWhere(webhookSubscriptions, (row) => stateCategory(row.status) === "needs_attention"),
        totalFailures: sum(webhookSubscriptions, "failureCount"),
        recent: recentSafe(webhookSubscriptions, (row) => ({
          status: row.status,
          stateCategory: stateCategory(row.status),
          eventCount: Array.isArray(row.events) ? row.events.length : 0,
          failureCount: numberValue(row.failureCount),
          lastDeliveredAt: isoDate(row.lastDeliveredAt),
          lastFailedAt: isoDate(row.lastFailedAt),
          updatedAt: isoDate(row.updatedAt)
        }))
      },
      outbox: {
        total: webhookOutbox.length,
        pending: countWhere(webhookOutbox, (row) => String(row.status).toUpperCase() === "PENDING"),
        delivered: countWhere(webhookOutbox, (row) => String(row.status).toUpperCase() === "DELIVERED"),
        failed: countWhere(webhookOutbox, (row) => String(row.status).toUpperCase() === "FAILED"),
        recent: recentSafe(webhookOutbox, (row) => ({
          eventType: row.eventType,
          status: row.status,
          stateCategory: stateCategory(row.status),
          attemptCount: numberValue(row.attemptCount),
          nextAttemptAt: isoDate(row.nextAttemptAt),
          lastAttemptAt: isoDate(row.lastAttemptAt),
          deliveredAt: isoDate(row.deliveredAt),
          failedAt: isoDate(row.failedAt),
          createdAt: isoDate(row.createdAt)
        }))
      },
      platformEvents: {
        total: platformWebhookEvents.length,
        needsAttention: countWhere(platformWebhookEvents, (row) => stateCategory(row.status) === "needs_attention"),
        recent: recentSafe(platformWebhookEvents, (row) => ({
          platform: row.platform,
          topic: row.topic,
          status: row.status,
          stateCategory: stateCategory(row.status),
          receivedAt: isoDate(row.receivedAt),
          processedAt: isoDate(row.processedAt)
        }))
      },
      registrations: {
        total: webhookRegistrations.length,
        active: countWhere(webhookRegistrations, (row) => String(row.status).toUpperCase() === "ACTIVE"),
        draft: countWhere(webhookRegistrations, (row) => String(row.status).toUpperCase() === "DRAFT"),
        needsAttention: countWhere(webhookRegistrations, (row) => stateCategory(row.status) === "needs_attention"),
        recent: recentSafe(webhookRegistrations, (row) => ({
          platform: row.platform,
          topic: row.topic,
          status: row.status,
          stateCategory: stateCategory(row.status),
          registeredAt: isoDate(row.registeredAt),
          disabledAt: isoDate(row.disabledAt),
          updatedAt: isoDate(row.updatedAt)
        }))
      }
    },
    automation: {
      workflows: {
        total: workflows.length,
        active: countWhere(workflows, (row) => String(row.status).toUpperCase() === "ACTIVE"),
        paused: countWhere(workflows, (row) => String(row.status).toUpperCase() === "PAUSED"),
        recent: recentSafe(workflows, (row) => ({
          key: row.key,
          status: row.status,
          stateCategory: stateCategory(row.status),
          retryLimit: numberValue(row.retryLimit),
          quietHoursMode: row.quietHoursMode,
          updatedAt: isoDate(row.updatedAt)
        }))
      },
      events: {
        total: automationEvents.length,
        queued: countWhere(automationEvents, (row) => ["QUEUED", "PROCESSING"].includes(String(row.status).toUpperCase())),
        processed: countWhere(automationEvents, (row) => ["PROCESSED", "DISPATCHED"].includes(String(row.status).toUpperCase())),
        failed: countWhere(automationEvents, (row) => String(row.status).toUpperCase() === "FAILED"),
        recent: recentSafe(automationEvents, (row) => ({
          eventKey: row.eventKey,
          status: row.status,
          stateCategory: stateCategory(row.status),
          source: row.source,
          attempts: numberValue(row.attempts),
          nextAttemptAt: isoDate(row.nextAttemptAt),
          processedAt: isoDate(row.processedAt),
          failedAt: isoDate(row.failedAt),
          createdAt: isoDate(row.createdAt)
        }))
      },
      templates: {
        total: templates.length,
        active: countWhere(templates, (row) => row.active === true),
        systemTemplates: countWhere(templates, (row) => row.systemTemplate === true)
      },
      communications: {
        total: communications.length,
        queued: countWhere(communications, (row) => String(row.status).toUpperCase() === "QUEUED"),
        sent: countWhere(communications, (row) => ["SENT", "DELIVERED", "READ"].includes(String(row.status).toUpperCase())),
        failed: countWhere(communications, (row) => String(row.status).toUpperCase() === "FAILED"),
        recent: recentSafe(communications, (row) => ({
          channel: row.channel,
          templateKey: row.templateKey ?? null,
          status: row.status,
          stateCategory: stateCategory(row.status),
          sentAt: isoDate(row.sentAt),
          deliveredAt: isoDate(row.deliveredAt),
          failedAt: isoDate(row.failedAt),
          createdAt: isoDate(row.createdAt)
        }))
      }
    },
    aiOps: {
      status: "read_model_only",
      reviewMode: "operator_approved",
      signals: {
        integrationWarnings: connectionAttention + credentialAttention + importAttention,
        webhookWarnings: webhookAttention,
        automationWarnings: automationAttention
      },
      auditTrail: {
        total: auditLogs.length,
        recent: recentSafe(auditLogs, (row) => ({
          action: row.action,
          entityType: row.entityType,
          createdAt: isoDate(row.createdAt)
        }))
      }
    },
    actions: {
      guarded: [
        { key: "connect-store", label: "Connect store", route: "/merchant/integrations", status: "contract_required" },
        { key: "configure-webhook", label: "Configure webhook", route: "/merchant/webhooks", status: "contract_required" },
        { key: "create-workflow", label: "Create workflow", route: "/merchant/automation", status: "contract_required" },
        { key: "approve-automation", label: "Approve automation", route: "/merchant/automation", status: "contract_required" },
        { key: "rotate-credential", label: "Rotate credential", route: "/merchant/integrations", status: "contract_required" }
      ]
    },
    nextActions
  };

  assertControlPlaneResponseSafe(response);
  return response;
}
