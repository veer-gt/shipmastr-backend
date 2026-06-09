import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../../lib/httpError.js";
import {
  getEmailDeliveryReadiness,
  listEmailDeliveryAttempts,
  sendMerchantNotificationEmailSandbox,
  testSandboxEmailDelivery
} from "../email-delivery.service.js";

type PreferenceRow = {
  merchantId: string;
  emailEnabled: boolean;
};

type NotificationRow = {
  id: string;
  merchantId: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

type AttemptRow = {
  id: string;
  merchantId: string | null;
  notificationId: string | null;
  recipientSafe: string | null;
  provider: string;
  mode: string;
  status: string;
  subject: string | null;
  safeMeta: unknown;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function now() {
  return new Date("2026-06-08T15:00:00.000Z");
}

const enabledSource = {
  SHIPMASTR_EMAIL_ENABLED: "true",
  SHIPMASTR_EMAIL_MODE: "SANDBOX",
  SHIPMASTR_EMAIL_PROVIDER: "LOCAL_LOG",
  SHIPMASTR_EMAIL_PILOT_ONLY: "true",
  SHIPMASTR_EMAIL_LIVE_SEND: "false",
  MERCHANT_EMAIL_LIVE_SEND: "false"
};

function createFakeClient() {
  const state = {
    preferences: [] as PreferenceRow[],
    notifications: [] as NotificationRow[],
    attempts: [] as AttemptRow[],
    pilotMerchants: [] as Array<{ merchantId: string; status: string }>,
    pilotCapabilities: [] as Array<{ merchantId: string; capability: string; status: string }>,
    auditLogs: [] as Array<{ merchantId: string | null; action: string; safeMeta: unknown }>
  };

  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([key, value]) => (
    row[key] === value
  ));

  const client = {
    merchantNotificationPreference: {
      findUnique: async ({ where }: any) => state.preferences.find((row) => row.merchantId === where.merchantId) ?? null
    },
    merchantNotification: {
      findFirst: async ({ where }: any) => state.notifications.find((row) => matches(row as any, where)) ?? null
    },
    livePilotMerchant: {
      findUnique: async ({ where }: any) => state.pilotMerchants.find((row) => row.merchantId === where.merchantId) ?? null
    },
    livePilotCapability: {
      findMany: async ({ where = {} }: any = {}) => state.pilotCapabilities.filter((row) => matches(row as any, where))
    },
    livePilotAuditLog: {
      create: async ({ data }: any) => {
        state.auditLogs.push({
          merchantId: data.merchantId ?? null,
          action: data.action,
          safeMeta: data.safeMeta ?? null
        });
        return { id: `audit_${state.auditLogs.length}`, ...data, createdAt: now() };
      }
    },
    emailDeliveryAttempt: {
      create: async ({ data }: any) => {
        const row: AttemptRow = {
          id: `attempt_${state.attempts.length + 1}`,
          merchantId: data.merchantId ?? null,
          notificationId: data.notificationId ?? null,
          recipientSafe: data.recipientSafe ?? null,
          provider: data.provider,
          mode: data.mode,
          status: data.status,
          subject: data.subject ?? null,
          safeMeta: data.safeMeta ?? null,
          sentAt: data.sentAt ?? null,
          createdAt: now(),
          updatedAt: now()
        };
        state.attempts.push(row);
        return row;
      },
      findMany: async ({ where = {}, skip = 0, take = 20, orderBy }: any = {}) => {
        const rows = state.attempts.filter((row) => matches(row as any, where));
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows.slice(skip, skip + take);
      },
      count: async ({ where = {} }: any = {}) => state.attempts.filter((row) => matches(row as any, where)).length
    }
  };

  return { state, client: client as any };
}

function enablePilot(state: ReturnType<typeof createFakeClient>["state"], merchantId = "merchant_1") {
  state.pilotMerchants.push({ merchantId, status: "ENABLED" });
  state.pilotCapabilities.push({ merchantId, capability: "LIVE_EMAIL_SANDBOX", status: "ENABLED" });
  state.preferences.push({ merchantId, emailEnabled: true });
}

describe("pilot email delivery sandbox", () => {
  it("is disabled by default and records no successful email send", async () => {
    const { client } = createFakeClient();
    const readiness = await getEmailDeliveryReadiness("merchant_1", {}, client);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.status, "DISABLED");
    assert.match(JSON.stringify(readiness.blockers), /EMAIL_DELIVERY_DISABLED/);
  });

  it("blocks sandbox send when merchant is not allowlisted", async () => {
    const { state, client } = createFakeClient();
    state.preferences.push({ merchantId: "merchant_1", emailEnabled: true });

    await assert.rejects(
      () => testSandboxEmailDelivery("merchant_1", { recipient_email: "merchant@example.com" }, enabledSource, client),
      (error) => error instanceof HttpError && error.message === "EMAIL_PILOT_MERCHANT_REQUIRED"
    );
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0]?.status, "BLOCKED");
    assert.equal(state.attempts[0]?.recipientSafe, "m***@e***.com");
  });

  it("blocks sandbox send without LIVE_EMAIL_SANDBOX capability", async () => {
    const { state, client } = createFakeClient();
    state.pilotMerchants.push({ merchantId: "merchant_1", status: "ENABLED" });
    state.preferences.push({ merchantId: "merchant_1", emailEnabled: true });

    await assert.rejects(
      () => testSandboxEmailDelivery("merchant_1", {}, enabledSource, client),
      (error) => error instanceof HttpError && error.message === "LIVE_EMAIL_SANDBOX_CAPABILITY_REQUIRED"
    );
    assert.equal(state.attempts[0]?.status, "BLOCKED");
  });

  it("requires explicit notification email preference", async () => {
    const { state, client } = createFakeClient();
    state.pilotMerchants.push({ merchantId: "merchant_1", status: "ENABLED" });
    state.pilotCapabilities.push({ merchantId: "merchant_1", capability: "LIVE_EMAIL_SANDBOX", status: "ENABLED" });

    await assert.rejects(
      () => testSandboxEmailDelivery("merchant_1", {}, enabledSource, client),
      (error) => error instanceof HttpError && error.message === "EMAIL_PREFERENCE_DISABLED"
    );
  });

  it("records sandbox attempt only for allowlisted pilot merchant", async () => {
    const { state, client } = createFakeClient();
    enablePilot(state);

    const result = await testSandboxEmailDelivery("merchant_1", {
      recipient_email: "merchant@example.com",
      subject: "Pilot sandbox"
    }, enabledSource, client);

    assert.equal(result.attempt.status, "SANDBOX_RECORDED");
    assert.equal(result.attempt.recipient_safe, "m***@e***.com");
    assert.equal((result.attempt.safe_meta as { sandbox?: boolean })?.sandbox, true);
    assert.equal(state.auditLogs[0]?.action, "EMAIL_DELIVERY_SANDBOX_RECORDED");
    assert.doesNotMatch(JSON.stringify(result), /merchant@example.com|smtp-super-secret|sendMail|nodemailer/i);
  });

  it("sends merchant notification sandbox email without exposing unsafe values", async () => {
    const { state, client } = createFakeClient();
    enablePilot(state);
    state.notifications.push({
      id: "notif_1",
      merchantId: "merchant_1",
      type: "IMPORT_ITEM_FAILED",
      severity: "ERROR",
      title: "Import failed",
      message: "Review imported order.",
      status: "UNREAD",
      createdAt: now(),
      updatedAt: now()
    });

    const result = await sendMerchantNotificationEmailSandbox("merchant_1", "notif_1", {
      actorEmail: "owner@example.com"
    }, enabledSource, client);

    assert.equal(result.attempt.notification_id, "notif_1");
    assert.equal(result.attempt.recipient_safe, "o***@e***.com");
    assert.doesNotMatch(JSON.stringify(result), /owner@example.com|rawPayload|rawHeaders|credentialHash|secretHash|Bigship|providerName/i);
  });

  it("lists attempts by merchant scope and safe status", async () => {
    const { state, client } = createFakeClient();
    enablePilot(state);
    await testSandboxEmailDelivery("merchant_1", {}, enabledSource, client);
    state.attempts.push({
      id: "attempt_other",
      merchantId: "merchant_2",
      notificationId: null,
      recipientSafe: "x***@e***.com",
      provider: "LOCAL_LOG",
      mode: "SANDBOX",
      status: "SANDBOX_RECORDED",
      subject: "Other",
      safeMeta: {},
      sentAt: now(),
      createdAt: now(),
      updatedAt: now()
    });

    const list = await listEmailDeliveryAttempts("merchant_1", { page: 1, per_page: 20 }, client);
    assert.equal(list.attempts.length, 1);
    assert.equal(list.pagination.total, 1);
  });

  it("does not send real email, create shipping records, register webhooks, or call providers", () => {
    const service = readFileSync("src/modules/emailDelivery/email-delivery.service.ts", "utf8");
    const sandbox = readFileSync("src/modules/emailDelivery/email-delivery.sandbox.ts", "utf8");
    const combined = `${service}\n${sandbox}`;
    assert.doesNotMatch(combined, /sendMail|nodemailer|smtp\.send|createLabel|getLabel|manifestOrder|getRates|webhook registration|setInterval|cron|fetch\(|axios/i);
  });
});
