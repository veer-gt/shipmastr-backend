import { resolveCname, resolveTxt } from "node:dns/promises";

import { env } from "../../config/env.js";
import { getExpectedJournalAdminToken, getJournalAdminAuthDebug } from "./journal-auth.js";

const expectedFromEmail = "blog@shipmastr.com";
const expectedFromName = "Shipmastr";
const expectedSender = `${expectedFromName} <${expectedFromEmail}>`;
const requiredSpfInclude = "include:_spf.google.com";
const requiredDmarcRua = `rua=mailto:${expectedFromEmail}`;

type SenderParts = {
  name: string;
  email: string;
};

function parseAddress(identity: string): SenderParts {
  const bracketMatch = identity.match(/^(.+?)\s*<([^<>@\s]+@[^<>\s]+)>$/);
  if (bracketMatch) {
    return {
      name: bracketMatch[1]?.replace(/^"|"$/g, "").trim() || "",
      email: bracketMatch[2]?.trim().toLowerCase() || ""
    };
  }

  const emailMatch = identity.match(/([^@\s<>]+@[^@\s<>]+)/);
  return {
    name: "",
    email: emailMatch?.[1]?.trim().toLowerCase() || ""
  };
}

export function journalSenderIdentity() {
  if (env.EMAIL_FROM) {
    return `${env.EMAIL_FROM_NAME || expectedFromName} <${env.EMAIL_FROM}>`;
  }

  return env.JOURNAL_EMAIL_FROM || env.SMTP_FROM || expectedSender;
}

function emailDomain() {
  const sender = parseAddress(journalSenderIdentity());
  return sender.email.split("@")[1] || "shipmastr.com";
}

function configuredDkimSelectors() {
  return env.EMAIL_DKIM_SELECTORS.split(",")
    .map((selector) => selector.trim())
    .filter(Boolean);
}

async function txtValues(host: string) {
  try {
    return (await resolveTxt(host)).map((record) => record.join(""));
  } catch {
    return [];
  }
}

async function cnameExists(host: string) {
  try {
    return (await resolveCname(host)).length > 0;
  } catch {
    return false;
  }
}

export async function verifyJournalDomainAuth() {
  const domain = emailDomain();
  const selectors = configuredDkimSelectors();
  const [domainTxt, dmarcTxt, dkimChecks] = await Promise.all([
    txtValues(domain),
    txtValues(`_dmarc.${domain}`),
    Promise.all(
      selectors.map(async (selector) => {
        const host = `${selector}._domainkey.${domain}`;
        const [txt, cname] = await Promise.all([txtValues(host), cnameExists(host)]);
        return {
          selector,
          found: txt.some((record) => /v=DKIM1/i.test(record)) || cname
        };
      })
    )
  ]);

  const spfRecords = domainTxt.filter((record) => /v=spf1/i.test(record));
  const dmarcRecords = dmarcTxt.filter((record) => /v=DMARC1/i.test(record));

  return {
    domain,
    spf: spfRecords.some((record) => record.toLowerCase().includes(requiredSpfInclude)),
    dkim: dkimChecks.some((check) => check.found),
    dmarc: dmarcRecords.some((record) => record.toLowerCase().includes(requiredDmarcRua)),
    dkimSelectorsChecked: selectors,
    required: {
      spfInclude: requiredSpfInclude,
      dmarcRua: requiredDmarcRua
    }
  };
}

function providerMissing() {
  const missing: string[] = [];

  if (env.JOURNAL_EMAIL_PROVIDER !== "smtp") {
    missing.push("JOURNAL_EMAIL_PROVIDER=smtp");
  }

  if (!env.SMTP_HOST) missing.push("SMTP_HOST");
  if (!env.SMTP_USER) missing.push("SMTP_USER");
  if (env.SMTP_USER && env.SMTP_USER.toLowerCase() !== expectedFromEmail) {
    missing.push(`SMTP_USER=${expectedFromEmail}`);
  }
  if (!env.SMTP_PASS) missing.push("SMTP_PASS");

  return missing;
}

export async function getJournalEmailConfig() {
  const sender = journalSenderIdentity();
  const senderParts = parseAddress(sender);
  const domainAuth = await verifyJournalDomainAuth();
  const missing: string[] = [];

  if (sender !== expectedSender) {
    missing.push(`EMAIL_FROM=${expectedFromEmail}`);
    missing.push(`EMAIL_FROM_NAME=${expectedFromName}`);
  }

  if (!env.JOURNAL_EMAIL_LIVE_SEND) missing.push("JOURNAL_EMAIL_LIVE_SEND=true");
  if (!env.EMAIL_SPF_VERIFIED) missing.push("EMAIL_SPF_VERIFIED=true");
  if (!env.EMAIL_DKIM_VERIFIED) missing.push("EMAIL_DKIM_VERIFIED=true");
  if (!env.EMAIL_DMARC_VERIFIED) missing.push("EMAIL_DMARC_VERIFIED=true");
  if (!env.NEWSLETTER_SECRET || env.NEWSLETTER_SECRET.length < 16) missing.push("NEWSLETTER_SECRET");
  if (!getExpectedJournalAdminToken()) missing.push("JOURNAL_ADMIN_TOKEN");
  missing.push(...providerMissing());

  if (!domainAuth.spf) missing.push(`SPF TXT for ${domainAuth.domain}`);
  if (!domainAuth.dkim) missing.push(`DKIM TXT/CNAME for ${domainAuth.domain}`);
  if (!domainAuth.dmarc) missing.push(`DMARC TXT for _dmarc.${domainAuth.domain}`);

  return {
    ready: missing.length === 0,
    provider: env.JOURNAL_EMAIL_PROVIDER,
    autopublishStore: env.JOURNAL_AUTOPUBLISH_STORE,
    sender,
    senderParts,
    envFlags: {
      spf: env.EMAIL_SPF_VERIFIED,
      dkim: env.EMAIL_DKIM_VERIFIED,
      dmarc: env.EMAIL_DMARC_VERIFIED
    },
    smtp: {
      host: Boolean(env.SMTP_HOST),
      port: env.SMTP_PORT || null,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER || null,
      passConfigured: Boolean(env.SMTP_PASS),
      from: env.SMTP_FROM || null,
      replyTo: env.SMTP_REPLY_TO || null
    },
    secrets: {
      newsletterSecret: Boolean(env.NEWSLETTER_SECRET),
      journalAdminToken: getExpectedJournalAdminToken().length > 0
    },
    domainAuth,
    ...getJournalAdminAuthDebug(),
    missing: Array.from(new Set(missing))
  };
}
