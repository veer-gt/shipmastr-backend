const urlSafeSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const backlinkHooks = ["checklist", "template", "calculator", "glossary", "playbook", "comparison"];
const certaintyPatterns = [
  /\bguarantee(?:d|s)?\b/i,
  /\brisk[- ]free\b/i,
  /\blegally (?:required|compliant|binding|guaranteed)\b/i,
  /\bfinancially (?:certain|guaranteed|risk[- ]free)\b/i,
  /\bwill always\b/i,
  /\bnever fail(?:s)?\b/i
];
const defamatoryPatterns = [
  /\b(?:scam|fraud|cheat|criminal|illegal|corrupt)\b/i,
  /\b(?:worst|fake|dishonest)\s+(?:courier|company|competitor|platform)\b/i
];

type JournalPost = {
  headline?: string;
  slug?: string;
  category?: string;
  seoTitle?: string;
  metaDescription?: string;
  homepageTeaser?: string;
  sourceNotes?: Array<{ title?: string; url?: string }>;
  dailyJournalUpdate?: string[];
  howShipmastrHelps?: string[];
  marketingAngle?: string;
  organicBacklinkAngle?: string;
  internalLinks?: string[];
  emailVersion?: {
    subject?: string;
    previewText?: string;
    plainTextBody?: string;
    htmlBody?: string;
  };
};

function textParts(post: JournalPost) {
  const email = post.emailVersion || {};
  return [
    post.headline,
    post.category,
    post.seoTitle,
    post.metaDescription,
    post.homepageTeaser,
    ...(post.dailyJournalUpdate || []),
    ...(post.howShipmastrHelps || []),
    post.marketingAngle,
    post.organicBacklinkAngle,
    ...(post.internalLinks || []),
    email.subject,
    email.previewText,
    email.plainTextBody,
    email.htmlBody
  ].filter(Boolean);
}

function hasCredibleSources(post: JournalPost) {
  return Array.isArray(post.sourceNotes)
    && post.sourceNotes.length > 0
    && post.sourceNotes.every((note) => note.title && /^https:\/\/.+/i.test(note.url || ""));
}

export function validateJournalPost(post: JournalPost) {
  const failedChecks: string[] = [];
  const allText = textParts(post).join("\n");

  if (!post.headline || !post.slug || !post.category || !post.seoTitle || !post.metaDescription) {
    failedChecks.push("headline, slug, category, SEO title, and meta description are required");
  }
  if (!hasCredibleSources(post)) failedChecks.push("credible source notes included");
  if (certaintyPatterns.some((pattern) => pattern.test(allText))) failedChecks.push("no legal/financial certainty claims");
  if (defamatoryPatterns.some((pattern) => pattern.test(allText))) failedChecks.push("no defamatory competitor wording");
  if ((post.seoTitle || "").length > 60) failedChecks.push("SEO title <= 60 chars");
  if ((post.metaDescription || "").length > 160) failedChecks.push("meta description <= 160 chars");
  if (!urlSafeSlug.test(post.slug || "")) failedChecks.push("slug lowercase URL-safe");
  if (!Array.isArray(post.dailyJournalUpdate) || post.dailyJournalUpdate.length === 0) {
    failedChecks.push("Daily Journal Update section present");
  }
  if (!Array.isArray(post.howShipmastrHelps) || post.howShipmastrHelps.length < 3 || post.howShipmastrHelps.length > 5) {
    failedChecks.push("How Shipmastr helps has 3-5 concrete product-led points");
  }
  const backlinkAngle = String(post.organicBacklinkAngle || "").toLowerCase();
  if (!backlinkHooks.some((hook) => backlinkAngle.includes(hook))) {
    failedChecks.push("Organic backlink angle includes checklist/template/calculator/glossary/playbook/comparison hook");
  }
  const email = post.emailVersion || {};
  if (!String(email.plainTextBody || "").includes("{{unsubscribeUrl}}") && !String(email.htmlBody || "").includes("{{unsubscribeUrl}}")) {
    failedChecks.push("unsubscribe link present in email");
  }
  if (!email.subject || /newsletter/i.test(email.subject)) {
    failedChecks.push("email subject must be the daily topic, not generic newsletter text");
  }

  return {
    pass: failedChecks.length === 0,
    failedChecks
  };
}
