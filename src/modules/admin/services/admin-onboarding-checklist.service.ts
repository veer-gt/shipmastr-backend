import type { Prisma } from "@prisma/client";
import { AdminOnboardingChecklistItemStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const FIRST_SELLER_ONBOARDING_KEY = "first-seller-onboarding";
export const FIRST_SELLER_ONBOARDING_TITLE = "First Seller Onboarding";

export const firstSellerOnboardingTemplate = [
  {
    itemKey: "lead-review",
    title: "Lead review",
    prompt: "Verify request-demo details, filter spam, and capture shipment volume, COD share, city, urgency, provider, and blocker."
  },
  {
    itemKey: "qualification-call",
    title: "Qualification call",
    prompt: "Confirm monthly shipments, COD percentage, pickup pincode, top delivery zones, average weight, and biggest ops pain."
  },
  {
    itemKey: "seller-account-creation",
    title: "Seller account creation",
    prompt: "Convert the qualified lead to seller, then verify the seller detail page, source lead, users, and onboarding state."
  },
  {
    itemKey: "invite-reset-password",
    title: "Invite/reset password setup",
    prompt: "Create the invite link, send through the approved channel, and confirm the seller can set a password and log in."
  },
  {
    itemKey: "seller-onboarding",
    title: "Seller onboarding",
    prompt: "Track company profile, pickup address, bank/COD details, KYC documents, and first shipment request progress."
  },
  {
    itemKey: "courier-preference",
    title: "Courier preference capture",
    prompt: "Record preferred courier, backup courier, pickup window, lanes, packaging constraints, and service expectations."
  },
  {
    itemKey: "pickup-address",
    title: "Pickup address verification",
    prompt: "Confirm contact, phone, full pickup address, pincode, landmark, working hours, and pickup feasibility."
  },
  {
    itemKey: "first-test-shipment",
    title: "First test shipment",
    prompt: "Review first shipment request details, then move it through NEW, REVIEWING, READY_TO_BOOK, BOOKED_MANUALLY, AWB_ADDED, PICKED_UP, IN_TRANSIT, DELIVERED, NDR, RTO, or CANCELLED."
  },
  {
    itemKey: "cod-remittance",
    title: "COD/remittance notes",
    prompt: "Capture expected COD amount, courier used, settlement expectations, and finance/dispute notes without unsupported promises."
  },
  {
    itemKey: "manual-courier-coordination",
    title: "Manual courier coordination",
    prompt: "Record courier assignment, AWB if available, pickup reference, promised pickup time, and coordination owner."
  },
  {
    itemKey: "support-escalation",
    title: "Support escalation",
    prompt: "Escalate access issues, KYC ambiguity, unserviceable pickup, time-sensitive shipment, COD dispute, or pickup failure."
  }
].map((item, index) => ({ ...item, position: index + 1 }));

export type AdminChecklistPatchInput = {
  status?: AdminOnboardingChecklistItemStatus;
  owner?: string | null;
  notes?: string | null;
  dueDate?: Date | null;
  blockerReason?: string | null;
  completedAt?: Date | null;
};

const sensitivePatterns = [
  /\b(api[_\s-]?key|password|passwd|pwd|token|secret|credential|smtp_pass|bearer)\b\s*[:=]\s*[^\s,;]+/gi,
  /\b(bearer)\s+[a-z0-9._~+/=-]+/gi,
  /\b(sk|pk)_[a-z0-9_]{12,}/gi
];

const sensitiveWords = /\b(api[_\s-]?key|password|passwd|pwd|token|secret|credential|smtp_pass|bearer)\b/gi;

export function sanitizeAdminChecklistText(value?: string | null) {
  if (value === undefined) return { value: undefined, redacted: false };
  if (value === null) return { value: null, redacted: false };

  let redacted = false;
  let next = value.trim();

  for (const pattern of sensitivePatterns) {
    next = next.replace(pattern, () => {
      redacted = true;
      return "[redacted]";
    });
  }

  next = next.replace(sensitiveWords, () => {
    redacted = true;
    return "[redacted]";
  });

  return {
    value: next || null,
    redacted
  };
}

function serializeItem(item: {
  id: string;
  checklistId: string;
  itemKey: string;
  title: string;
  prompt: string;
  position: number;
  status: AdminOnboardingChecklistItemStatus;
  owner: string | null;
  notes: string | null;
  dueDate: Date | null;
  blockerReason: string | null;
  completedAt: Date | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: item.id,
    checklistId: item.checklistId,
    itemKey: item.itemKey,
    title: item.title,
    prompt: item.prompt,
    position: item.position,
    status: item.status,
    owner: item.owner,
    notes: item.notes,
    dueDate: item.dueDate,
    blockerReason: item.blockerReason,
    completedAt: item.completedAt,
    updatedBy: item.updatedBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function pickAuditValues(item: ReturnType<typeof serializeItem>) {
  return {
    status: item.status,
    owner: item.owner,
    notes: item.notes,
    dueDate: item.dueDate,
    blockerReason: item.blockerReason,
    completedAt: item.completedAt,
    updatedBy: item.updatedBy
  };
}

async function createChecklist(actorId: string, client: Db) {
  const checklist = await client.adminOnboardingChecklist.create({
    data: {
      key: FIRST_SELLER_ONBOARDING_KEY,
      title: FIRST_SELLER_ONBOARDING_TITLE,
      items: {
        create: firstSellerOnboardingTemplate.map((item) => ({
          itemKey: item.itemKey,
          title: item.title,
          prompt: item.prompt,
          position: item.position
        }))
      }
    },
    include: { items: true }
  });

  await client.adminOnboardingChecklistAudit.create({
    data: {
      checklistId: checklist.id,
      actorId,
      action: "ADMIN_ONBOARDING_CHECKLIST_INITIALIZED",
      newValues: {
        key: checklist.key,
        itemCount: checklist.items.length
      }
    }
  });

  await client.auditLog.create({
    data: {
      actorId,
      action: "ADMIN_ONBOARDING_CHECKLIST_INITIALIZED",
      entityType: "admin_onboarding_checklist",
      entityId: checklist.id,
      metadata: {
        key: checklist.key,
        itemCount: checklist.items.length
      }
    }
  });

  return checklist;
}

async function ensureTemplateItems(checklistId: string, client: Db) {
  const existing = await client.adminOnboardingChecklistItem.findMany({
    where: { checklistId }
  });
  const existingKeys = new Set(existing.map((item) => item.itemKey));

  const missing = firstSellerOnboardingTemplate.filter((item) => !existingKeys.has(item.itemKey));
  if (missing.length) {
    await client.adminOnboardingChecklistItem.createMany({
      data: missing.map((item) => ({
        checklistId,
        itemKey: item.itemKey,
        title: item.title,
        prompt: item.prompt,
        position: item.position
      }))
    });
  }

  await Promise.all(firstSellerOnboardingTemplate
    .filter((item) => existingKeys.has(item.itemKey))
    .map((item) => client.adminOnboardingChecklistItem.update({
      where: { checklistId_itemKey: { checklistId, itemKey: item.itemKey } },
      data: {
        title: item.title,
        prompt: item.prompt,
        position: item.position
      }
    })));
}

function hasTransaction(client: Db): client is typeof prisma {
  return "$transaction" in client && typeof client.$transaction === "function";
}

async function getOrInitAdminOnboardingChecklistInClient(actorId: string, client: Db) {
  const existing = await client.adminOnboardingChecklist.findUnique({
    where: { key: FIRST_SELLER_ONBOARDING_KEY }
  });

  const checklist = existing ?? await createChecklist(actorId, client);
  await ensureTemplateItems(checklist.id, client);

  const result = await client.adminOnboardingChecklist.findUniqueOrThrow({
    where: { id: checklist.id },
    include: {
      items: {
        orderBy: { position: "asc" }
      }
    }
  });

  return {
    checklist: {
      id: result.id,
      key: result.key,
      title: result.title,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      items: result.items.map(serializeItem)
    }
  };
}

export async function getOrInitAdminOnboardingChecklist(actorId: string, client: Db = prisma) {
  if (hasTransaction(client)) {
    return client.$transaction((tx) => getOrInitAdminOnboardingChecklistInClient(actorId, tx));
  }

  return getOrInitAdminOnboardingChecklistInClient(actorId, client);
}

export async function patchAdminOnboardingChecklistItem(input: {
  actorId: string;
  itemKey: string;
  patch: AdminChecklistPatchInput;
}, client: Db = prisma) {
  const redactions: string[] = [];

  const run = async (tx: Db) => {
    const { checklist } = await getOrInitAdminOnboardingChecklistInClient(input.actorId, tx);
    const existing = await tx.adminOnboardingChecklistItem.findUnique({
      where: {
        checklistId_itemKey: {
          checklistId: checklist.id,
          itemKey: input.itemKey
        }
      }
    });

    if (!existing) return null;

    const existingSerialized = serializeItem(existing);
    const data: Prisma.AdminOnboardingChecklistItemUncheckedUpdateInput = {
      updatedBy: input.actorId
    };

    if (input.patch.status !== undefined) {
      data.status = input.patch.status;
      if (input.patch.status === AdminOnboardingChecklistItemStatus.DONE && existing.status !== AdminOnboardingChecklistItemStatus.DONE) {
        data.completedAt = input.patch.completedAt ?? new Date();
      } else if (input.patch.status !== AdminOnboardingChecklistItemStatus.DONE) {
        data.completedAt = input.patch.completedAt ?? null;
      }
    }

    if (input.patch.owner !== undefined) data.owner = input.patch.owner?.trim() || null;
    if (input.patch.dueDate !== undefined) data.dueDate = input.patch.dueDate;
    if (input.patch.completedAt !== undefined && input.patch.status === undefined) data.completedAt = input.patch.completedAt;

    if (input.patch.notes !== undefined) {
      const sanitized = sanitizeAdminChecklistText(input.patch.notes);
      data.notes = sanitized.value ?? null;
      if (sanitized.redacted) redactions.push("notes");
    }

    if (input.patch.blockerReason !== undefined) {
      const sanitized = sanitizeAdminChecklistText(input.patch.blockerReason);
      data.blockerReason = sanitized.value ?? null;
      if (sanitized.redacted) redactions.push("blockerReason");
    }

    const updated = await tx.adminOnboardingChecklistItem.update({
      where: { id: existing.id },
      data
    });
    const updatedSerialized = serializeItem(updated);

    await tx.adminOnboardingChecklistAudit.create({
      data: {
        checklistId: checklist.id,
        itemId: updated.id,
        itemKey: updated.itemKey,
        actorId: input.actorId,
        action: "ADMIN_ONBOARDING_CHECKLIST_ITEM_UPDATED",
        oldValues: pickAuditValues(existingSerialized),
        newValues: {
          ...pickAuditValues(updatedSerialized),
          redactions
        }
      }
    });

    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "ADMIN_ONBOARDING_CHECKLIST_ITEM_UPDATED",
        entityType: "admin_onboarding_checklist_item",
        entityId: updated.id,
        metadata: {
          checklistId: checklist.id,
          itemKey: updated.itemKey,
          oldValues: pickAuditValues(existingSerialized),
          newValues: {
            ...pickAuditValues(updatedSerialized),
            redactions
          }
        }
      }
    });

    return updatedSerialized;
  };

  const result = hasTransaction(client)
    ? await client.$transaction((tx) => run(tx))
    : await run(client);

  return result ? { item: result, redactions } : null;
}

export async function getAdminOnboardingChecklistAudit(client: Db = prisma) {
  const checklist = await client.adminOnboardingChecklist.findUnique({
    where: { key: FIRST_SELLER_ONBOARDING_KEY }
  });

  if (!checklist) {
    return { audit: [] };
  }

  const audit = await client.adminOnboardingChecklistAudit.findMany({
    where: { checklistId: checklist.id },
    orderBy: { createdAt: "desc" },
    take: 100
  });

  return { audit };
}
