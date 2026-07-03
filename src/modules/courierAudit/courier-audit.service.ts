import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

export type CourierAuditLeadInput = {
  brand: string;
  name: string;
  email: string;
  whatsapp: string;
  monthlyShipments: number;
  currentAggregator?: string | null;
  estimatedLeak?: number | null;
  bumpRate?: number | null;
  averageOvercharge?: number | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  landingPath?: string | null;
  referrer?: string | null;
  website?: string | null;
};

type CourierAuditLeadRecord = {
  id: string;
  createdAt: Date;
  brand: string;
  name: string;
  email: string;
  whatsapp: string;
  monthlyShipments: number;
  currentAggregator: string | null;
  estimatedLeak: number | null;
  bumpRate: number | null;
  averageOvercharge: number | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  landingPath: string | null;
  referrer: string | null;
  status: string;
  source: string;
  n8nNotifiedAt: Date | null;
  n8nNotificationStatus: string | null;
  notes: string | null;
};

type CourierAuditLeadClient = {
  courierAuditLead: {
    create(input: { data: Record<string, unknown> }): Promise<CourierAuditLeadRecord>;
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<CourierAuditLeadRecord>;
  };
};

type NotifyLead = Pick<CourierAuditLeadRecord,
  | "id"
  | "createdAt"
  | "brand"
  | "name"
  | "email"
  | "whatsapp"
  | "monthlyShipments"
  | "currentAggregator"
  | "estimatedLeak"
  | "bumpRate"
  | "averageOvercharge"
  | "utmSource"
  | "utmMedium"
  | "utmCampaign"
  | "utmTerm"
  | "utmContent"
  | "landingPath"
  | "referrer"
  | "source"
>;

type NotificationResult = "sent" | "skipped_missing_webhook";
type Notifier = (lead: NotifyLead) => Promise<NotificationResult | void>;

const defaultClient = prisma as unknown as CourierAuditLeadClient;

function clean(value: string) {
  return value.trim();
}

function cleanOptional(value?: string | null) {
  const next = value?.trim();
  return next ? next : null;
}

function nullableNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sanitizedCourierAuditNotificationPayload(lead: NotifyLead) {
  return {
    event: "courier_audit_lead.created",
    lead: {
      id: lead.id,
      createdAt: lead.createdAt.toISOString(),
      brand: lead.brand,
      name: lead.name,
      email: lead.email,
      whatsapp: lead.whatsapp,
      monthlyShipments: lead.monthlyShipments,
      currentAggregator: lead.currentAggregator,
      estimatedLeak: lead.estimatedLeak,
      bumpRate: lead.bumpRate,
      averageOvercharge: lead.averageOvercharge,
      utmSource: lead.utmSource,
      utmMedium: lead.utmMedium,
      utmCampaign: lead.utmCampaign,
      utmTerm: lead.utmTerm,
      utmContent: lead.utmContent,
      landingPath: lead.landingPath,
      referrer: lead.referrer,
      source: lead.source
    }
  };
}

export function makeN8nCourierAuditNotifier(webhookUrl = env.COURIER_AUDIT_N8N_WEBHOOK_URL): Notifier {
  return async (lead) => {
    if (!webhookUrl?.trim()) return "skipped_missing_webhook";

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sanitizedCourierAuditNotificationPayload(lead))
    });

    if (!response.ok) {
      throw new Error("COURIER_AUDIT_N8N_NOTIFICATION_FAILED");
    }

    return "sent";
  };
}

export async function createCourierAuditLead(
  input: CourierAuditLeadInput,
  client: CourierAuditLeadClient = defaultClient,
  notify: Notifier = makeN8nCourierAuditNotifier()
) {
  if (cleanOptional(input.website)) {
    return {
      ok: true,
      stored: false,
      honeypot: true as const
    };
  }

  const lead = await client.courierAuditLead.create({
    data: {
      brand: clean(input.brand),
      name: clean(input.name),
      email: clean(input.email).toLowerCase(),
      whatsapp: clean(input.whatsapp),
      monthlyShipments: input.monthlyShipments,
      currentAggregator: cleanOptional(input.currentAggregator),
      estimatedLeak: nullableNumber(input.estimatedLeak),
      bumpRate: nullableNumber(input.bumpRate),
      averageOvercharge: nullableNumber(input.averageOvercharge),
      utmSource: cleanOptional(input.utmSource),
      utmMedium: cleanOptional(input.utmMedium),
      utmCampaign: cleanOptional(input.utmCampaign),
      utmTerm: cleanOptional(input.utmTerm),
      utmContent: cleanOptional(input.utmContent),
      landingPath: cleanOptional(input.landingPath),
      referrer: cleanOptional(input.referrer),
      source: "courier-audit",
      status: "new"
    }
  });

  try {
    const notificationResult = await notify(lead);
    if (notificationResult === "skipped_missing_webhook") {
      await client.courierAuditLead.update({
        where: { id: lead.id },
        data: {
          n8nNotificationStatus: "not_configured"
        }
      });
    } else {
      await client.courierAuditLead.update({
        where: { id: lead.id },
        data: {
          n8nNotifiedAt: new Date(),
          n8nNotificationStatus: "sent"
        }
      });
    }
  } catch {
    logger.warn({
      message: "courier_audit_n8n_notification_failed",
      courierAuditLead: {
        id: lead.id
      }
    }, "courier_audit_n8n_notification_failed");

    await client.courierAuditLead.update({
      where: { id: lead.id },
      data: {
        n8nNotificationStatus: "failed"
      }
    });
  }

  return {
    ok: true,
    stored: true,
    id: lead.id
  };
}
