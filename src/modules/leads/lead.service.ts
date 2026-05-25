import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { LeadStatus, type Prisma } from "@prisma/client";
import { createEmailCloudTask } from "../../lib/cloudTasks.js";
import { logger } from "../../lib/logger.js";
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

type LeadNotificationLogger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
};

type LeadCreateOptions = {
  enqueueLeadNotification?: (leadId: string) => Promise<unknown>;
  log?: LeadNotificationLogger;
};

export type LeadConversionResult = {
  lead: Awaited<ReturnType<Db["lead"]["update"]>>;
  merchant: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
  };
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    userType: string;
    merchantId: string;
  };
  reusedMerchant: boolean;
  reusedUser: boolean;
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

function safeErrorMessage(err: unknown) {
  return err instanceof Error ? err.message.slice(0, 160) : "UNKNOWN_EMAIL_ERROR";
}

export async function enqueueLeadNotificationTask(leadId: string) {
  return createEmailCloudTask({
    taskId: `lead-email-${leadId}`,
    payload: { leadId }
  });
}

export async function createLead(
  input: LeadCreateInput,
  client: Db = prisma,
  options: LeadCreateOptions = {}
) {
  const log = options.log ?? logger;
  const lead = await client.lead.create({
    data: normalizeLead(input)
  });

  log.info({
    message: "lead_created",
    leadNotification: {
      leadId: lead.id
    }
  }, "lead_created");

  const enqueueLeadNotification = options.enqueueLeadNotification ?? enqueueLeadNotificationTask;
  log.info({
    message: "lead_email_task_enqueue_attempted",
    leadNotification: {
      leadId: lead.id
    }
  }, "lead_email_task_enqueue_attempted");

  try {
    const enqueueResult = await enqueueLeadNotification(lead.id);
    log.info({
      message: "lead_email_task_enqueued",
      leadNotification: {
        leadId: lead.id,
        status: "enqueued",
        taskStatus: typeof enqueueResult === "object" && enqueueResult && "status" in enqueueResult
          ? String((enqueueResult as { status?: unknown }).status)
          : "enqueued"
      }
    }, "lead_email_task_enqueued");
  } catch (err) {
    log.warn({
      message: "lead_email_task_enqueue_failed",
      leadNotification: {
        leadId: lead.id,
        status: "enqueue_failed",
        error: safeErrorMessage(err)
      }
    }, "lead_email_task_enqueue_failed");
  }

  return {
    ok: true,
    leadId: lead.id
  };
}

export async function listLeads(input: { status?: LeadStatus } = {}, client: Db = prisma) {
  const query: Prisma.LeadFindManyArgs = {
    orderBy: { createdAt: "desc" },
    include: {
      merchant: {
        select: {
          id: true,
          onboardingStatus: true,
          users: {
            take: 1,
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              email: true
            }
          }
        }
      }
    }
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
  const previousNotes = existing.notes ?? null;
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

  const nextNotes = lead.notes ?? null;
  if (input.patch.notes !== undefined && nextNotes !== previousNotes) {
    const auditInput: Parameters<typeof audit>[0] = {
      action: "ADMIN_LEAD_NOTES_UPDATED",
      entityType: "lead",
      entityId: lead.id,
      metadata: {
        email: lead.email,
        businessName: lead.businessName
      }
    };
    if (input.actorId) auditInput.actorId = input.actorId;

    await audit(auditInput, client).catch(() => undefined);
  }

  return { lead };
}

async function convertLeadInClient(input: {
  id: string;
  actorId?: string;
}, client: Db): Promise<LeadConversionResult | null> {
  const lead = await client.lead.findUnique({
    where: { id: input.id }
  });

  if (!lead) {
    return null;
  }

  const email = lead.email.trim().toLowerCase();
  let merchant = lead.merchantId
    ? await client.merchant.findUnique({ where: { id: lead.merchantId } })
    : null;
  let reusedMerchant = Boolean(merchant);

  if (!merchant) {
    merchant = await client.merchant.findUnique({ where: { email } });
    reusedMerchant = Boolean(merchant);
  }

  if (!merchant) {
    merchant = await client.merchant.create({
      data: {
        name: lead.businessName,
        email,
        phone: lead.phone
      }
    });
  }

  let user = await client.user.findUnique({ where: { email } });
  const reusedUser = Boolean(user);

  if (!user) {
    const passwordHash = await bcrypt.hash(randomUUID(), 12);
    user = await client.user.create({
      data: {
        merchantId: merchant.id,
        email,
        passwordHash,
        name: lead.name,
        role: "SELLER_OWNER",
        userType: "SELLER_ACCOUNT"
      }
    });
  }

  const updatedLead = await client.lead.update({
    where: { id: lead.id },
    data: {
      email,
      status: LeadStatus.CONVERTED,
      merchantId: merchant.id
    }
  });

  const auditInput: Parameters<typeof audit>[0] = {
    action: "LEAD_CONVERTED_TO_SELLER",
    entityType: "lead",
    entityId: lead.id,
    merchantId: merchant.id,
    metadata: {
      email,
      businessName: lead.businessName,
      merchantId: merchant.id,
      userId: user.id,
      reusedMerchant,
      reusedUser
    }
  };
  if (input.actorId) auditInput.actorId = input.actorId;

  await audit(auditInput, client).catch(() => undefined);

  return {
    lead: updatedLead,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      phone: merchant.phone ?? null
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name ?? null,
      role: user.role,
      userType: user.userType,
      merchantId: user.merchantId
    },
    reusedMerchant,
    reusedUser
  };
}

export async function convertLeadToSeller(input: {
  id: string;
  actorId?: string;
}, client: Db = prisma) {
  if ("$transaction" in client && typeof (client as typeof prisma).$transaction === "function") {
    return (client as typeof prisma).$transaction((tx) => convertLeadInClient(input, tx));
  }

  return convertLeadInClient(input, client);
}
