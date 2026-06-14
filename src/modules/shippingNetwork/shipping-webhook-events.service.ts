import { WebhookEventOutboxStatus, WebhookSubscriptionStatus, type Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { redactSellerApiPayload, serializeWebhookEvent } from "./shipping-api-serializers.js";
import { toPrismaJson } from "./shipping-public-serializers.js";
import { normalizeWebhookEvents } from "./shipping-webhooks.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type ListWebhookEventsQuery = {
  status?: string | undefined;
  eventType?: string | undefined;
  page?: number | undefined;
  perPage?: number | undefined;
};

function pagination(query: ListWebhookEventsQuery = {}) {
  const page = Math.max(1, query.page ?? 1);
  const perPage = Math.min(50, Math.max(1, query.perPage ?? 20));
  return { page, perPage };
}

export function buildSellerWebhookPayload(eventType: string, data: unknown) {
  normalizeWebhookEvents([eventType]);
  return {
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    data: redactSellerApiPayload(data)
  };
}

export async function enqueueWebhookEvent(
  merchantId: string,
  eventType: string,
  data: unknown,
  client: Db = prisma
) {
  normalizeWebhookEvents([eventType]);
  const payload = buildSellerWebhookPayload(eventType, data);
  const subscriptions = await client.webhookSubscription.findMany({
    where: {
      merchantId,
      status: WebhookSubscriptionStatus.ACTIVE
    }
  });
  const matching = subscriptions.filter((subscription) => subscription.events.includes(eventType));
  const rows = [];

  if (!matching.length) {
    rows.push(await client.webhookEventOutbox.create({
      data: {
        merchantId,
        subscriptionId: null,
        eventType,
        payload: toPrismaJson(payload),
        status: WebhookEventOutboxStatus.SKIPPED
      }
    }));
  } else {
    for (const subscription of matching) {
      rows.push(await client.webhookEventOutbox.create({
        data: {
          merchantId,
          subscriptionId: subscription.id,
          eventType,
          payload: toPrismaJson(payload),
          status: WebhookEventOutboxStatus.PENDING
        }
      }));
    }
  }

  return {
    events: rows.map(serializeWebhookEvent)
  };
}

export async function listWebhookEvents(
  merchantId: string,
  query: ListWebhookEventsQuery = {},
  client: Db = prisma
) {
  const { page, perPage } = pagination(query);
  const where: Prisma.WebhookEventOutboxWhereInput = {
    merchantId,
    ...(query.status ? { status: query.status as WebhookEventOutboxStatus } : {}),
    ...(query.eventType ? { eventType: query.eventType } : {})
  };
  const [events, total] = await Promise.all([
    client.webhookEventOutbox.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage
    }),
    client.webhookEventOutbox.count({ where })
  ]);

  return {
    events: events.map(serializeWebhookEvent),
    pagination: {
      page,
      per_page: perPage,
      total,
      has_more: page * perPage < total
    }
  };
}

export async function simulateWebhookDelivered(
  merchantId: string,
  eventId: string,
  client: Db = prisma
) {
  const event = await client.webhookEventOutbox.findFirst({
    where: { id: eventId, merchantId }
  });
  if (!event) throw new HttpError(404, "WEBHOOK_EVENT_NOT_FOUND");
  const now = new Date();
  const updated = await client.webhookEventOutbox.update({
    where: { id: event.id },
    data: {
      status: WebhookEventOutboxStatus.DELIVERED,
      attemptCount: event.attemptCount + 1,
      lastAttemptAt: now,
      deliveredAt: now,
      failedAt: null
    }
  });

  return serializeWebhookEvent(updated);
}

export async function simulateWebhookFailed(
  merchantId: string,
  eventId: string,
  client: Db = prisma
) {
  const event = await client.webhookEventOutbox.findFirst({
    where: { id: eventId, merchantId }
  });
  if (!event) throw new HttpError(404, "WEBHOOK_EVENT_NOT_FOUND");
  const now = new Date();
  const updated = await client.webhookEventOutbox.update({
    where: { id: event.id },
    data: {
      status: WebhookEventOutboxStatus.FAILED,
      attemptCount: event.attemptCount + 1,
      lastAttemptAt: now,
      failedAt: now
    }
  });

  return serializeWebhookEvent(updated);
}
