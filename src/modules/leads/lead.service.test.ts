import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LeadStatus } from "@prisma/client";
import {
  convertLeadToSeller,
  createLead,
  listLeads,
  updateLead
} from "./lead.service.js";
import {
  processLeadNotificationTask,
  sendLeadSubmittedNotification
} from "../tasks/email-task.service.js";

const now = new Date("2026-05-08T09:30:00.000Z");

function makeLeadClient() {
  const state = {
    leads: [] as any[],
    merchants: [] as any[],
    users: [] as any[],
    auditLogs: [] as any[]
  };

  const client = {
    $transaction: async (callback: any) => callback(client),
    lead: {
      create: async ({ data }: any) => {
        const lead = {
          id: `lead_${state.leads.length + 1}`,
          status: LeadStatus.NEW,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.leads.push(lead);
        return lead;
      },
      findMany: async ({ where, orderBy }: any = {}) => {
        let leads = [...state.leads];
        if (where?.status) leads = leads.filter((lead) => lead.status === where.status);
        if (orderBy?.createdAt === "desc") {
          leads.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return leads;
      },
      findUnique: async ({ where }: any) => state.leads.find((lead) => lead.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const lead = state.leads.find((item) => item.id === where.id);
        if (!lead) throw new Error("LEAD_NOT_FOUND");
        Object.assign(lead, data, { updatedAt: now });
        return lead;
      }
    },
    merchant: {
      findUnique: async ({ where }: any) => {
        if (where.id) return state.merchants.find((merchant) => merchant.id === where.id) ?? null;
        if (where.email) return state.merchants.find((merchant) => merchant.email === where.email) ?? null;
        return null;
      },
      create: async ({ data }: any) => {
        const merchant = {
          id: `merchant_${state.merchants.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.merchants.push(merchant);
        return merchant;
      }
    },
    user: {
      findUnique: async ({ where }: any) => {
        if (where.email) return state.users.find((user) => user.email === where.email) ?? null;
        if (where.id) return state.users.find((user) => user.id === where.id) ?? null;
        return null;
      },
      create: async ({ data }: any) => {
        const user = {
          id: `user_${state.users.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...data
        };
        state.users.push(user);
        return user;
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead_1",
    name: "Founder",
    businessName: "Skymax Store",
    phone: "9876543210",
    email: "founder@example.com",
    merchantId: null,
    monthlyShipments: "500-1000",
    currentProvider: null,
    biggestIssue: "COD reconciliation",
    notes: "Wants early access",
    status: LeadStatus.NEW,
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as any;
}

function makeLogSink() {
  const events: string[] = [];
  const payloads: any[] = [];
  const log = {
    info: (_payload: unknown, message: string) => {
      payloads.push(_payload);
      events.push(message);
    },
    warn: (_payload: unknown, message: string) => {
      payloads.push(_payload);
      events.push(message);
    }
  };

  return { events, payloads, log };
}

async function withEmailEnv<T>(values: NodeJS.ProcessEnv, callback: () => T | Promise<T>): Promise<T> {
  const keys = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASS",
    "EMAIL_FROM",
    "EMAIL_FROM_NAME",
    "SMTP_REPLY_TO",
    "ADMIN_EMAIL"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    for (const key of keys) {
      delete process.env[key];
    }
    Object.assign(process.env, values);
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("leads", () => {
  it("creates a normalized seller lead", async () => {
    const { client, state } = makeLeadClient();
    const result = await createLead({
      name: "  Veer  ",
      businessName: "  Skymax Store  ",
      phone: " 9876543210 ",
      email: " VEER@EXAMPLE.COM ",
      monthlyShipments: " 500-1000 ",
      currentProvider: "",
      biggestIssue: " COD reconciliation ",
      notes: " Wants early access "
    }, client);

    assert.deepEqual(result, { ok: true, leadId: "lead_1" });
    assert.equal(state.leads[0]?.email, "veer@example.com");
    assert.equal(state.leads[0]?.businessName, "Skymax Store");
    assert.equal(state.leads[0]?.currentProvider, null);
    assert.equal(state.leads[0]?.status, LeadStatus.NEW);
  });

  it("enqueues a lead notification task after creating a lead", async () => {
    const { client } = makeLeadClient();
    const { events, payloads, log } = makeLogSink();
    const enqueued: string[] = [];

    const result = await createLead({
      name: "Founder",
      businessName: "Notify Store",
      phone: "9876543210",
      email: "founder@example.com"
    }, client, {
      enqueueLeadNotification: async (leadId) => {
        enqueued.push(leadId);
        return { status: "created" };
      },
      log
    });

    assert.deepEqual(result, { ok: true, leadId: "lead_1" });
    assert.deepEqual(enqueued, ["lead_1"]);
    assert.deepEqual(events, [
      "lead_created",
      "lead_email_task_enqueue_attempted",
      "lead_email_task_enqueued"
    ]);
    assert.deepEqual(payloads[0]?.leadNotification, { leadId: "lead_1" });
    assert.deepEqual(payloads[1]?.leadNotification, { leadId: "lead_1" });
    assert.deepEqual(payloads[2]?.leadNotification, {
      leadId: "lead_1",
      status: "enqueued",
      taskStatus: "created"
    });
  });

  it("does not call SMTP email helpers while creating a lead", async () => {
    const { client } = makeLeadClient();
    const { events, log } = makeLogSink();
    const enqueued: string[] = [];

    const result = await withEmailEnv({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "noreply@shipmastr.com",
      SMTP_PASS: "configured-secret",
      EMAIL_FROM: "noreply@shipmastr.com",
      EMAIL_FROM_NAME: "Shipmastr",
      SMTP_REPLY_TO: "no-reply@shipmastr.com",
      ADMIN_EMAIL: "admin@example.com"
    }, () => createLead({
        name: "Founder",
        businessName: "Queue Only Store",
        phone: "9876543210",
        email: "queue-only@example.com"
      }, client, {
        enqueueLeadNotification: async (leadId) => {
          enqueued.push(leadId);
          return { status: "created" };
        },
        log
      })
    );

    assert.deepEqual(result, { ok: true, leadId: "lead_1" });
    assert.deepEqual(enqueued, ["lead_1"]);
    assert.deepEqual(events, [
      "lead_created",
      "lead_email_task_enqueue_attempted",
      "lead_email_task_enqueued"
    ]);
  });

  it("returns the created lead when task enqueue fails", async () => {
    const { client, state } = makeLeadClient();
    const { events, payloads, log } = makeLogSink();

    const result = await createLead({
      name: "Founder",
      businessName: "Soft Fail Store",
      phone: "9876543210",
      email: "softfail@example.com"
    }, client, {
      enqueueLeadNotification: async () => {
        throw new Error("CLOUD_TASKS_ENQUEUE_FAILED");
      },
      log
    });

    assert.deepEqual(result, { ok: true, leadId: "lead_1" });
    assert.equal(state.leads.length, 1);
    assert.equal(state.leads[0]?.email, "softfail@example.com");
    assert.deepEqual(events, [
      "lead_created",
      "lead_email_task_enqueue_attempted",
      "lead_email_task_enqueue_failed"
    ]);
    assert.deepEqual(payloads[2]?.leadNotification, {
      leadId: "lead_1",
      status: "enqueue_failed",
      error: "CLOUD_TASKS_ENQUEUE_FAILED"
    });
  });

  it("createLead calls the enqueue function only", async () => {
    const { client } = makeLeadClient();
    const enqueued: string[] = [];

    const result = await createLead({
      name: "Founder",
      businessName: "Enqueue Only Store",
      phone: "9876543210",
      email: "enqueue-only@example.com"
    }, client, {
      enqueueLeadNotification: async (leadId) => {
        enqueued.push(leadId);
        return { status: "created" };
      }
    });

    assert.deepEqual(result, { ok: true, leadId: "lead_1" });
    assert.deepEqual(enqueued, ["lead_1"]);
  });

  it("calls admin email when SMTP config exists", async () => {
    const { events, payloads, log } = makeLogSink();
    let sentInput: any = null;

    const result = await withEmailEnv({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "noreply@shipmastr.com",
      SMTP_PASS: "configured-secret",
      EMAIL_FROM: "noreply@shipmastr.com",
      EMAIL_FROM_NAME: "Shipmastr",
      SMTP_REPLY_TO: "no-reply@shipmastr.com",
      ADMIN_EMAIL: "admin@example.com"
    }, () => sendLeadSubmittedNotification(makeLead(), {
        sendEmail: async (input) => {
          sentInput = input;
          return {} as any;
        },
        log
      })
    );

    assert.deepEqual(result, { status: "sent" });
    assert.equal(sentInput.to, "admin@example.com");
    assert.equal(sentInput.type, "lead-submitted");
    assert.equal(sentInput.metadata.leadId, "lead_1");
    assert.match(sentInput.text, /Skymax Store/);
    assert.match(sentInput.text, /Wants early access/);
    assert.deepEqual(events, [
      "lead_notification_email_attempted",
      "lead_notification_email_sent"
    ]);
    assert.deepEqual(payloads[0]?.leadNotification, {
      leadId: "lead_1",
      emailConfigured: true,
      smtpHostConfigured: true,
      smtpPortConfigured: true,
      smtpUserConfigured: true,
      smtpPassConfigured: true,
      emailFromConfigured: true,
      adminEmailConfigured: true
    });
  });

  it("skips admin email only when a required SMTP var is missing", async () => {
    const { events, payloads, log } = makeLogSink();
    let sendCalled = false;

    const result = await withEmailEnv({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "noreply@shipmastr.com",
      EMAIL_FROM: "noreply@shipmastr.com",
      EMAIL_FROM_NAME: "Shipmastr",
      SMTP_REPLY_TO: "no-reply@shipmastr.com",
      ADMIN_EMAIL: "admin@example.com"
    }, () => sendLeadSubmittedNotification(makeLead(), {
        sendEmail: async () => {
          sendCalled = true;
          return {} as any;
        },
        log
      })
    );

    assert.deepEqual(result, { status: "skipped" });
    assert.equal(sendCalled, false);
    assert.deepEqual(events, [
      "lead_notification_email_attempted",
      "lead_notification_email_skipped_smtp_not_configured"
    ]);
    assert.deepEqual(payloads[0]?.leadNotification, {
      leadId: "lead_1",
      emailConfigured: false,
      smtpHostConfigured: true,
      smtpPortConfigured: true,
      smtpUserConfigured: true,
      smtpPassConfigured: false,
      emailFromConfigured: true,
      adminEmailConfigured: true
    });
  });

  it("processes a lead notification task and sends the admin email", async () => {
    const { client } = makeLeadClient();
    const { log } = makeLogSink();
    let sentInput: any = null;

    await createLead({
      name: "Founder",
      businessName: "Task Store",
      phone: "9876543210",
      email: "task@example.com",
      notes: "Needs callback"
    }, client, {
      enqueueLeadNotification: async () => {}
    });

    const result = await withEmailEnv({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "noreply@shipmastr.com",
      SMTP_PASS: "configured-secret",
      EMAIL_FROM: "noreply@shipmastr.com",
      EMAIL_FROM_NAME: "Shipmastr",
      SMTP_REPLY_TO: "no-reply@shipmastr.com",
      ADMIN_EMAIL: "admin@example.com"
    }, () => processLeadNotificationTask({ leadId: "lead_1" }, client, {
        sendEmail: async (input) => {
          sentInput = input;
          return {} as any;
        },
        log
      })
    );

    assert.deepEqual(result, { ok: true, status: "sent" });
    assert.equal(sentInput.to, "admin@example.com");
    assert.equal(sentInput.metadata.leadId, "lead_1");
    assert.match(sentInput.text, /Task Store/);
    assert.match(sentInput.text, /Needs callback/);
  });

  it("handles a lead notification task for a missing lead safely", async () => {
    const { client } = makeLeadClient();
    const { events, log } = makeLogSink();

    const result = await processLeadNotificationTask({ leadId: "missing_lead" }, client, { log });

    assert.deepEqual(result, { ok: true, status: "missing_lead" });
    assert.deepEqual(events, ["lead_notification_email_missing_lead"]);
  });

  it("lists leads newest first and filters by status", async () => {
    const { client, state } = makeLeadClient();
    await createLead({ name: "A", businessName: "Alpha", phone: "1", email: "a@example.com" }, client);
    await createLead({ name: "B", businessName: "Beta", phone: "2", email: "b@example.com" }, client);
    state.leads[1].status = LeadStatus.QUALIFIED;
    state.leads[1].createdAt = new Date("2026-05-08T10:00:00.000Z");

    const all = await listLeads({}, client);
    assert.deepEqual(all.leads.map((lead) => lead.email), ["b@example.com", "a@example.com"]);

    const qualified = await listLeads({ status: LeadStatus.QUALIFIED }, client);
    assert.deepEqual(qualified.leads.map((lead) => lead.email), ["b@example.com"]);
  });

  it("updates status and notes with an audit log", async () => {
    const { client, state } = makeLeadClient();
    await createLead({ name: "Lead", businessName: "Store", phone: "1", email: "lead@example.com" }, client);

    const result = await updateLead({
      id: "lead_1",
      actorId: "admin_1",
      patch: {
        status: LeadStatus.CONTACTED,
        notes: " Called founder "
      }
    }, client);

    assert.equal(result?.lead.status, LeadStatus.CONTACTED);
    assert.equal(result?.lead.notes, "Called founder");
    assert.equal(state.auditLogs.length, 2);
    assert.equal(state.auditLogs[0]?.action, "ADMIN_LEAD_STATUS_CHANGED");
    assert.deepEqual(state.auditLogs[0]?.metadata, {
      from: LeadStatus.NEW,
      to: LeadStatus.CONTACTED,
      email: "lead@example.com",
      businessName: "Store"
    });
    assert.equal(state.auditLogs[1]?.action, "ADMIN_LEAD_NOTES_UPDATED");
  });

  it("returns null when the lead does not exist", async () => {
    const { client } = makeLeadClient();
    const result = await updateLead({
      id: "missing",
      patch: { status: LeadStatus.LOST }
    }, client);

    assert.equal(result, null);
  });

  it("converts a lead into a seller merchant and user idempotently", async () => {
    const { client, state } = makeLeadClient();
    await createLead({
      name: "Founder",
      businessName: "Skymax Store",
      phone: "9876543210",
      email: "FOUNDER@EXAMPLE.COM"
    }, client);

    const first = await convertLeadToSeller({ id: "lead_1", actorId: "admin_1" }, client);
    const second = await convertLeadToSeller({ id: "lead_1", actorId: "admin_1" }, client);

    assert.equal(first?.lead.status, LeadStatus.CONVERTED);
    assert.equal(first?.lead.merchantId, "merchant_1");
    assert.equal(first?.merchant.email, "founder@example.com");
    assert.equal(first?.user.email, "founder@example.com");
    assert.equal(first?.user.role, "SELLER_OWNER");
    assert.equal(first?.user.userType, "SELLER_ACCOUNT");
    assert.equal((first?.user as any).passwordHash, undefined);
    assert.equal(second?.reusedMerchant, true);
    assert.equal(second?.reusedUser, true);
    assert.equal(state.merchants.length, 1);
    assert.equal(state.users.length, 1);
    assert.equal(state.auditLogs.at(-1)?.action, "LEAD_CONVERTED_TO_SELLER");
  });
});
