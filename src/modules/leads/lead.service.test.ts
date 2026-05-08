import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LeadStatus } from "@prisma/client";
import { convertLeadToSeller, createLead, listLeads, updateLead } from "./lead.service.js";

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
    assert.equal(first?.user.role, "OWNER");
    assert.equal(first?.user.userType, "EXTERNAL_MERCHANT");
    assert.equal((first?.user as any).passwordHash, undefined);
    assert.equal(second?.reusedMerchant, true);
    assert.equal(second?.reusedUser, true);
    assert.equal(state.merchants.length, 1);
    assert.equal(state.users.length, 1);
    assert.equal(state.auditLogs.at(-1)?.action, "LEAD_CONVERTED_TO_SELLER");
  });
});
