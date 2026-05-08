import { LeadStatus, type Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const leadStatuses = [
  LeadStatus.NEW,
  LeadStatus.CONTACTED,
  LeadStatus.QUALIFIED,
  LeadStatus.CONVERTED,
  LeadStatus.LOST
] as const;

export type LeadCreateInput = {
  name: string;
  businessName: string;
  phone: string;
  email: string;
  monthlyShipments?: string;
  currentProvider?: string;
  biggestIssue?: string;
  notes?: string;
};

export type LeadPatchInput = {
  status?: LeadStatus;
  notes?: string | null;
};

function cleanOptional(value?: string | null) {
  const next = value?.trim();
  return next ? next : null;
}

function normalizeLead(input: LeadCreateInput) {
  return {
    name: input.name.trim(),
    businessName: input.businessName.trim(),
    phone: input.phone.trim(),
    email: input.email.trim().toLowerCase(),
    monthlyShipments: cleanOptional(input.monthlyShipments),
    currentProvider: cleanOptional(input.currentProvider),
    biggestIssue: cleanOptional(input.biggestIssue),
    notes: cleanOptional(input.notes)
  };
}

export async function createLead(input: LeadCreateInput, client: Db = prisma) {
  const lead = await client.lead.create({
    data: normalizeLead(input)
  });

  return {
    ok: true,
    leadId: lead.id
  };
}

export async function listLeads(input: { status?: LeadStatus } = {}, client: Db = prisma) {
  const query: Prisma.LeadFindManyArgs = {
    orderBy: { createdAt: "desc" }
  };

  if (input.status) query.where = { status: input.status };

  const leads = await client.lead.findMany(query);

  return { leads };
}

export async function updateLead(input: {
  id: string;
  patch: LeadPatchInput;
  actorId?: string;
}, client: Db = prisma) {
  const existing = await client.lead.findUnique({
    where: { id: input.id }
  });

  if (!existing) {
    return null;
  }

  const previousStatus = existing.status;
  const data: Prisma.LeadUpdateInput = {};
  if (input.patch.status !== undefined) data.status = input.patch.status;
  if (input.patch.notes !== undefined) data.notes = cleanOptional(input.patch.notes);

  const lead = await client.lead.update({
    where: { id: input.id },
    data
  });

  if (input.patch.status !== undefined && input.patch.status !== previousStatus) {
    const auditInput: Parameters<typeof audit>[0] = {
      action: "ADMIN_LEAD_STATUS_CHANGED",
      entityType: "lead",
      entityId: lead.id,
      metadata: {
        from: previousStatus,
        to: lead.status,
        email: lead.email,
        businessName: lead.businessName
      }
    };
    if (input.actorId) auditInput.actorId = input.actorId;

    await audit(auditInput, client).catch(() => undefined);
  }

  return { lead };
}
