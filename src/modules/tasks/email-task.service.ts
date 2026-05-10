import type { Lead, Prisma } from "@prisma/client";
import { emailTemplates, sendTransactionalEmail } from "../../lib/email.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

type LeadNotificationStatus = "sent" | "failed" | "skipped";

type LeadNotificationLogger = {
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
};

type LeadNotificationDeps = {
  sendEmail?: typeof sendTransactionalEmail;
  log?: LeadNotificationLogger;
};

type LeadNotificationEnvStatus = {
  smtpHostConfigured: boolean;
  smtpPortConfigured: boolean;
  smtpUserConfigured: boolean;
  smtpPassConfigured: boolean;
  emailFromConfigured: boolean;
  adminEmailConfigured: boolean;
};

function safeErrorMessage(err: unknown) {
  return err instanceof Error ? err.message.slice(0, 160) : "UNKNOWN_EMAIL_ERROR";
}

function readProcessEnvString(key: string) {
  const value = process.env[key];
  return typeof value === "string" ? value.trim() : "";
}

function getLeadNotificationEnvStatus(): LeadNotificationEnvStatus {
  return {
    smtpHostConfigured: Boolean(readProcessEnvString("SMTP_HOST")),
    smtpPortConfigured: Boolean(readProcessEnvString("SMTP_PORT")),
    smtpUserConfigured: Boolean(readProcessEnvString("SMTP_USER")),
    smtpPassConfigured: Boolean(process.env.SMTP_PASS),
    emailFromConfigured: Boolean(readProcessEnvString("EMAIL_FROM")),
    adminEmailConfigured: Boolean(readProcessEnvString("ADMIN_EMAIL"))
  };
}

function isLeadNotificationEmailConfigured(status: LeadNotificationEnvStatus) {
  return Boolean(
    status.smtpHostConfigured &&
    status.smtpPortConfigured &&
    status.smtpUserConfigured &&
    status.smtpPassConfigured &&
    status.emailFromConfigured &&
    status.adminEmailConfigured
  );
}

export async function sendLeadSubmittedNotification(
  lead: Lead,
  deps: LeadNotificationDeps = {}
): Promise<{ status: LeadNotificationStatus }> {
  const log = deps.log ?? logger;
  const envStatus = getLeadNotificationEnvStatus();
  const emailConfigured = isLeadNotificationEmailConfigured(envStatus);
  const adminEmail = readProcessEnvString("ADMIN_EMAIL");

  log.info({
    message: "lead_notification_email_attempted",
    leadNotification: {
      leadId: lead.id,
      emailConfigured,
      ...envStatus
    }
  }, "lead_notification_email_attempted");

  if (!emailConfigured || !adminEmail) {
    log.info({
      message: "lead_notification_email_skipped_smtp_not_configured",
      leadNotification: {
        leadId: lead.id,
        status: "skipped",
        emailConfigured,
        ...envStatus
      }
    }, "lead_notification_email_skipped_smtp_not_configured");
    return { status: "skipped" };
  }

  const template = emailTemplates.leadSubmitted({
    businessName: lead.businessName,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    monthlyShipments: lead.monthlyShipments,
    biggestIssue: lead.biggestIssue,
    notes: lead.notes
  });

  try {
    await (deps.sendEmail ?? sendTransactionalEmail)({
      to: adminEmail,
      type: "lead-submitted",
      metadata: { leadId: lead.id },
      ...template
    });

    log.info({
      message: "lead_notification_email_sent",
      leadNotification: {
        leadId: lead.id,
        status: "sent"
      }
    }, "lead_notification_email_sent");
    return { status: "sent" };
  } catch (err) {
    log.warn({
      message: "lead_notification_email_failed",
      leadNotification: {
        leadId: lead.id,
        status: "failed",
        error: safeErrorMessage(err)
      }
    }, "lead_notification_email_failed");
    return { status: "failed" };
  }
}

export async function processLeadNotificationTask(
  input: { leadId: string },
  client: Db = prisma,
  deps: LeadNotificationDeps = {}
) {
  const log = deps.log ?? logger;
  const lead = await client.lead.findUnique({
    where: { id: input.leadId }
  });

  if (!lead) {
    log.warn({
      message: "lead_notification_email_missing_lead",
      leadNotification: {
        leadId: input.leadId,
        status: "missing_lead"
      }
    }, "lead_notification_email_missing_lead");
    return {
      ok: true,
      status: "missing_lead" as const
    };
  }

  const result = await sendLeadSubmittedNotification(lead, deps);
  return {
    ok: result.status === "sent",
    status: result.status
  };
}
