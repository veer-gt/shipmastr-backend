import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createCourierAuditLead,
  makeN8nCourierAuditNotifier,
  sanitizedCourierAuditNotificationPayload
} from "./courier-audit.service.js";

const now = new Date("2026-07-03T05:30:00.000Z");

function makeCourierAuditLeadClient() {
  const state = {
    leads: [] as any[],
    updates: [] as any[]
  };

  const client = {
    courierAuditLead: {
      create: async ({ data }: any) => {
        const lead = {
          id: `cal_${state.leads.length + 1}`,
          createdAt: now,
          updatedAt: now,
          n8nNotifiedAt: null,
          n8nNotificationStatus: null,
          notes: null,
          ...data
        };
        state.leads.push(lead);
        return lead;
      },
      update: async ({ where, data }: any) => {
        const lead = state.leads.find((record) => record.id === where.id);
        if (!lead) throw new Error("LEAD_NOT_FOUND");
        Object.assign(lead, data, { updatedAt: now });
        state.updates.push({ where, data });
        return lead;
      }
    }
  };

  return { client: client as any, state };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    brand: " Skymax ",
    name: " Veer ",
    email: " Founder@Example.COM ",
    whatsapp: " +919999999999 ",
    monthlyShipments: 1500,
    currentAggregator: " Shiprocket ",
    estimatedLeak: 90000,
    bumpRate: 10,
    averageOvercharge: 60,
    utmSource: "pricing",
    landingPath: "/courier-audit/",
    referrer: "https://shipmastr.com/",
    ...overrides
  } as any;
}

describe("courier audit leads", () => {
  it("stores a valid lead and sends a sanitized n8n notification", async () => {
    const { client, state } = makeCourierAuditLeadClient();
    const notifications: any[] = [];
    const result = await createCourierAuditLead(validInput(), client, async (lead) => {
      notifications.push(sanitizedCourierAuditNotificationPayload(lead));
    });

    assert.deepEqual(result, { ok: true, stored: true, id: "cal_1" });
    assert.equal(state.leads.length, 1);
    assert.equal(state.leads[0]?.brand, "Skymax");
    assert.equal(state.leads[0]?.name, "Veer");
    assert.equal(state.leads[0]?.email, "founder@example.com");
    assert.equal(state.leads[0]?.monthlyShipments, 1500);
    assert.equal(state.leads[0]?.source, "courier-audit");
    assert.equal(state.leads[0]?.status, "new");
    assert.equal(state.leads[0]?.n8nNotificationStatus, "sent");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.event, "courier_audit_lead.created");
    assert.equal(notifications[0]?.lead.email, "founder@example.com");
    assert.equal(notifications[0]?.lead.monthlyShipments, 1500);
  });

  it("returns ok for honeypot submissions without storing or notifying", async () => {
    const { client, state } = makeCourierAuditLeadClient();
    let notified = false;
    const result = await createCourierAuditLead(validInput({ website: "bot.example" }), client, async () => {
      notified = true;
    });

    assert.deepEqual(result, { ok: true, stored: false, honeypot: true });
    assert.equal(state.leads.length, 0);
    assert.equal(notified, false);
  });

  it("keeps the lead stored when n8n notification fails", async () => {
    const { client, state } = makeCourierAuditLeadClient();
    const result = await createCourierAuditLead(validInput(), client, async () => {
      throw new Error("simulated n8n failure");
    });

    assert.deepEqual(result, { ok: true, stored: true, id: "cal_1" });
    assert.equal(state.leads.length, 1);
    assert.equal(state.leads[0]?.n8nNotificationStatus, "failed");
    assert.equal(state.updates[0]?.data.n8nNotificationStatus, "failed");
  });

  it("marks missing n8n webhook config without pretending notification was sent", async () => {
    const { client, state } = makeCourierAuditLeadClient();
    const result = await createCourierAuditLead(
      validInput(),
      client,
      makeN8nCourierAuditNotifier("")
    );

    assert.deepEqual(result, { ok: true, stored: true, id: "cal_1" });
    assert.equal(state.leads.length, 1);
    assert.equal(state.leads[0]?.n8nNotificationStatus, "not_configured");
    assert.equal(state.leads[0]?.n8nNotifiedAt, null);
    assert.equal(state.updates[0]?.data.n8nNotificationStatus, "not_configured");
    assert.equal("n8nNotifiedAt" in state.updates[0]?.data, false);
  });
});
