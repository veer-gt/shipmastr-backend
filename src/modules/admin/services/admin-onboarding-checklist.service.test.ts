import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdminOnboardingChecklistItemStatus } from "@prisma/client";
import {
  FIRST_SELLER_ONBOARDING_KEY,
  getAdminOnboardingChecklistAudit,
  getOrInitAdminOnboardingChecklist,
  patchAdminOnboardingChecklistItem,
  sanitizeAdminChecklistText
} from "./admin-onboarding-checklist.service.js";

const now = new Date("2026-05-09T10:00:00.000Z");

function orderByPosition(items: any[]) {
  return [...items].sort((left, right) => left.position - right.position);
}

function makeClient() {
  const state = {
    checklists: [] as any[],
    items: [] as any[],
    audits: [] as any[],
    auditLogs: [] as any[]
  };

  const client = {
    adminOnboardingChecklist: {
      findUnique: async ({ where }: any) => state.checklists.find((item) => (
        where.key ? item.key === where.key : item.id === where.id
      )) ?? null,
      findUniqueOrThrow: async ({ where, include }: any) => {
        const checklist = state.checklists.find((item) => item.id === where.id || item.key === where.key);
        if (!checklist) throw new Error("NOT_FOUND");
        return {
          ...checklist,
          items: include?.items ? orderByPosition(state.items.filter((item) => item.checklistId === checklist.id)) : undefined
        };
      },
      create: async ({ data, include }: any) => {
        const checklist = {
          id: `checklist_${state.checklists.length + 1}`,
          key: data.key,
          title: data.title,
          createdAt: now,
          updatedAt: now
        };
        state.checklists.push(checklist);

        const createdItems = (data.items?.create || []).map((item: any) => ({
          id: `item_${state.items.length + 1}`,
          checklistId: checklist.id,
          status: AdminOnboardingChecklistItemStatus.PENDING,
          owner: null,
          notes: null,
          dueDate: null,
          blockerReason: null,
          completedAt: null,
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
          ...item
        }));
        state.items.push(...createdItems);

        return {
          ...checklist,
          items: include?.items ? createdItems : undefined
        };
      }
    },
    adminOnboardingChecklistItem: {
      findMany: async ({ where }: any) => state.items.filter((item) => item.checklistId === where.checklistId),
      createMany: async ({ data }: any) => {
        const rows = data.map((item: any) => ({
          id: `item_${state.items.length + 1}`,
          status: AdminOnboardingChecklistItemStatus.PENDING,
          owner: null,
          notes: null,
          dueDate: null,
          blockerReason: null,
          completedAt: null,
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
          ...item
        }));
        state.items.push(...rows);
        return { count: rows.length };
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return state.items.find((item) => item.id === where.id) ?? null;
        const unique = where.checklistId_itemKey;
        return state.items.find((item) => item.checklistId === unique.checklistId && item.itemKey === unique.itemKey) ?? null;
      },
      update: async ({ where, data }: any) => {
        const unique = where.checklistId_itemKey;
        const item = where.id
          ? state.items.find((row) => row.id === where.id)
          : state.items.find((row) => row.checklistId === unique.checklistId && row.itemKey === unique.itemKey);
        if (!item) throw new Error("ITEM_NOT_FOUND");
        Object.assign(item, data, { updatedAt: now });
        return item;
      }
    },
    adminOnboardingChecklistAudit: {
      create: async ({ data }: any) => {
        const audit = { id: `audit_${state.audits.length + 1}`, createdAt: now, ...data };
        state.audits.push(audit);
        return audit;
      },
      findMany: async ({ where }: any) => state.audits
        .filter((audit) => audit.checklistId === where.checklistId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    },
    auditLog: {
      create: async ({ data }: any) => {
        const log = { id: `audit_log_${state.auditLogs.length + 1}`, createdAt: now, ...data };
        state.auditLogs.push(log);
        return log;
      }
    }
  };

  return { client: client as any, state };
}

describe("admin onboarding checklist", () => {
  it("initializes the first-seller checklist with template items", async () => {
    const { client, state } = makeClient();

    const result = await getOrInitAdminOnboardingChecklist("admin_1", client);

    assert.equal(result.checklist.key, FIRST_SELLER_ONBOARDING_KEY);
    assert.equal(result.checklist.items.length, 11);
    assert.equal(result.checklist.items[0]?.itemKey, "lead-review");
    assert.equal(state.audits[0]?.action, "ADMIN_ONBOARDING_CHECKLIST_INITIALIZED");
    assert.equal(state.auditLogs[0]?.action, "ADMIN_ONBOARDING_CHECKLIST_INITIALIZED");
  });

  it("patches an item, redacts obvious secrets, and writes audit", async () => {
    const { client, state } = makeClient();
    await getOrInitAdminOnboardingChecklist("admin_1", client);

    const result = await patchAdminOnboardingChecklistItem({
      actorId: "admin_1",
      itemKey: "lead-review",
      patch: {
        status: AdminOnboardingChecklistItemStatus.DONE,
        owner: "Ops",
        notes: "Called seller. password=never-store-this. Ready.",
        blockerReason: "api key shared by mistake"
      }
    }, client);

    assert.ok(result);
    assert.equal(result.item.status, AdminOnboardingChecklistItemStatus.DONE);
    assert.equal(result.item.owner, "Ops");
    assert.equal(result.item.updatedBy, "admin_1");
    assert.ok(result.item.completedAt);
    assert.equal(result.item.notes?.includes("never-store-this"), false);
    assert.equal(result.item.blockerReason?.includes("api key"), false);
    assert.deepEqual(result.redactions, ["notes", "blockerReason"]);
    assert.equal(state.audits.at(-1)?.action, "ADMIN_ONBOARDING_CHECKLIST_ITEM_UPDATED");
    assert.equal(state.auditLogs.at(-1)?.action, "ADMIN_ONBOARDING_CHECKLIST_ITEM_UPDATED");
  });

  it("returns audit rows for the checklist", async () => {
    const { client } = makeClient();
    await getOrInitAdminOnboardingChecklist("admin_1", client);
    await patchAdminOnboardingChecklistItem({
      actorId: "admin_1",
      itemKey: "support-escalation",
      patch: { status: AdminOnboardingChecklistItemStatus.BLOCKED, blockerReason: "Pickup city unclear" }
    }, client);

    const result = await getAdminOnboardingChecklistAudit(client);

    assert.equal(result.audit.length, 2);
    assert.equal(result.audit.some((audit) => audit.action === "ADMIN_ONBOARDING_CHECKLIST_ITEM_UPDATED"), true);
  });

  it("sanitizes sensitive note fragments defensively", () => {
    const result = sanitizeAdminChecklistText("token: abc123 and credential shared");

    assert.equal(result.redacted, true);
    assert.equal(result.value?.includes("abc123"), false);
    assert.equal(result.value?.includes("credential"), false);
  });
});
