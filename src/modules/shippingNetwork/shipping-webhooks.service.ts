import crypto from "crypto";
import { WebhookSubscriptionStatus, type Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { serializeWebhookSubscription } from "./shipping-api-serializers.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const SELLER_WEBHOOK_EVENTS = [
  "order.created",
  "shipment.created",
  "shipment.rates.ready",
  "shipment.shipped",
  "shipment.tracking.updated",
  "shipment.delivered",
  "shipment.failed",
  "shipment.rto.created",
  "ndr.created",
  "ndr.resolved",
  "cod.expected",
  "cod.collected",
  "cod.remittance_due",
  "cod.remitted",
  "weight.discrepancy.created",
  "weight.dispute.closed"
] as const;

export type SellerWebhookEvent = typeof SELLER_WEBHOOK_EVENTS[number];

export type CreateWebhookSubscriptionInput = {
  url: string;
  description?: string | null | undefined;
  events: string[];
};

export type UpdateWebhookSubscriptionInput = {
  url?: string | undefined;
  description?: string | null | undefined;
  events?: string[] | undefined;
  status?: "ACTIVE" | "DISABLED" | "FAILING" | undefined;
};

function hashWebhookSecret(raw: string) {
  return crypto
    .createHash("sha256")
    .update(`${env.APP_SECRET_PEPPER}:seller-webhook-secret:${raw}`)
    .digest("hex");
}

export function hashSellerWebhookSecret(raw: string) {
  return hashWebhookSecret(raw);
}

function generateWebhookSecret() {
  return `whsec_shipmastr_test_${crypto.randomBytes(24).toString("base64url")}`;
}

function localhostAllowed(url: URL) {
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function assertSafeWebhookUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "WEBHOOK_URL_INVALID");
  }

  const localAllowed = env.NODE_ENV !== "production" && localhostAllowed(url);
  if (url.protocol !== "https:" && !localAllowed) {
    throw new HttpError(400, "WEBHOOK_URL_HTTPS_REQUIRED");
  }

  return url.toString();
}

export function normalizeWebhookEvents(events: string[]) {
  const unsupported = events.filter((event) => !SELLER_WEBHOOK_EVENTS.includes(event as SellerWebhookEvent));
  if (unsupported.length) {
    throw new HttpError(400, "WEBHOOK_EVENT_UNSUPPORTED", { events: unsupported });
  }
  const normalized = [...new Set(events)];
  if (!normalized.length) {
    throw new HttpError(400, "WEBHOOK_EVENTS_REQUIRED");
  }
  return normalized;
}

export async function createWebhookSubscription(
  merchantId: string,
  input: CreateWebhookSubscriptionInput,
  client: Db = prisma
) {
  const rawSecret = generateWebhookSecret();
  const subscription = await client.webhookSubscription.create({
    data: {
      merchantId,
      url: assertSafeWebhookUrl(input.url),
      description: input.description ?? null,
      events: normalizeWebhookEvents(input.events),
      status: WebhookSubscriptionStatus.ACTIVE,
      secretHash: hashWebhookSecret(rawSecret)
    }
  });

  return serializeWebhookSubscription(subscription, rawSecret);
}

export async function listWebhookSubscriptions(merchantId: string, client: Db = prisma) {
  const subscriptions = await client.webhookSubscription.findMany({
    where: { merchantId },
    orderBy: { createdAt: "desc" }
  });

  return {
    webhooks: subscriptions.map((subscription) => serializeWebhookSubscription(subscription))
  };
}

export async function updateWebhookSubscription(
  merchantId: string,
  subscriptionId: string,
  input: UpdateWebhookSubscriptionInput,
  client: Db = prisma
) {
  const subscription = await client.webhookSubscription.findFirst({
    where: { id: subscriptionId, merchantId }
  });
  if (!subscription) throw new HttpError(404, "WEBHOOK_SUBSCRIPTION_NOT_FOUND");

  const data: Prisma.WebhookSubscriptionUncheckedUpdateInput = {};
  if (input.url !== undefined) data.url = assertSafeWebhookUrl(input.url);
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.events !== undefined) data.events = normalizeWebhookEvents(input.events);
  if (input.status !== undefined) {
    data.status = input.status as WebhookSubscriptionStatus;
    data.disabledAt = input.status === WebhookSubscriptionStatus.DISABLED ? new Date() : null;
  }

  const updated = await client.webhookSubscription.update({
    where: { id: subscription.id },
    data
  });

  return serializeWebhookSubscription(updated);
}

export async function disableWebhookSubscription(
  merchantId: string,
  subscriptionId: string,
  client: Db = prisma
) {
  const subscription = await client.webhookSubscription.findFirst({
    where: { id: subscriptionId, merchantId }
  });
  if (!subscription) throw new HttpError(404, "WEBHOOK_SUBSCRIPTION_NOT_FOUND");

  const updated = await client.webhookSubscription.update({
    where: { id: subscription.id },
    data: {
      status: WebhookSubscriptionStatus.DISABLED,
      disabledAt: new Date()
    }
  });

  return serializeWebhookSubscription(updated);
}
