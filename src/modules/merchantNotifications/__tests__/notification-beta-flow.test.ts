import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PlatformImportJobStatus } from "@prisma/client";
import {
  createMerchantNotification,
  generateImportDigestNotification,
  getMerchantNotificationPreferences,
  notifyConversionResult,
  notifyImportJobFailed
} from "../merchant-notification.service.js";

function now() {
  return new Date("2026-06-08T14:30:00.000Z");
}

function createFakeClient() {
  const state = {
    notifications: [] as any[],
    preferences: [] as any[],
    jobs: [] as any[],
    items: [] as any[],
    conversions: [] as any[]
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
  const client = {
    merchantNotificationPreference: {
      findUnique: async ({ where }: any) => state.preferences.find((row) => row.merchantId === where.merchantId) ?? null,
      create: async ({ data }: any) => {
        const row = {
          id: `pref_${state.preferences.length + 1}`,
          merchantId: data.merchantId,
          inAppEnabled: true,
          importFailedEnabled: true,
          needsReviewEnabled: true,
          duplicateEnabled: true,
          conversionBlockedEnabled: true,
          digestEnabled: true,
          emailEnabled: false,
          createdAt: now(),
          updatedAt: now(),
          ...data
        };
        state.preferences.push(row);
        return row;
      }
    },
    merchantNotification: {
      create: async ({ data }: any) => {
        if (data.dedupeKey && state.notifications.some((row) => row.merchantId === data.merchantId && row.dedupeKey === data.dedupeKey)) {
          const error = new Error("unique");
          (error as any).code = "P2002";
          throw error;
        }
        const row = {
          id: `notification_${state.notifications.length + 1}`,
          status: "UNREAD",
          readAt: null,
          createdAt: now(),
          updatedAt: now(),
          ...data
        };
        state.notifications.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.notifications.find((row) => matches(row, where)) ?? null,
      count: async ({ where = {} }: any = {}) => state.notifications.filter((row) => matches(row, where)).length
    },
    platformImportJob: {
      count: async ({ where = {} }: any = {}) => state.jobs.filter((row) => matches(row, where)).length
    },
    platformImportItem: {
      count: async ({ where = {} }: any = {}) => state.items.filter((row) => matches(row, where)).length
    },
    platformImportConversion: {
      count: async ({ where = {} }: any = {}) => state.conversions.filter((row) => matches(row, where)).length
    }
  };
  return { client: client as any, state };
}

describe("Phase 30 beta notification audit", () => {
  it("dedupes import and conversion issue notifications without unsafe metadata", async () => {
    const { client, state } = createFakeClient();
    const input = {
      type: "IMPORT_ITEM_FAILED" as const,
      severity: "ERROR" as const,
      title: "Import failed",
      message: "Review the imported order before retrying.",
      actionLabel: "Review",
      actionUrl: "/seller/developer",
      sourceType: "PLATFORM_IMPORT_ITEM" as const,
      sourceId: "item_1",
      sourceMeta: {
        rawPayload: { accessToken: "shpat_secret", buyerPhone: "9876543210" },
        rawHeaders: { Authorization: "Bearer secret" },
        providerName: "Bigship",
        safe_item_count: 1
      },
      dedupeKey: "beta:item_1"
    };

    const first = await createMerchantNotification("merchant_1", input, client);
    const second = await createMerchantNotification("merchant_1", input, client);
    await notifyImportJobFailed({
      id: "job_1",
      merchantId: "merchant_1",
      platform: "SHOPIFY",
      status: PlatformImportJobStatus.FAILED,
      failedItems: 1,
      totalItems: 2,
      warningCount: 1
    }, client);
    await notifyConversionResult("merchant_1", {
      itemId: "item_2",
      status: "BLOCKED",
      reasonCodes: ["ITEM_FAILED"],
      warnings: ["Review required"]
    }, client);

    const json = JSON.stringify(state.notifications);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(state.notifications.length, 3);
    assert.doesNotMatch(json, /rawPayload|rawHeaders|Authorization|Bearer|shpat_secret|9876543210|providerName|Bigship/i);
  });

  it("keeps beta notification preferences and digest in-app only", async () => {
    const { client, state } = createFakeClient();
    state.jobs.push({ merchantId: "merchant_1", status: PlatformImportJobStatus.FAILED });
    state.items.push({ merchantId: "merchant_1", status: "FAILED" });
    state.conversions.push({ merchantId: "merchant_1", status: "NEEDS_ATTENTION" });

    const preferences = await getMerchantNotificationPreferences("merchant_1", client);
    await generateImportDigestNotification("merchant_1", client);
    const digest = state.notifications.find((row) => row.type === "IMPORT_DIGEST");

    assert.equal(preferences.email_enabled, false);
    assert.equal(digest?.sourceMeta.email_sent, false);
    assert.doesNotMatch(JSON.stringify(digest), /sendMail|nodemailer|smtp|rawPayload|rawHeaders|secret|token|Bigship/i);
  });

  it("does not add email sending, workers, platform writes, or shipping actions to notifications", () => {
    const source = readFileSync("src/modules/merchantNotifications/merchant-notification.service.ts", "utf8");
    assert.doesNotMatch(source, /sendMail|nodemailer|smtp|createLabel|getLabel|manifestOrder|getRates|webhook registration|setInterval|cron/i);
  });
});
