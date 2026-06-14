import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlatformImportItemStatus, PlatformImportJobStatus } from "@prisma/client";
import {
  createMerchantNotification,
  generateImportDigestNotification,
  getMerchantNotificationPreferences,
  getUnreadMerchantNotificationCount,
  listMerchantNotifications,
  markAllMerchantNotificationsRead,
  markMerchantNotificationRead,
  markMerchantNotificationUnread,
  notifyConversionResult,
  notifyImportJobFailed,
  notifyImportItemIssue,
  recordImportItemNotifications,
  updateMerchantNotificationPreferences
} from "../merchant-notification.service.js";

type NotificationRow = {
  id: string;
  merchantId: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  message: string;
  actionLabel: string | null;
  actionUrl: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sourceMeta: unknown;
  dedupeKey: string | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type PreferenceRow = {
  id: string;
  merchantId: string;
  inAppEnabled: boolean;
  importFailedEnabled: boolean;
  needsReviewEnabled: boolean;
  duplicateEnabled: boolean;
  conversionBlockedEnabled: boolean;
  digestEnabled: boolean;
  emailEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function now() {
  return new Date("2026-06-08T08:00:00.000Z");
}

function makePreference(merchantId: string, overrides: Partial<PreferenceRow> = {}): PreferenceRow {
  return {
    id: `pref_${merchantId}`,
    merchantId,
    inAppEnabled: true,
    importFailedEnabled: true,
    needsReviewEnabled: true,
    duplicateEnabled: true,
    conversionBlockedEnabled: true,
    digestEnabled: true,
    emailEnabled: false,
    createdAt: now(),
    updatedAt: now(),
    ...overrides
  };
}

function createFakeClient() {
  const state = {
    notifications: [] as NotificationRow[],
    preferences: [] as PreferenceRow[],
    jobs: [] as Array<{ merchantId: string; status: string }>,
    items: [] as Array<{ merchantId: string; status?: string; nextAttemptAt?: Date | null }>,
    conversions: [] as Array<{ merchantId: string; status: string }>
  };

  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "not" in value) {
      const expected = (value as { not: unknown }).not;
      return expected === null ? row[key] != null : row[key] !== expected;
    }
    return row[key] === value;
  });

  const client = {
    merchantNotificationPreference: {
      findUnique: async ({ where }: any) => state.preferences.find((pref) => pref.merchantId === where.merchantId) ?? null,
      create: async ({ data }: any) => {
        const pref = makePreference(data.merchantId, data);
        state.preferences.push(pref);
        return pref;
      },
      upsert: async ({ where, create, update }: any) => {
        let pref = state.preferences.find((row) => row.merchantId === where.merchantId);
        if (!pref) {
          pref = makePreference(create.merchantId, create);
          state.preferences.push(pref);
          return pref;
        }
        Object.assign(pref, update, { updatedAt: now() });
        return pref;
      }
    },
    merchantNotification: {
      create: async ({ data }: any) => {
        if (data.dedupeKey && state.notifications.some((row) => row.merchantId === data.merchantId && row.dedupeKey === data.dedupeKey)) {
          const error = new Error("unique");
          (error as any).code = "P2002";
          throw error;
        }
        const row: NotificationRow = {
          id: `notif_${state.notifications.length + 1}`,
          merchantId: data.merchantId,
          type: data.type,
          severity: data.severity,
          status: data.status ?? "UNREAD",
          title: data.title,
          message: data.message,
          actionLabel: data.actionLabel ?? null,
          actionUrl: data.actionUrl ?? null,
          sourceType: data.sourceType ?? null,
          sourceId: data.sourceId ?? null,
          sourceMeta: data.sourceMeta ?? null,
          dedupeKey: data.dedupeKey ?? null,
          readAt: data.readAt ?? null,
          createdAt: now(),
          updatedAt: now()
        };
        state.notifications.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.notifications.find((row) => matches(row as any, where)) ?? null,
      findMany: async ({ where = {}, skip = 0, take = 20, orderBy }: any = {}) => {
        const rows = state.notifications.filter((row) => matches(row as any, where));
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows.slice(skip, skip + take);
      },
      count: async ({ where = {} }: any = {}) => state.notifications.filter((row) => matches(row as any, where)).length,
      update: async ({ where, data }: any) => {
        const row = state.notifications.find((notification) => notification.id === where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now() });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = state.notifications.filter((row) => matches(row as any, where));
        rows.forEach((row) => Object.assign(row, data, { updatedAt: now() }));
        return { count: rows.length };
      }
    },
    platformImportJob: {
      count: async ({ where = {} }: any = {}) => state.jobs.filter((row) => matches(row as any, where)).length
    },
    platformImportItem: {
      count: async ({ where = {} }: any = {}) => state.items.filter((row) => matches(row as any, where)).length
    },
    platformImportConversion: {
      count: async ({ where = {} }: any = {}) => state.conversions.filter((row) => matches(row as any, where)).length
    }
  };

  return { state, client: client as any };
}

