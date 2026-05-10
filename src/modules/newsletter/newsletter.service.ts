import { randomBytes } from "node:crypto";

import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

type NewsletterSubscriberRecord = {
  id: string;
  email: string;
  status: "SUBSCRIBED" | "UNSUBSCRIBED";
  source: string | null;
  subscribedAt: Date;
  unsubscribedAt: Date | null;
  unsubscribeToken: string;
  createdAt: Date;
  updatedAt: Date;
};

type NewsletterSubscriberClient = {
  newsletterSubscriber: {
    upsert(input: {
      where: { email: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<NewsletterSubscriberRecord>;
    findUnique(input: { where: { unsubscribeToken: string } }): Promise<NewsletterSubscriberRecord | null>;
    findMany(input?: Record<string, unknown>): Promise<NewsletterSubscriberRecord[]>;
    count(input?: Record<string, unknown>): Promise<number>;
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<NewsletterSubscriberRecord>;
  };
};

const defaultClient = prisma as unknown as NewsletterSubscriberClient;
const publicBaseUrl = "https://www.shipmastr.com";

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function token() {
  return randomBytes(24).toString("hex");
}

export function buildUnsubscribeUrl(unsubscribeToken: string) {
  return `${publicBaseUrl}/api/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
}

export function publicSubscriber(record: NewsletterSubscriberRecord) {
  return {
    id: record.id,
    email: record.email,
    status: record.status,
    source: record.source,
    subscribedAt: record.subscribedAt,
    unsubscribedAt: record.unsubscribedAt
  };
}

export async function subscribeNewsletter(input: {
  email: string;
  source?: string | undefined;
}, client: NewsletterSubscriberClient = defaultClient) {
  const email = normalizeEmail(input.email);
  const source = input.source?.trim() || "shipmastr-journal";
  const now = new Date();

  const subscriber = await client.newsletterSubscriber.upsert({
    where: { email },
    create: {
      email,
      source,
      status: "SUBSCRIBED",
      subscribedAt: now,
      unsubscribedAt: null,
      unsubscribeToken: token()
    },
    update: {
      source,
      status: "SUBSCRIBED",
      subscribedAt: now,
      unsubscribedAt: null
    }
  });

  logger.info(
    {
      message: "newsletter_subscribed",
      newsletter: {
        subscriberId: subscriber.id,
        source: subscriber.source,
        status: subscriber.status
      }
    },
    "newsletter_subscribed"
  );

  return {
    ...publicSubscriber(subscriber),
    unsubscribeUrl: buildUnsubscribeUrl(subscriber.unsubscribeToken)
  };
}

export async function unsubscribeNewsletter(input: {
  token: string;
}, client: NewsletterSubscriberClient = defaultClient) {
  const unsubscribeToken = input.token.trim();
  const subscriber = await client.newsletterSubscriber.findUnique({
    where: { unsubscribeToken }
  });

  if (!subscriber) {
    return null;
  }

  const updated = await client.newsletterSubscriber.update({
    where: { id: subscriber.id },
    data: {
      status: "UNSUBSCRIBED",
      unsubscribedAt: new Date()
    }
  });

  logger.info(
    {
      message: "newsletter_unsubscribed",
      newsletter: {
        subscriberId: updated.id,
        source: updated.source,
        status: updated.status
      }
    },
    "newsletter_unsubscribed"
  );

  return publicSubscriber(updated);
}

export async function activeNewsletterSubscribers(client: NewsletterSubscriberClient = defaultClient) {
  const subscribers = await client.newsletterSubscriber.findMany({
    where: { status: "SUBSCRIBED" },
    orderBy: { subscribedAt: "asc" }
  });

  return subscribers.map((subscriber) => ({
    id: subscriber.id,
    email: subscriber.email,
    unsubscribeUrl: buildUnsubscribeUrl(subscriber.unsubscribeToken)
  }));
}

export async function newsletterSubscriberStatus(client: NewsletterSubscriberClient = defaultClient) {
  const [total, subscribed, unsubscribed] = await Promise.all([
    client.newsletterSubscriber.count(),
    client.newsletterSubscriber.count({ where: { status: "SUBSCRIBED" } }),
    client.newsletterSubscriber.count({ where: { status: "UNSUBSCRIBED" } })
  ]);

  return {
    total,
    subscribed,
    unsubscribed
  };
}
