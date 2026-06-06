import { env } from "../../config/env.js";
import { sendJournalEmail } from "../../lib/email.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { activeNewsletterSubscribers } from "../newsletter/newsletter.service.js";
import { getJournalEmailConfig } from "./journal-email.service.js";
import { validateJournalPost } from "./journal.guardrails.js";

export type GeneratedJournalPost = {
  headline: string;
  slug: string;
  category: string;
  seoTitle: string;
  metaDescription: string;
  homepageTeaser: string;
  sourceNotes: Array<{ title: string; url: string }>;
  dailyJournalUpdate: string[];
  howShipmastrHelps: string[];
  marketingAngle: string;
  organicBacklinkAngle: string;
  internalLinks: string[];
  emailVersion: {
    subject: string;
    previewText: string;
    plainTextBody: string;
    htmlBody: string;
  };
};

type JournalPostRecord = {
  id: string;
  slug: string;
  title: string;
  category: string;
  seoTitle: string;
  metaDescription: string;
  excerpt: string;
  bodyHtml: string;
  bodyText: string;
  sourceNotes: unknown;
  homepageTeaser: string;
  emailSubject: string;
  emailPreview: string;
  emailHtml: string;
  emailText: string;
  status: string;
  guardrailStatus: string;
  guardrailFailures: unknown;
  metadata?: unknown;
  publishedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type JournalPostClient = {
  journalPost: {
    create(input: { data: Record<string, unknown> }): Promise<JournalPostRecord>;
    upsert(input: {
      where: { slug: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<JournalPostRecord>;
    findMany(input?: Record<string, unknown>): Promise<JournalPostRecord[]>;
    findFirst(input?: Record<string, unknown>): Promise<JournalPostRecord | null>;
    update(input: { where: { id: string }; data: Record<string, unknown> }): Promise<JournalPostRecord>;
  };
};

type JournalSubscriber = {
  id?: string;
  email: string;
  unsubscribeUrl: string;
};

type EmailSendResult = {
  messageId: string | null;
  accepted: string[];
  rejected: string[];
  response: string | null;
};

type JournalEmailDelivery = {
  emailSent: boolean;
  recipientCount: number;
  skippedReason?: string;
  emailFailureCount?: number;
  results: EmailSendResult[];
};

type RunDailyOptions = {
  mode?: string;
  publish?: boolean;
  sendEmail?: boolean;
  now?: Date;
  post?: GeneratedJournalPost;
};

type JournalPostDependencies = {
  client?: JournalPostClient;
  storeMode?: "postgres" | "db" | "not_configured";
  loadSubscribers?: () => Promise<JournalSubscriber[]>;
  getEmailConfig?: typeof getJournalEmailConfig;
  sendEmail?: (input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    logPrefix: "journal_email_send";
    metadata?: Record<string, unknown>;
  }) => Promise<EmailSendResult>;
};

type PublicJournalPost = {
  id: string;
  slug: string;
  title: string;
  category: string;
  status: string;
  publishedAt: Date | null;
  sentAt: Date | null;
};

export type RunDailyJournalAutopublishResult = {
  ok: boolean;
  status: string;
  skipped?: boolean;
  reason?: string;
  published: boolean;
  emailSent: boolean;
  recipientCount?: number;
  emailSkippedReason?: string | undefined;
  emailFailureCount?: number | undefined;
  requested: {
    mode: string;
    publish: boolean;
    sendEmail: boolean;
  };
  failedChecks: string[];
  warnings?: string[];
  post?: PublicJournalPost;
};

const publishedStatuses = ["PUBLISHED", "SENT"];
const defaultClient = prisma as unknown as JournalPostClient;

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char] || char);
}

function plainList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

function htmlParagraphs(items: string[]) {
  return items.map((item) => `<p>${escapeHtml(item)}</p>`).join("");
}

function htmlList(items: string[]) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function htmlLinkList(items: string[]) {
  return `<ul>${items.map((item) => `<li><a href="${escapeHtml(item)}">${escapeHtml(item)}</a></li>`).join("")}</ul>`;
}

function safeSlug(value: string | undefined, fallback: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || fallback;
}

function blogPostUrl(slug: string) {
  return `https://www.shipmastr.com/blog/${encodeURIComponent(slug)}/`;
}

