import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  generateDailyJournalPost,
  listPublishedJournalPosts,
  runDailyJournalAutopublish
} from "./journal-post.service.js";

const now = new Date("2026-05-07T03:30:00.000Z");

function makeClient() {
  const state = {
    posts: [] as any[]
  };

  function matches(record: any, where: any = {}) {
    if (!where) return true;
    if (where.status?.in && !where.status.in.includes(record.status)) return false;
    if (where.slug && record.slug !== where.slug) return false;
    return true;
  }

  function sortPosts(records: any[], orderBy: any) {
    const rules = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...records].sort((a, b) => {
      for (const rule of rules) {
        const [field, direction] = Object.entries(rule)[0] as [string, string];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field] ?? 0;
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field] ?? 0;
        if (av === bv) continue;
        return direction === "desc" ? Number(bv) - Number(av) : Number(av) - Number(bv);
      }
      return 0;
    });
  }

  function record(data: any) {
    return {
      id: `post_${state.posts.length + 1}`,
      createdAt: now,
      updatedAt: now,
      ...data
    };
  }

  const client = {
    journalPost: {
      create: async ({ data }: any) => {
        const created = record(data);
        state.posts.push(created);
        return created;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = state.posts.find((post) => post.slug === where.slug);
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const created = record(create);
        state.posts.push(created);
        return created;
      },
      findMany: async ({ where, orderBy, take }: any = {}) => {
        const filtered = state.posts.filter((post) => matches(post, where));
        return sortPosts(filtered, orderBy).slice(0, take ?? filtered.length);
      },
      findFirst: async ({ where, orderBy }: any = {}) => {
        const filtered = state.posts.filter((post) => matches(post, where));
        return sortPosts(filtered, orderBy)[0] ?? null;
      },
      update: async ({ where, data }: any) => {
        const existing = state.posts.find((post) => post.id === where.id);
        if (!existing) throw new Error("POST_NOT_FOUND");
        Object.assign(existing, data, { updatedAt: now });
        return existing;
      }
    }
  };

  return { client: client as any, state };
}

function readyConfig() {
  return {
    ready: true,
    missing: []
  } as any;
}

function notReadyConfig() {
  return {
    ready: false,
    missing: ["SMTP_HOST", "SMTP_PASS"]
  } as any;
}

