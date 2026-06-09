import { Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { getLivePilotReadinessSnapshot } from "../livePilot/live-pilot.service.js";
import { deliverSandboxEmail } from "./email-delivery.sandbox.js";
import {
  maskEmailAddress,
  sanitizeEmailDeliveryMeta,
  serializeEmailDeliveryAttempt,
  serializeEmailDeliveryReadiness
} from "./email-delivery.serializer.js";
import { getEmailDeliveryRuntime } from "./email-delivery.providers.js";
import type { EmailDeliveryReadiness } from "./email-delivery.types.js";
import type {
  ListEmailDeliveryAttemptsQueryInput,
  SandboxEmailRequestInput
} from "./email-delivery.validation.js";

type Db = Prisma.TransactionClient | typeof prisma;
type EmailDeliverySource = Record<string, string | boolean | number | undefined | null>;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(sanitizeEmailDeliveryMeta(value ?? {}))) as Prisma.InputJsonValue;
}

function defaultPreference() {
  return { emailEnabled: false };
}

function safeSubject(value?: string | null) {
  const subject = String(value || "Shipmastr sandbox notification").trim().slice(0, 160);
  return String(sanitizeEmailDeliveryMeta(subject) || "Shipmastr sandbox notification");
}

async function emailPreference(merchantId: string, client: Db) {
  return (await client.merchantNotificationPreference.findUnique({ where: { merchantId } })) ?? defaultPreference();
}

async function auditEmailAction(
  merchantId: string,
  action: string,
  input: { targetId?: string | null; safeMeta?: unknown },
  client: Db
) {
  return client.livePilotAuditLog.create({
    data: {
      merchantId,
      action,
      actorId: "shipmastr_email_sandbox",
      targetType: "EmailDeliveryAttempt",
      targetId: input.targetId ?? null,
      safeMeta: toJson(input.safeMeta ?? {})
    }
  });
}

async function createAttempt(
  merchantId: string,
  input: {
    notificationId?: string | null;
    recipientSafe: string;
    provider: string;
    mode: string;
    status: string;
    subject?: string | null;
    safeMeta?: unknown;
    sentAt?: Date | null;
  },
  client: Db
) {
  const attempt = await client.emailDeliveryAttempt.create({
    data: {
      merchantId,
      notificationId: input.notificationId ?? null,
      recipientSafe: input.recipientSafe,
      provider: input.provider,
      mode: input.mode,
      status: input.status,
      subject: input.subject ?? null,
      safeMeta: toJson(input.safeMeta ?? {}),
      sentAt: input.sentAt ?? null
    }
  });
  await auditEmailAction(merchantId, `EMAIL_DELIVERY_${input.status}`, {
    targetId: attempt.id,
    safeMeta: {
      notification_id: input.notificationId ?? null,
      status: input.status,
      mode: input.mode,
      recipient_safe: input.recipientSafe
    }
  }, client);
  return serializeEmailDeliveryAttempt(attempt);
}

export async function getEmailDeliveryReadiness(
  merchantId: string,
  source: EmailDeliverySource = env,
  client: Db = prisma
) {
  const runtime = getEmailDeliveryRuntime(source);
  const [preference, pilot] = await Promise.all([
    emailPreference(merchantId, client),
    getLivePilotReadinessSnapshot(merchantId, client)
  ]);
  const capabilityEnabled = pilot.enabledCapabilities.includes("LIVE_EMAIL_SANDBOX");
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!runtime.enabled) blockers.push("EMAIL_DELIVERY_DISABLED");
  if (runtime.mode !== "SANDBOX") blockers.push("EMAIL_LIVE_MODE_BLOCKED");
  if (runtime.liveDeliveryEnabled) blockers.push("REAL_EMAIL_DELIVERY_FLAG_ENABLED");
  if (!runtime.providerConfigured) blockers.push("EMAIL_PROVIDER_NOT_CONFIGURED");
  if (runtime.pilotOnly && !pilot.allowlisted) blockers.push("EMAIL_PILOT_MERCHANT_REQUIRED");
  if (!capabilityEnabled) blockers.push("LIVE_EMAIL_SANDBOX_CAPABILITY_REQUIRED");
  if (!preference.emailEnabled) blockers.push("EMAIL_PREFERENCE_DISABLED");
  if (runtime.provider === "SMTP_SANDBOX") {
    warnings.push("SMTP sandbox provider is configured for readiness only; this phase records safe sandbox attempts.");
  }

  const ready = blockers.length === 0;
  const readiness: EmailDeliveryReadiness = {
    status: ready ? "READY" : runtime.enabled ? "BLOCKED" : "DISABLED",
    ready,
    message: ready
      ? "Email sandbox delivery is ready for this pilot merchant."
      : "Email sandbox delivery is not ready. Review the safe blockers before testing.",
    runtime,
    preferenceEmailEnabled: Boolean(preference.emailEnabled),
    pilot: {
      allowlisted: pilot.allowlisted,
      capabilityEnabled
    },
    blockers,
    warnings
  };
  return serializeEmailDeliveryReadiness(readiness);
}