function renderJournalEmailHtml(post: {
  headline: string;
  slug: string;
  category: string;
  homepageTeaser: string;
  dailyJournalUpdate: string[];
  howShipmastrHelps: string[];
  emailPreview: string;
}) {
  const update = post.dailyJournalUpdate.slice(0, 2);
  const helps = post.howShipmastrHelps.slice(0, 3);
  const fullUrl = blogPostUrl(post.slug);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(post.headline)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f2ea;color:#111827;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(post.emailPreview)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f2ea;margin:0;padding:0;width:100%;">
    <tr>
      <td align="center" style="padding:28px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;margin:0 auto;">
          <tr>
            <td style="padding:0 0 14px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="left" style="font-size:22px;line-height:28px;font-weight:800;letter-spacing:.02em;color:#101820;">
                    Shipmastr
                  </td>
                  <td align="right" style="font-size:12px;line-height:18px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#0b5c7a;">
                    Journal
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#fffdf8;border:1px solid #e7dfd2;border-radius:20px;padding:0;overflow:hidden;box-shadow:0 14px 36px rgba(17,24,39,.08);">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:34px 32px 24px 32px;border-bottom:1px solid #efe7da;">
                    <div style="display:inline-block;padding:8px 12px;border-radius:999px;background:#eaf3f4;color:#0b5c7a;font-size:12px;line-height:16px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;">${escapeHtml(post.category)}</div>
                    <h1 style="margin:18px 0 12px 0;color:#111827;font-size:36px;line-height:40px;font-weight:900;letter-spacing:-.02em;">${escapeHtml(post.headline)}</h1>
                    <p style="margin:0;color:#536073;font-size:16px;line-height:26px;">${escapeHtml(post.homepageTeaser)}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:26px 32px 10px 32px;">
                    <h2 style="margin:0 0 12px 0;color:#111827;font-size:18px;line-height:24px;font-weight:900;">Daily Journal Update</h2>
                    ${update.map((item) => `<p style="margin:0 0 14px 0;color:#344054;font-size:15px;line-height:24px;">${escapeHtml(item)}</p>`).join("")}
                  </td>
                </tr>
                <tr>
                  <td style="padding:10px 32px 12px 32px;">
                    <h2 style="margin:0 0 14px 0;color:#111827;font-size:18px;line-height:24px;font-weight:900;">How Shipmastr helps</h2>
                    ${helps.map((item) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px 0;background:#f8fafb;border:1px solid #e4edf0;border-radius:14px;"><tr><td style="padding:14px 16px;color:#1f2937;font-size:14px;line-height:22px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#0b5c7a;margin-right:8px;"></span>${escapeHtml(item)}</td></tr></table>`).join("")}
                  </td>
                </tr>
                <tr>
                  <td style="padding:18px 32px 34px 32px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;">
                      <tr>
                        <td style="border-radius:12px;background:#0b5c7a;">
                          <a href="${escapeHtml(fullUrl)}" style="display:inline-block;padding:14px 20px;color:#ffffff;text-decoration:none;font-size:15px;line-height:20px;font-weight:800;">Read full update</a>
                        </td>
                      </tr>
                    </table>
                    <a href="https://www.shipmastr.com/login/" style="color:#7a4b2a;text-decoration:underline;font-size:14px;line-height:22px;font-weight:800;">Build on Shipmastr</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 18px 0 18px;color:#7a8699;font-size:12px;line-height:19px;">
              <p style="margin:0 0 8px 0;">Shipmastr, [Registered address placeholder], India.</p>
              <p style="margin:0;">You are receiving Shipmastr Journal updates because you subscribed on Shipmastr. <a href="{{unsubscribeUrl}}" style="color:#0b5c7a;text-decoration:underline;">Unsubscribe</a></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function generateDailyJournalPost(now = new Date()): GeneratedJournalPost {
  const date = isoDate(now);
  const headline = "COD reconciliation before payout chaos";
  const slug = `cod-reconciliation-before-payout-chaos-${date}`;
  const category = "COD Cash Flow";
  const homepageTeaser = "Use COD reconciliation as an operating habit before seller payouts, courier deductions, and dispute queues drift apart.";
  const dailyJournalUpdate = [
    "COD orders create a second workflow after delivery: the shipment may be closed, but the money still has to match the courier invoice, remittance report, seller ledger, and dispute trail.",
    "A practical finance desk should reconcile by AWB first, then fall back to order IDs only when courier data is incomplete. That keeps every hold, deduction, and approval tied to the shipment that created it.",
    "The useful daily habit is simple: review COD pending, invoice mismatch, duplicate billing, and remittance delay together before approving seller payouts or courier payable batches."
  ];
  const howShipmastrHelps = [
    "Matches courier invoice lines and COD remittance rows against shipment-level AWB data.",
    "Separates approved courier payable from disputed, delayed, duplicate, and unknown-AWB amounts.",
    "Blocks seller settlement release when COD, shipment, or charge reconciliation is still unresolved.",
    "Keeps payment holds, maker-checker approvals, and dispute notes in the same finance ledger."
  ];
  const emailPreview = "Today’s Shipmastr Journal note: keep COD, courier invoices, disputes, and seller payouts tied to one ledger.";

  return {
    headline,
    slug,
    category,
    seoTitle: "COD Reconciliation Before Payout Chaos",
    metaDescription: "A daily Shipmastr Journal note on keeping COD, courier invoices, disputes, and seller payouts tied to one reconciliation ledger.",
    homepageTeaser,
    sourceNotes: [
      {
        title: "Shipmastr Journal operating notes",
        url: "https://www.shipmastr.com/blog/"
      },
      {
        title: "Shipmastr finance operations workspace",
        url: "https://www.shipmastr.com/seller/finance/"
      }
    ],
    dailyJournalUpdate,
    howShipmastrHelps,
    marketingAngle: "Position Shipmastr as the finance-ops control layer that lets sellers see COD risk and payout readiness before reconciliation becomes a manual spreadsheet chase.",
    organicBacklinkAngle: "Publish a COD reconciliation checklist and seller payout approval template that agencies, D2C operators, and finance teams can cite when building their own shipping playbook.",
    internalLinks: [
      "https://www.shipmastr.com/blog/",
      "https://www.shipmastr.com/seller/finance/",
      "https://www.shipmastr.com/login/"
    ],
    emailVersion: {
      subject: headline,
      previewText: emailPreview,
      plainTextBody: [
        "Daily Journal Update",
        "COD reconciliation should start at AWB level before payouts are released.",
        "",
        "How Shipmastr helps",
        "- AWB-first invoice and remittance matching",
        "- COD pending and dispute visibility",
        "- Payment holds before risky payout release",
        "",
        "CTA: Build on Shipmastr",
        "Unsubscribe: {{unsubscribeUrl}}"
      ].join("\n"),
      htmlBody: renderJournalEmailHtml({
        headline,
        slug,
        category,
        homepageTeaser,
        dailyJournalUpdate,
        howShipmastrHelps,
        emailPreview
      })
    }
  };
}

function renderBodyHtml(post: GeneratedJournalPost) {
  const sourceNotes = post.sourceNotes
    .map((note) => `<li><a href="${escapeHtml(note.url)}">${escapeHtml(note.title)}</a></li>`)
    .join("");

  return [
    `<h2>Daily Journal Update</h2>${htmlParagraphs(post.dailyJournalUpdate)}`,
    `<h2>How Shipmastr helps</h2>${htmlList(post.howShipmastrHelps)}`,
    `<h2>Marketing angle</h2><p>${escapeHtml(post.marketingAngle)}</p>`,
    `<h2>Organic backlink angle</h2><p>${escapeHtml(post.organicBacklinkAngle)}</p>`,
    `<h2>Source notes</h2><ul>${sourceNotes}</ul>`,
    `<h2>CTA</h2><p><a href="https://www.shipmastr.com/login/">Build on Shipmastr</a></p>`
  ].join("");
}

function renderBodyText(post: GeneratedJournalPost) {
  return [
    "Daily Journal Update",
    post.dailyJournalUpdate.join("\n\n"),
    "",
    "How Shipmastr helps",
    plainList(post.howShipmastrHelps),
    "",
    "Marketing angle",
    post.marketingAngle,
    "",
    "Organic backlink angle",
    post.organicBacklinkAngle,
    "",
    "Internal links",
    plainList(post.internalLinks),
    "",
    "CTA",
    "Build on Shipmastr"
  ].join("\n");
}

function storageData(post: GeneratedJournalPost, input: {
  status: "DRAFT" | "PUBLISHED" | "HELD" | "SENT";
  guardrailStatus: "PASS" | "FAIL";
  guardrailFailures: string[];
  now: Date;
}) {
  const fallbackSlug = `shipmastr-journal-${isoDate(input.now)}`;
  const slug = safeSlug(post.slug, fallbackSlug);
  const email = post.emailVersion || {
    subject: post.headline,
    previewText: post.homepageTeaser,
    plainTextBody: "",
    htmlBody: ""
  };

  return {
    slug,
    title: post.headline || "Shipmastr Journal draft",
    category: post.category || "Daily Journal",
    seoTitle: post.seoTitle || post.headline || "Shipmastr Journal",
    metaDescription: post.metaDescription || post.homepageTeaser || "",
    excerpt: post.homepageTeaser || post.metaDescription || "",
    bodyHtml: renderBodyHtml(post),
    bodyText: renderBodyText(post),
    sourceNotes: post.sourceNotes || [],
    homepageTeaser: post.homepageTeaser || "",
    emailSubject: email.subject || post.headline || "Shipmastr Journal",
    emailPreview: email.previewText || post.homepageTeaser || "",
    emailHtml: email.htmlBody || "",
    emailText: email.plainTextBody || "",
    status: input.status,
    guardrailStatus: input.guardrailStatus,
    guardrailFailures: input.guardrailFailures,
    metadata: post,
    publishedAt: input.status === "PUBLISHED" || input.status === "SENT" ? input.now : null,
    sentAt: input.status === "SENT" ? input.now : null
  };
}

function publicPost(record: JournalPostRecord): PublicJournalPost {
  return {
    id: record.id,
    slug: record.slug,
    title: record.title,
    category: record.category,
    status: record.status,
    publishedAt: record.publishedAt,
    sentAt: record.sentAt
  };
}

function metadataPost(record: JournalPostRecord): Partial<GeneratedJournalPost> {
  return record.metadata && typeof record.metadata === "object" ? record.metadata as Partial<GeneratedJournalPost> : {};
}

export function toClientArticle(record: JournalPostRecord) {
  const metadata = metadataPost(record);
  const dailyJournalUpdate = Array.isArray(metadata.dailyJournalUpdate) ? metadata.dailyJournalUpdate : [record.bodyText];
  const howShipmastrHelps = Array.isArray(metadata.howShipmastrHelps) ? metadata.howShipmastrHelps : [];
  const internalLinks = Array.isArray(metadata.internalLinks) ? metadata.internalLinks : [];
  const sourceNotes = Array.isArray(record.sourceNotes) ? record.sourceNotes : [];

  return {
    id: record.slug,
    slug: record.slug,
    icon: "SM",
    cat: record.category,
    category: record.category,
    cls: "t3",
    title: record.title,
    headline: record.title,
    excerpt: record.homepageTeaser || record.excerpt,
    homepageTeaser: record.homepageTeaser,
    time: "5 min",
    seoTitle: record.seoTitle,
    metaDescription: record.metaDescription,
    sourceNotes,
    body: dailyJournalUpdate,
    dailyJournalUpdate,
    howShipmastrHelps,
    marketingAngle: typeof metadata.marketingAngle === "string" ? metadata.marketingAngle : "",
    organicBacklinkAngle: typeof metadata.organicBacklinkAngle === "string" ? metadata.organicBacklinkAngle : "",
    internalLinks,
    emailVersion: metadata.emailVersion || {
      subject: record.emailSubject,
      previewText: record.emailPreview,
      plainTextBody: record.emailText,
      htmlBody: record.emailHtml
    },
    publishedAt: record.publishedAt
  };
}

async function loadPublishedRecords(client: JournalPostClient, limit: number) {
  return client.journalPost.findMany({
    where: { status: { in: publishedStatuses } },
    orderBy: [
      { publishedAt: "desc" },
      { createdAt: "desc" }
    ],
    take: limit
  });
}

export async function listPublishedJournalPosts(input: { limit?: number } = {}, client = defaultClient) {
  const records = await loadPublishedRecords(client, input.limit ?? 50);
  return records.map(toClientArticle);
}

async function defaultLoadSubscribers(): Promise<JournalSubscriber[]> {
  return activeNewsletterSubscribers();
}

function replaceUnsubscribeToken(value: string, unsubscribeUrl: string) {
  return value.replaceAll("{{unsubscribeUrl}}", unsubscribeUrl);
}

function safeEmailFailureCode(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{3,80}$/.test(message) ? message : fallback;
}

function safeOperationalFailureCode(error: unknown, fallback: string) {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  if (/^[A-Z0-9_]{3,80}$/.test(code)) return code;
  return safeEmailFailureCode(error, fallback);
}

function skippedDailyRun(input: {
  reason: string;
  requested: {
    mode: string;
    publish: boolean;
    sendEmail: boolean;
  };
  failedChecks?: string[];
}): RunDailyJournalAutopublishResult {
  return {
    ok: false,
    status: "SKIPPED",
    skipped: true,
    reason: input.reason,
    published: false,
    emailSent: false,
    requested: input.requested,
    failedChecks: input.failedChecks || [input.reason]
  };
}

function logJournalStoreFailure(error: unknown, stage: string) {
  logger.error(
    {
      message: "journal_daily_store_unavailable",
      journal: {
        stage,
        error: safeOperationalFailureCode(error, "JOURNAL_STORE_UNAVAILABLE")
      }
    },
    "journal_daily_store_unavailable"
  );
}

async function sendPostToSubscribers(post: GeneratedJournalPost, record: JournalPostRecord, deps: Required<Pick<JournalPostDependencies, "loadSubscribers" | "sendEmail" | "getEmailConfig">>): Promise<JournalEmailDelivery> {
  let subscribers: JournalSubscriber[];
  try {
    subscribers = await deps.loadSubscribers();
  } catch (error) {
    logger.warn(
      {
        message: "journal_email_subscriber_load_failed",
        journalEmail: {
          postId: record.id,
          slug: record.slug,
          error: safeEmailFailureCode(error, "NEWSLETTER_SUBSCRIBER_LOAD_FAILED")
        }
      },
      "journal_email_subscriber_load_failed"
    );

    return {
      emailSent: false,
      recipientCount: 0,
      skippedReason: "NEWSLETTER_SUBSCRIBER_LOAD_FAILED",
      emailFailureCount: 1,
      results: []
    };
  }

  logger.info(
    {
      message: "journal_email_recipient_count",
      journalEmail: {
        postId: record.id,
        slug: record.slug,
        recipientCount: subscribers.length
      }
    },
    "journal_email_recipient_count"
  );

  if (subscribers.length === 0) {
    return {
      emailSent: false,
      recipientCount: 0,
      skippedReason: "NO_ACTIVE_SUBSCRIBERS",
      results: [] as EmailSendResult[]
    };
  }

  let config: Awaited<ReturnType<typeof getJournalEmailConfig>>;
  try {
    config = await deps.getEmailConfig();
  } catch (error) {
    logger.warn(
      {
        message: "journal_email_config_unavailable",
        journalEmail: {
          postId: record.id,
          slug: record.slug,
          recipientCount: subscribers.length,
          error: safeEmailFailureCode(error, "JOURNAL_EMAIL_CONFIG_UNAVAILABLE")
        }
      },
      "journal_email_config_unavailable"
    );

    return {
      emailSent: false,
      recipientCount: subscribers.length,
      skippedReason: "JOURNAL_EMAIL_CONFIG_UNAVAILABLE",
      emailFailureCount: 1,
      results: []
    };
  }

  if (!config.ready) {
    return {
      emailSent: false,
      recipientCount: subscribers.length,
      skippedReason: "JOURNAL_EMAIL_NOT_READY",
      results: [] as EmailSendResult[]
    };
  }

  const results: EmailSendResult[] = [];
  let emailFailureCount = 0;
  for (const subscriber of subscribers) {
    try {
      const result = await deps.sendEmail({
        to: subscriber.email,
        subject: post.emailVersion.subject,
        text: replaceUnsubscribeToken(post.emailVersion.plainTextBody, subscriber.unsubscribeUrl),
        html: replaceUnsubscribeToken(post.emailVersion.htmlBody, subscriber.unsubscribeUrl),
        logPrefix: "journal_email_send",
        metadata: {
          source: "journal-daily-autopublish",
          postId: record.id,
          slug: record.slug,
          subscriberId: subscriber.id
        }
      });
      results.push(result);
    } catch (error) {
      emailFailureCount += 1;
      logger.warn(
        {
          message: "journal_email_send_failed",
          journalEmail: {
            postId: record.id,
            slug: record.slug,
            subscriberId: subscriber.id,
            error: safeEmailFailureCode(error, "JOURNAL_EMAIL_SEND_FAILED")
          }
        },
        "journal_email_send_failed"
      );
    }
  }

  const sentCount = results.length;
  return {
    emailSent: sentCount > 0,
    recipientCount: subscribers.length,
    ...(emailFailureCount > 0 ? { emailFailureCount } : {}),
    ...(sentCount === 0 && emailFailureCount > 0 ? { skippedReason: "JOURNAL_EMAIL_SEND_FAILED" } : {}),
    ...(sentCount > 0 && emailFailureCount > 0 ? { skippedReason: "JOURNAL_EMAIL_SEND_PARTIAL_FAILURE" } : {}),
    results
  };
}

function configuredStoreMode(deps: JournalPostDependencies) {
  return deps.storeMode || env.JOURNAL_AUTOPUBLISH_STORE;
}

function storeReady(mode: string) {
  return mode === "postgres" || mode === "db";
}

export async function runDailyJournalAutopublish(options: RunDailyOptions = {}, deps: JournalPostDependencies = {}): Promise<RunDailyJournalAutopublishResult> {
  const storeMode = configuredStoreMode(deps);
  const now = options.now || new Date();
  const requested = {
    mode: options.mode || "auto",
    publish: Boolean(options.publish),
    sendEmail: Boolean(options.sendEmail)
  };

  if (!storeReady(storeMode)) {
    return skippedDailyRun({
      reason: "JOURNAL_AUTOPUBLISH_STORE_NOT_CONFIGURED",
      requested,
      failedChecks: ["JOURNAL_AUTOPUBLISH_STORE_NOT_CONFIGURED"]
    });
  }

  const client = deps.client || defaultClient;
  const post = options.post || generateDailyJournalPost(now);
  const validation = validateJournalPost(post);

  if (!validation.pass) {
    let held: JournalPostRecord;
    try {
      held = await client.journalPost.create({
        data: storageData(post, {
          status: "HELD",
          guardrailStatus: "FAIL",
          guardrailFailures: validation.failedChecks,
          now
        })
      });
    } catch (error) {
      logJournalStoreFailure(error, "guardrail_hold_create");
      return skippedDailyRun({
        reason: "JOURNAL_STORE_UNAVAILABLE",
        requested,
        failedChecks: ["JOURNAL_STORE_UNAVAILABLE"]
      });
    }

    logger.warn(
      {
        message: "journal_daily_held",
        journal: {
          postId: held.id,
          slug: held.slug,
          failedChecks: validation.failedChecks
        }
      },
      "journal_daily_held"
    );

    return {
      ok: false,
      status: "GUARDRAIL_HOLD",
      reason: "JOURNAL_GUARDRAIL_FAILED",
      published: false,
      emailSent: false,
      requested,
      failedChecks: validation.failedChecks,
      post: publicPost(held)
    };
  }

  if (!options.publish) {
    let draft: JournalPostRecord;
    try {
      draft = await client.journalPost.upsert({
        where: { slug: safeSlug(post.slug, `shipmastr-journal-${isoDate(now)}`) },
        create: storageData(post, {
          status: "DRAFT",
          guardrailStatus: "PASS",
          guardrailFailures: [],
          now
        }),
        update: storageData(post, {
          status: "DRAFT",
          guardrailStatus: "PASS",
          guardrailFailures: [],
          now
        })
      });
    } catch (error) {
      logJournalStoreFailure(error, "draft_upsert");
      return skippedDailyRun({
        reason: "JOURNAL_STORE_UNAVAILABLE",
        requested,
        failedChecks: ["JOURNAL_STORE_UNAVAILABLE"]
      });
    }

    return {
      ok: true,
      status: "DRAFT_SAVED",
      reason: "PUBLISH_FALSE",
      published: false,
      emailSent: false,
      requested,
      failedChecks: [],
      post: publicPost(draft)
    };
  }

  let published: JournalPostRecord;
  try {
    published = await client.journalPost.upsert({
      where: { slug: safeSlug(post.slug, `shipmastr-journal-${isoDate(now)}`) },
      create: storageData(post, {
        status: "PUBLISHED",
        guardrailStatus: "PASS",
        guardrailFailures: [],
        now
      }),
      update: storageData(post, {
        status: "PUBLISHED",
        guardrailStatus: "PASS",
        guardrailFailures: [],
        now
      })
    });
  } catch (error) {
    logJournalStoreFailure(error, "publish_upsert");
    return skippedDailyRun({
      reason: "JOURNAL_STORE_UNAVAILABLE",
      requested,
      failedChecks: ["JOURNAL_STORE_UNAVAILABLE"]
    });
  }

  logger.info(
    {
      message: "journal_daily_published",
      journal: {
        postId: published.id,
        slug: published.slug,
        title: published.title
      }
    },
    "journal_daily_published"
  );

  const email = options.sendEmail
    ? await sendPostToSubscribers(post, published, {
      loadSubscribers: deps.loadSubscribers || defaultLoadSubscribers,
      getEmailConfig: deps.getEmailConfig || getJournalEmailConfig,
      sendEmail: deps.sendEmail || sendJournalEmail
    })
    : {
      emailSent: false,
      recipientCount: 0,
      skippedReason: "SEND_EMAIL_FALSE",
      results: [] as EmailSendResult[]
    };

  let sentAtUpdateWarning: string | undefined;
  if (email.emailSent) {
    try {
      await client.journalPost.update({
        where: { id: published.id },
        data: {
          sentAt: now
        }
      });
    } catch (error) {
      sentAtUpdateWarning = "JOURNAL_SENT_AT_UPDATE_FAILED";
      logger.warn(
        {
          message: "journal_sent_at_update_failed",
          journal: {
            postId: published.id,
            slug: published.slug,
            error: safeOperationalFailureCode(error, "JOURNAL_SENT_AT_UPDATE_FAILED")
          }
        },
        "journal_sent_at_update_failed"
      );
    }
  }

  return {
    ok: true,
    status: "PUBLISHED",
    reason: "GUARDRAILS_PASSED",
    published: true,
    emailSent: email.emailSent,
    recipientCount: email.recipientCount,
    emailSkippedReason: "skippedReason" in email ? email.skippedReason : undefined,
    emailFailureCount: email.emailFailureCount,
    warnings: sentAtUpdateWarning ? [sentAtUpdateWarning] : [],
    requested,
    failedChecks: [],
    post: publicPost(published)
  };
}

export async function publishJournalPost(post: GeneratedJournalPost, deps: JournalPostDependencies = {}) {
  return runDailyJournalAutopublish({
    publish: true,
    sendEmail: false,
    post
  }, deps);
}

export async function rollbackLastPublishedJournalPost(deps: JournalPostDependencies = {}) {
  const storeMode = configuredStoreMode(deps);
  if (!storeReady(storeMode)) {
    return {
      ok: false,
      error: "JOURNAL_AUTOPUBLISH_STORE_NOT_CONFIGURED"
    };
  }

  const client = deps.client || defaultClient;
  const latest = await client.journalPost.findFirst({
    where: { status: { in: publishedStatuses } },
    orderBy: [
      { publishedAt: "desc" },
      { createdAt: "desc" }
    ]
  });

  if (!latest) {
    return {
      ok: false,
      error: "NO_PUBLISHED_JOURNAL_POST"
    };
  }

  const rolledBack = await client.journalPost.update({
    where: { id: latest.id },
    data: {
      status: "DRAFT",
      publishedAt: null
    }
  });

  return {
    ok: true,
    status: "ROLLED_BACK",
    post: publicPost(rolledBack)
  };
}