describe("journal autopublish Postgres store", () => {
  it("renders the premium Gmail-safe Journal email template", () => {
    const post = generateDailyJournalPost(now);
    const html = post.emailVersion.htmlBody;

    assert.equal(post.emailVersion.subject, "COD reconciliation before payout chaos");
    assert.match(html, /Shipmastr/);
    assert.match(html, /Journal/);
    assert.match(html, /background:#f6f2ea/);
    assert.match(html, /max-width:640px/);
    assert.match(html, /Daily Journal Update/);
    assert.match(html, /How Shipmastr helps/);
    assert.match(html, /Read full update/);
    assert.match(html, /Build on Shipmastr/);
    assert.match(html, /\{\{unsubscribeUrl\}\}/);
    assert.match(html, /\[Registered address placeholder\]/);
  });

  it("no longer fails with JOURNAL_AUTOPUBLISH_STORE_NOT_CONFIGURED when DB store is configured", async () => {
    const { client } = makeClient();
    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: false,
      now
    }, {
      client,
      storeMode: "postgres"
    });

    assert.notEqual(result.reason, "JOURNAL_AUTOPUBLISH_STORE_NOT_CONFIGURED");
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.published, true);
  });

  it("returns a skipped state when the journal store is not configured", async () => {
    const { client } = makeClient();
    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: true,
      now
    }, {
      client,
      storeMode: "not_configured"
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "SKIPPED");
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "JOURNAL_AUTOPUBLISH_STORE_NOT_CONFIGURED");
    assert.equal(result.published, false);
    assert.equal(result.emailSent, false);
  });

  it("returns a skipped state when the journal store is unavailable", async () => {
    const { client } = makeClient();
    const failingClient = {
      ...client,
      journalPost: {
        ...client.journalPost,
        upsert: async () => {
          throw new Error("database secret connection payload should not leak");
        }
      }
    };

    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: true,
      now
    }, {
      client: failingClient as any,
      storeMode: "postgres"
    });

    const serialized = JSON.stringify(result);
    assert.equal(result.ok, false);
    assert.equal(result.status, "SKIPPED");
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "JOURNAL_STORE_UNAVAILABLE");
    assert.equal(result.published, false);
    assert.equal(result.emailSent, false);
    assert.doesNotMatch(serialized, /database secret connection payload/);
    assert.doesNotMatch(serialized, /secret/);
  });

  it("saves guardrail failures as HELD and does not email", async () => {
    const { client, state } = makeClient();
    let emailCalls = 0;
    const invalidPost = {
      ...generateDailyJournalPost(now),
      seoTitle: "x".repeat(61)
    };

    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: true,
      now,
      post: invalidPost
    }, {
      client,
      storeMode: "postgres",
      loadSubscribers: async () => [{ email: "seller@example.com", unsubscribeUrl: "https://www.shipmastr.com/u/test" }],
      getEmailConfig: async () => readyConfig(),
      sendEmail: async () => {
        emailCalls += 1;
        return { messageId: "should_not_send", accepted: [], rejected: [], response: null };
      }
    });

    assert.equal(result.status, "GUARDRAIL_HOLD");
    assert.equal(result.published, false);
    assert.equal(result.emailSent, false);
    assert.equal(emailCalls, 0);
    assert.equal(state.posts[0]?.status, "HELD");
    assert.deepEqual(state.posts[0]?.guardrailFailures, ["SEO title <= 60 chars"]);
  });

  it("saves passing posts as PUBLISHED", async () => {
    const { client, state } = makeClient();
    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: false,
      now
    }, {
      client,
      storeMode: "db"
    });

    assert.equal(result.status, "PUBLISHED");
    assert.equal(state.posts[0]?.status, "PUBLISHED");
    assert.equal(state.posts[0]?.guardrailStatus, "PASS");
    assert.equal(state.posts[0]?.publishedAt?.toISOString(), now.toISOString());
  });

  it("sends email only after a post is published", async () => {
    const { client } = makeClient();
    const sentTo: string[] = [];
    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: true,
      now
    }, {
      client,
      storeMode: "postgres",
      loadSubscribers: async () => [{ email: "seller@example.com", unsubscribeUrl: "https://www.shipmastr.com/unsubscribe/test" }],
      getEmailConfig: async () => readyConfig(),
      sendEmail: async (input) => {
        sentTo.push(input.to);
        return { messageId: "msg_1", accepted: [input.to], rejected: [], response: "250 OK" };
      }
    });

    assert.equal(result.published, true);
    assert.equal(result.emailSent, true);
    assert.deepEqual(sentTo, ["seller@example.com"]);
  });

  it("does not fail the daily run when sentAt update fails after email send", async () => {
    const { client } = makeClient();
    const warningClient = {
      ...client,
      journalPost: {
        ...client.journalPost,
        update: async () => {
          throw new Error("provider secret response should not leak");
        }
      }
    };

    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: true,
      now
    }, {
      client: warningClient as any,
      storeMode: "postgres",
      loadSubscribers: async () => [{ id: "subscriber_1", email: "seller@example.com", unsubscribeUrl: "https://www.shipmastr.com/unsubscribe/test" }],
      getEmailConfig: async () => readyConfig(),
      sendEmail: async (input) => ({ messageId: "msg_1", accepted: [input.to], rejected: [], response: "250 OK" })
    });

    const serialized = JSON.stringify(result);
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.published, true);
    assert.equal(result.emailSent, true);
    assert.deepEqual(result.warnings, ["JOURNAL_SENT_AT_UPDATE_FAILED"]);
    assert.doesNotMatch(serialized, /provider secret response/);
  });

  it("publishes and skips email safely when there are no newsletter recipients", async () => {
    const { client } = makeClient();
    let emailCalls = 0;
    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: true,
      now
    }, {
      client,
      storeMode: "postgres",
      loadSubscribers: async () => [],
      getEmailConfig: async () => readyConfig(),
      sendEmail: async () => {
        emailCalls += 1;
        return { messageId: "msg_1", accepted: [], rejected: [], response: null };
      }
    });

    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.published, true);
    assert.equal(result.emailSent, false);
    assert.equal(result.recipientCount, 0);
    assert.equal(result.emailSkippedReason, "NO_ACTIVE_SUBSCRIBERS");
    assert.equal(emailCalls, 0);
  });

  it("publishes and skips email safely when email config is not ready", async () => {
    const { client } = makeClient();
    let emailCalls = 0;
    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: true,
      now
    }, {
      client,
      storeMode: "postgres",
      loadSubscribers: async () => [{ email: "seller@example.com", unsubscribeUrl: "https://www.shipmastr.com/unsubscribe/test" }],
      getEmailConfig: async () => notReadyConfig(),
      sendEmail: async () => {
        emailCalls += 1;
        return { messageId: "msg_1", accepted: [], rejected: [], response: null };
      }
    });

    const serialized = JSON.stringify(result);
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.published, true);
    assert.equal(result.emailSent, false);
    assert.equal(result.recipientCount, 1);
    assert.equal(result.emailSkippedReason, "JOURNAL_EMAIL_NOT_READY");
    assert.equal(emailCalls, 0);
    assert.doesNotMatch(serialized, /seller@example\.com/);
    assert.doesNotMatch(serialized, /SMTP_PASS/);
  });

  it("converts email send failures into a safe skipped-email result", async () => {
    const { client } = makeClient();
    const result = await runDailyJournalAutopublish({
      publish: true,
      sendEmail: true,
      now
    }, {
      client,
      storeMode: "postgres",
      loadSubscribers: async () => [{ id: "subscriber_1", email: "seller@example.com", unsubscribeUrl: "https://www.shipmastr.com/unsubscribe/test" }],
      getEmailConfig: async () => readyConfig(),
      sendEmail: async () => {
        throw new Error("provider secret response should not leak");
      }
    });

    const serialized = JSON.stringify(result);
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.published, true);
    assert.equal(result.emailSent, false);
    assert.equal(result.recipientCount, 1);
    assert.equal(result.emailSkippedReason, "JOURNAL_EMAIL_SEND_FAILED");
    assert.equal(result.emailFailureCount, 1);
    assert.doesNotMatch(serialized, /seller@example\.com/);
    assert.doesNotMatch(serialized, /secret response/);
    assert.doesNotMatch(serialized, /provider/);
  });

  it("does not send email for draft-only runs", async () => {
    const { client } = makeClient();
    let emailCalls = 0;
    const result = await runDailyJournalAutopublish({
      publish: false,
      sendEmail: true,
      now
    }, {
      client,
      storeMode: "postgres",
      loadSubscribers: async () => [{ email: "seller@example.com", unsubscribeUrl: "https://www.shipmastr.com/unsubscribe/test" }],
      getEmailConfig: async () => readyConfig(),
      sendEmail: async () => {
        emailCalls += 1;
        return { messageId: "msg_1", accepted: [], rejected: [], response: null };
      }
    });

    assert.equal(result.status, "DRAFT_SAVED");
    assert.equal(result.published, false);
    assert.equal(emailCalls, 0);
  });

  it("returns latest published posts for /blog/posts.json", async () => {
    const { client } = makeClient();
    await runDailyJournalAutopublish({
      publish: true,
      sendEmail: false,
      now
    }, {
      client,
      storeMode: "postgres"
    });

    const posts = await listPublishedJournalPosts({}, client);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.slug, "cod-reconciliation-before-payout-chaos-2026-05-07");
    assert.equal(posts[0]?.headline, "COD reconciliation before payout chaos");
  });
});