async function assertSandboxReady(
  merchantId: string,
  source: EmailDeliverySource,
  client: Db
) {
  const readiness = await getEmailDeliveryReadiness(merchantId, source, client);
  if (!readiness.ready) {
    throw new HttpError(409, readiness.blockers[0] || "EMAIL_SANDBOX_NOT_READY", { readiness });
  }
  return readiness;
}

export async function listEmailDeliveryAttempts(
  merchantId: string,
  query: ListEmailDeliveryAttemptsQueryInput,
  client: Db = prisma
) {
  const where: Prisma.EmailDeliveryAttemptWhereInput = {
    merchantId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.notification_id ? { notificationId: query.notification_id } : {})
  };
  const [attempts, total] = await Promise.all([
    client.emailDeliveryAttempt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.per_page,
      take: query.per_page
    }),
    client.emailDeliveryAttempt.count({ where })
  ]);
  return {
    attempts: attempts.map(serializeEmailDeliveryAttempt),
    pagination: {
      page: query.page,
      per_page: query.per_page,
      total,
      has_more: query.page * query.per_page < total
    }
  };
}

export async function testSandboxEmailDelivery(
  merchantId: string,
  input: SandboxEmailRequestInput & { actorEmail?: string | null },
  source: EmailDeliverySource = env,
  client: Db = prisma
) {
  const runtime = getEmailDeliveryRuntime(source);
  const recipientSafe = maskEmailAddress(input.recipient_email ?? input.actorEmail ?? null);
  const subject = safeSubject(input.subject ?? "Shipmastr pilot email sandbox test");
  try {
    const readiness = await assertSandboxReady(merchantId, source, client);
    const delivered = await deliverSandboxEmail({
      provider: runtime.provider,
      recipientSafe,
      subject,
      notificationId: null
    });
    const attempt = await createAttempt(merchantId, {
      notificationId: null,
      recipientSafe,
      provider: runtime.provider,
      mode: runtime.mode,
      status: delivered.status,
      subject,
      sentAt: delivered.sentAt,
      safeMeta: delivered.safeMeta
    }, client);
    return {
      readiness,
      attempt,
      message: "Sandbox email test recorded safely. No broad real email was sent."
    };
  } catch (error) {
    if (error instanceof HttpError) {
      const attempt = await createAttempt(merchantId, {
        notificationId: null,
        recipientSafe,
        provider: runtime.provider,
        mode: runtime.mode,
        status: "BLOCKED",
        subject,
        safeMeta: {
          blocker: error.message,
          sandbox: true
        }
      }, client);
      throw new HttpError(error.status, error.message, {
        ...((error.details as Record<string, unknown> | undefined) || {}),
        attempt
      });
    }
    throw error;
  }
}

export async function sendMerchantNotificationEmailSandbox(
  merchantId: string,
  notificationId: string,
  input: SandboxEmailRequestInput & { actorEmail?: string | null },
  source: EmailDeliverySource = env,
  client: Db = prisma
) {
  const notification = await client.merchantNotification.findFirst({
    where: { id: notificationId, merchantId }
  });
  if (!notification) throw new HttpError(404, "MERCHANT_NOTIFICATION_NOT_FOUND");
  const runtime = getEmailDeliveryRuntime(source);
  const recipientSafe = maskEmailAddress(input.recipient_email ?? input.actorEmail ?? null);
  const subject = safeSubject(input.subject ?? notification.title);
  try {
    const readiness = await assertSandboxReady(merchantId, source, client);
    const delivered = await deliverSandboxEmail({
      provider: runtime.provider,
      recipientSafe,
      subject,
      notificationId
    });
    const attempt = await createAttempt(merchantId, {
      notificationId,
      recipientSafe,
      provider: runtime.provider,
      mode: runtime.mode,
      status: delivered.status,
      subject,
      sentAt: delivered.sentAt,
      safeMeta: {
        ...delivered.safeMeta,
        notification_type: notification.type,
        severity: notification.severity
      }
    }, client);
    return {
      readiness,
      attempt,
      message: "Notification sandbox email recorded safely. No broad real email was sent."
    };
  } catch (error) {
    if (error instanceof HttpError) {
      const attempt = await createAttempt(merchantId, {
        notificationId,
        recipientSafe,
        provider: runtime.provider,
        mode: runtime.mode,
        status: "BLOCKED",
        subject,
        safeMeta: {
          blocker: error.message,
          sandbox: true,
          notification_type: notification.type
        }
      }, client);
      throw new HttpError(error.status, error.message, {
        ...((error.details as Record<string, unknown> | undefined) || {}),
        attempt
      });
    }
    throw error;
  }
}
