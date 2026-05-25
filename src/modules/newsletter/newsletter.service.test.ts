import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activeNewsletterSubscribers,
  newsletterSubscriberStatus,
  subscribeNewsletter,
  unsubscribeNewsletter
} from "./newsletter.service.js";

const now = new Date("2026-05-07T09:00:00.000Z");

function makeNewsletterClient() {
  const state = {
    subscribers: [] as any[]
  };

  const client = {
    newsletterSubscriber: {
      upsert: async ({ where, create, update }: any) => {
        const existing = state.subscribers.find((subscriber) => subscriber.email === where.email);
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const created = {
          id: `sub_${state.subscribers.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...create
        };
        state.subscribers.push(created);
        return created;
      },
      findUnique: async ({ where }: any) => state.subscribers.find((subscriber) => subscriber.unsubscribeToken === where.unsubscribeToken) ?? null,
      findMany: async ({ where, orderBy }: any = {}) => {
        let records = state.subscribers;
        if (where?.status) records = records.filter((subscriber) => subscriber.status === where.status);
        if (orderBy?.subscribedAt === "asc") {
          records = [...records].sort((a, b) => a.subscribedAt.getTime() - b.subscribedAt.getTime());
        }
        return records;
      },
      count: async ({ where }: any = {}) => {
        if (where?.status) return state.subscribers.filter((subscriber) => subscriber.status === where.status).length;
        return state.subscribers.length;
      },
      update: async ({ where, data }: any) => {
        const existing = state.subscribers.find((subscriber) => subscriber.id === where.id);
        if (!existing) throw new Error("SUBSCRIBER_NOT_FOUND");
        Object.assign(existing, data, { updatedAt: now });
        return existing;
      }
    }
  };

  return { client: client as any, state };
}

describe("newsletter subscribers", () => {
  it("subscribes and normalizes email in the Cloud Run source of truth", async () => {
    const { client, state } = makeNewsletterClient();
    const result = await subscribeNewsletter({
      email: " MERCHANT@EXAMPLE.COM ",
      source: "manual-test"
    }, client);

    assert.equal(result.status, "SUBSCRIBED");
    assert.equal(result.email, "merchant@example.com");
    assert.equal(state.subscribers[0]?.source, "manual-test");
    assert.match(result.unsubscribeUrl, /^https:\/\/www\.shipmastr\.com\/api\/newsletter\/unsubscribe\?token=/);
  });

  it("resubscribes an unsubscribed email without changing the token", async () => {
    const { client, state } = makeNewsletterClient();
    await subscribeNewsletter({ email: "seller@example.com", source: "first" }, client);
    const originalToken = state.subscribers[0]?.unsubscribeToken;
    await unsubscribeNewsletter({ token: originalToken }, client);
    const result = await subscribeNewsletter({ email: "seller@example.com", source: "second" }, client);

    assert.equal(result.status, "SUBSCRIBED");
    assert.equal(state.subscribers[0]?.unsubscribeToken, originalToken);
    assert.equal(state.subscribers[0]?.source, "second");
    assert.equal(state.subscribers[0]?.unsubscribedAt, null);
  });

  it("unsubscribes by token and excludes inactive subscribers from Journal sends", async () => {
    const { client, state } = makeNewsletterClient();
    await subscribeNewsletter({ email: "seller@example.com" }, client);
    await subscribeNewsletter({ email: "active@example.com" }, client);
    await unsubscribeNewsletter({ token: state.subscribers[0]?.unsubscribeToken }, client);

    const active = await activeNewsletterSubscribers(client);
    assert.deepEqual(active.map((subscriber) => subscriber.email), ["active@example.com"]);
    assert.equal(active[0]?.id, "sub_2");
  });

  it("returns subscriber counts for admin status checks", async () => {
    const { client, state } = makeNewsletterClient();
    await subscribeNewsletter({ email: "seller@example.com" }, client);
    await subscribeNewsletter({ email: "active@example.com" }, client);
    await unsubscribeNewsletter({ token: state.subscribers[0]?.unsubscribeToken }, client);

    assert.deepEqual(await newsletterSubscriberStatus(client), {
      total: 2,
      subscribed: 1,
      unsubscribed: 1
    });
  });
});