const baseNotification = {
  type: "IMPORT_ITEM_FAILED" as const,
  severity: "ERROR" as const,
  title: "Import failed",
  message: "Review imported order.",
  actionLabel: "Review",
  actionUrl: "/seller/developer",
  sourceType: "PLATFORM_IMPORT_ITEM" as const,
  sourceId: "item_1",
  sourceMeta: {
    rawPayload: { accessToken: "shpat_secret", buyerPhone: "9876543210" },
    rawHeaders: { Authorization: "Bearer secret" },
    providerName: "Bigship",
    safe_count: 1
  },
  dedupeKey: "import-item-failed:item_1"
};

describe("merchant notification foundation", () => {
  it("creates merchant-scoped notifications and dedupes by key", async () => {
    const { state, client } = createFakeClient();
    const first = await createMerchantNotification("merchant_1", baseNotification, client);
    const second = await createMerchantNotification("merchant_1", baseNotification, client);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(state.notifications.length, 1);
    const json = JSON.stringify(first.notification);
    assert.doesNotMatch(json, /shpat_secret|Authorization|rawPayload|rawHeaders|Bigship|providerName/i);
    assert.match(json, /safe_count/);
  });

  it("lists, counts, and marks notifications within merchant scope", async () => {
    const { state, client } = createFakeClient();
    await createMerchantNotification("merchant_1", baseNotification, client);
    await createMerchantNotification("merchant_2", { ...baseNotification, dedupeKey: "m2", sourceId: "item_2" }, client);

    const list = await listMerchantNotifications("merchant_1", { page: 1, per_page: 20 }, client);
    const unread = await getUnreadMerchantNotificationCount("merchant_1", client);
    assert.equal(list.notifications.length, 1);
    assert.equal(unread.unread_count, 1);

    await markMerchantNotificationRead("merchant_1", state.notifications[0]!.id, client);
    assert.equal((await getUnreadMerchantNotificationCount("merchant_1", client)).unread_count, 0);
    await markMerchantNotificationUnread("merchant_1", state.notifications[0]!.id, client);
    assert.equal((await getUnreadMerchantNotificationCount("merchant_1", client)).unread_count, 1);
    await markAllMerchantNotificationsRead("merchant_1", client);
    assert.equal((await getUnreadMerchantNotificationCount("merchant_1", client)).unread_count, 0);
    assert.equal(state.notifications.find((row) => row.merchantId === "merchant_2")?.status, "UNREAD");
  });

  it("returns safe default preferences with email disabled and supports updates", async () => {
    const { client } = createFakeClient();
    const defaults = await getMerchantNotificationPreferences("merchant_1", client);
    assert.equal(defaults.email_enabled, false);
    assert.equal(defaults.in_app_enabled, true);

    const updated = await updateMerchantNotificationPreferences("merchant_1", {
      duplicate_enabled: false,
      email_enabled: false
    }, client);
    assert.equal(updated.duplicate_enabled, false);
    assert.equal(updated.email_enabled, false);
  });

  it("generates import job, item, conversion, and digest notifications in-app only", async () => {
    const { state, client } = createFakeClient();
    state.jobs.push({ merchantId: "merchant_1", status: PlatformImportJobStatus.FAILED });
    state.items.push(
      { merchantId: "merchant_1", status: PlatformImportItemStatus.FAILED },
      { merchantId: "merchant_1", status: PlatformImportItemStatus.DUPLICATE },
      { merchantId: "merchant_1", status: PlatformImportItemStatus.FAILED, nextAttemptAt: now() }
    );
    state.conversions.push({ merchantId: "merchant_1", status: "NEEDS_ATTENTION" });

    await notifyImportJobFailed({
      id: "job_1",
      merchantId: "merchant_1",
      platform: "SHOPIFY",
      status: PlatformImportJobStatus.FAILED,
      failedItems: 2,
      totalItems: 3,
      warningCount: 1
    }, client);
    await notifyImportItemIssue({
      id: "item_failed",
      merchantId: "merchant_1",
      jobId: "job_1",
      connectionId: "conn_1",
      platform: "SHOPIFY",
      status: PlatformImportItemStatus.FAILED
    }, "IMPORT_ITEM_FAILED", client);
    await recordImportItemNotifications({
      id: "item_duplicate",
      merchantId: "merchant_1",
      jobId: "job_1",
      connectionId: "conn_1",
      platform: "SHOPIFY",
      status: PlatformImportItemStatus.DUPLICATE,
      nextAttemptAt: now()
    }, client);
    await recordImportItemNotifications({
      id: "item_review",
      merchantId: "merchant_1",
      jobId: "job_1",
      connectionId: "conn_1",
      platform: "SHOPIFY",
      status: PlatformImportItemStatus.MAPPED,
      mappingWarnings: ["Phone number missing"]
    }, client);
    await notifyConversionResult("merchant_1", {
      itemId: "item_blocked",
      status: "BLOCKED",
      reasonCodes: ["ITEM_FAILED"],
      warnings: ["Review required"]
    }, client);
    await notifyConversionResult("merchant_1", {
      itemId: "item_attention",
      status: "NEEDS_ATTENTION",
      orderId: "order_1",
      queue: "NEEDS_ATTENTION",
      warnings: ["Address Quality Check required"]
    }, client);
    await notifyConversionResult("merchant_1", {
      itemId: "item_done",
      status: "CONVERTED",
      orderId: "order_2",
      queue: "READY_TO_SHIP"
    }, client);
    await generateImportDigestNotification("merchant_1", client);

    const types = state.notifications.map((row) => row.type).sort();
    assert.deepEqual(types, [
      "CONVERSION_BLOCKED",
      "CONVERSION_COMPLETED",
      "CONVERSION_NEEDS_ATTENTION",
      "IMPORT_DIGEST",
      "IMPORT_ITEM_DUPLICATE",
      "IMPORT_ITEM_FAILED",
      "IMPORT_ITEM_NEEDS_REVIEW",
      "IMPORT_ITEM_RETRY_READY",
      "IMPORT_JOB_FAILED"
    ].sort());
    const digest = state.notifications.find((row) => row.type === "IMPORT_DIGEST");
    assert.equal((digest?.sourceMeta as any)?.email_sent, false);
    assert.doesNotMatch(JSON.stringify(state.notifications.map((row) => row.sourceMeta)), /rawPayload|rawHeaders|secret|token|Bigship/i);
  });

  it("does not create orders, shipments, rates, labels, platform writes, schedulers, or email sends", async () => {
    const source = await import("node:fs").then(({ readFileSync }) => readFileSync("src/modules/merchantNotifications/merchant-notification.service.ts", "utf8"));
    assert.doesNotMatch(source, /sendMail|nodemailer|smtp|createLabel|getLabel|manifestOrder|getRates|webhook registration|setInterval|cron/i);
  });
});
