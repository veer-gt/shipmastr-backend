export const DOMAIN_EMAIL_TEMPLATE_KEYS = [
  "DOMAIN_REQUEST_RECEIVED",
  "DOMAIN_SETUP_STARTED",
  "DOMAIN_PAYMENT_RECEIVED",
  "DOMAIN_REGISTRATION_STARTED",
  "DOMAIN_REGISTERED",
  "DOMAIN_RENEWAL_REMINDER",
  "DOMAIN_EKYC_PENDING",
  "DOMAIN_VERIFICATION_REQUIRED",
  "DOMAIN_LIVE",
  "DOMAIN_SETUP_NEEDS_SUPPORT"
] as const;

export type DomainEmailTemplateKey = (typeof DOMAIN_EMAIL_TEMPLATE_KEYS)[number];
export type DomainOrderActionType = "Registration" | "Renewal";

export type DomainEmailInput = {
  domain: string;
  years: number;
  actionType: DomainOrderActionType;
  merchantName?: string | null;
};

export type DomainEmailTemplate = {
  templateKey: DomainEmailTemplateKey;
  fromName: string;
  fromAddress: string;
  from: string;
  subject: string;
  nextAction: string;
  text: string;
  html: string;
};

export type DomainAdminDiagnosticsEmailInput = {
  domain: string;
  providerName: string;
  providerStatus: string;
  internalSummary: string;
};

export type DomainAdminDiagnosticsEmail = {
  audience: "admin";
  subject: string;
  text: string;
  html: string;
};

type DomainEmailEnv = {
  DOMAIN_EMAIL_FROM_NAME?: string | undefined;
  DOMAIN_EMAIL_FROM_ADDRESS?: string | undefined;
};

const DEFAULT_DOMAIN_EMAIL_FROM_NAME = "Shipmastr";
const DEFAULT_DOMAIN_EMAIL_FROM_ADDRESS = "noreply@shipmastr.com";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeYears(years: number) {
  if (!Number.isInteger(years) || years < 1) {
    throw new Error("DOMAIN_EMAIL_INVALID_YEARS");
  }
  return years;
}

function normalizeDomainForEmail(domain: string) {
  const normalized = String(domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!normalized || !/^[a-z0-9.-]+$/.test(normalized) || normalized.includes("..")) {
    throw new Error("DOMAIN_EMAIL_INVALID_DOMAIN");
  }
  return normalized;
}

export function getDomainEmailSenderConfig(source: DomainEmailEnv = process.env) {
  const fromName = String(source.DOMAIN_EMAIL_FROM_NAME || DEFAULT_DOMAIN_EMAIL_FROM_NAME).trim() || DEFAULT_DOMAIN_EMAIL_FROM_NAME;
  const fromAddress = String(source.DOMAIN_EMAIL_FROM_ADDRESS || DEFAULT_DOMAIN_EMAIL_FROM_ADDRESS).trim() || DEFAULT_DOMAIN_EMAIL_FROM_ADDRESS;

  return {
    fromName,
    fromAddress,
    from: `${fromName} <${fromAddress}>`
  };
}

export function buildDomainOrderSubject(domain: string, years: number, _actionType: DomainOrderActionType) {
  const normalizedDomain = normalizeDomainForEmail(domain);
  const normalizedYears = normalizeYears(years);
  const yearLabel = normalizedYears === 1 ? "year" : "years";

  return `New Domain Order - Registration/Renewal of ${normalizedDomain} for ${normalizedYears} ${yearLabel}`;
}

function merchantGreeting(merchantName?: string | null) {
  const safeName = String(merchantName || "").trim();
  return safeName ? `Hi ${safeName},` : "Hi,";
}

function buildBody(
  templateKey: DomainEmailTemplateKey,
  input: {
    domain: string;
    years: number;
    actionType: DomainOrderActionType;
    merchantName?: string | null | undefined;
  }
) {
  const domain = input.domain;
  const yearLabel = input.years === 1 ? "year" : "years";
  const duration = `${input.years} ${yearLabel}`;
  const greeting = merchantGreeting(input.merchantName);

  switch (templateKey) {
    case "DOMAIN_REQUEST_RECEIVED": {
      const nextAction = "Next: Shipmastr will review your request and guide you through connecting this domain.";
      return {
        nextAction,
        lines: [
          greeting,
          `We received your domain setup request for ${domain}.`,
          "Shipmastr will guide you through connecting this domain.",
          nextAction
        ]
      };
    }
    case "DOMAIN_SETUP_STARTED": {
      const nextAction = "Next: follow any Shipmastr instructions for domain verification or connection records.";
      return {
        nextAction,
        lines: [
          greeting,
          `Shipmastr has started domain setup for ${domain}.`,
          "We will keep the setup calm and guided from here.",
          nextAction
        ]
      };
    }
    case "DOMAIN_PAYMENT_RECEIVED": {
      const nextAction = "Next: Shipmastr is preparing your domain order. We will email you when setup begins.";
      return {
        nextAction,
        lines: [
          greeting,
          `Thanks, we received your payment for ${domain} for ${duration}.`,
          nextAction
        ]
      };
    }
    case "DOMAIN_REGISTRATION_STARTED": {
      const nextAction = "Next: complete any domain verification email you receive. We will continue setup as soon as verification is complete.";
      return {
        nextAction,
        lines: [
          greeting,
          `Shipmastr has started setup for ${domain} for ${duration}.`,
          "You may receive a verification email from our domain verification partner. Please complete it to activate your domain.",
          nextAction
        ]
      };
    }
    case "DOMAIN_REGISTERED": {
      const nextAction = "Next: watch for any domain registry verification email, then Shipmastr will finish connecting your storefront.";
      return {
        nextAction,
        lines: [
          greeting,
          `${domain} is registered for ${duration}.`,
          "You may receive a verification email from our domain verification partner. Please complete it to activate your domain.",
          nextAction
        ]
      };
    }
    case "DOMAIN_RENEWAL_REMINDER": {
      const nextAction = "Next: keep your billing details active so Shipmastr can renew the domain without interruption.";
      return {
        nextAction,
        lines: [
          greeting,
          `${domain} is coming up for renewal for ${duration}.`,
          "Renewing on time keeps your storefront reachable for customers.",
          nextAction
        ]
      };
    }
    case "DOMAIN_EKYC_PENDING": {
      const nextAction = "Next: complete the verification request if you receive one. We will resume setup when the review is complete.";
      return {
        nextAction,
        lines: [
          greeting,
          `${domain} is waiting on domain registry verification.`,
          "You may receive a verification email from our domain verification partner. Please complete it to activate your domain.",
          nextAction
        ]
      };
    }
    case "DOMAIN_VERIFICATION_REQUIRED": {
      const nextAction = "Next: open the verification email and complete the requested confirmation.";
      return {
        nextAction,
        lines: [
          greeting,
          `${domain} needs domain registry verification before it can go live with your storefront.`,
          "You may receive a verification email from our domain verification partner. Please complete it to activate your domain.",
          nextAction
        ]
      };
    }
    case "DOMAIN_LIVE": {
      const nextAction = "Next: share the domain with your customers and keep your storefront details updated in Shipmastr.";
      return {
        nextAction,
        lines: [
          greeting,
          `${domain} is now live with your Shipmastr storefront.`,
          "Your customers can use the domain to reach your store.",
          nextAction
        ]
      };
    }
    case "DOMAIN_SETUP_NEEDS_SUPPORT": {
      const nextAction = "Next: Shipmastr support will review the setup and share the safest next step.";
      return {
        nextAction,
        lines: [
          greeting,
          `${domain} needs support before setup can continue.`,
          "Your storefront and account remain safe while we review the connection.",
          nextAction
        ]
      };
    }
  }
}

export function buildDomainEmailTemplate(
  templateKey: DomainEmailTemplateKey,
  input: DomainEmailInput,
  source: DomainEmailEnv = process.env
): DomainEmailTemplate {
  if (!DOMAIN_EMAIL_TEMPLATE_KEYS.includes(templateKey)) {
    throw new Error("DOMAIN_EMAIL_UNKNOWN_TEMPLATE");
  }

  const domain = normalizeDomainForEmail(input.domain);
  const years = normalizeYears(input.years);
  const actionType = input.actionType;
  const sender = getDomainEmailSenderConfig(source);
  const subject = buildDomainOrderSubject(domain, years, actionType);
  const body = buildBody(templateKey, {
    domain,
    years,
    actionType,
    merchantName: input.merchantName
  });

  return {
    templateKey,
    ...sender,
    subject,
    nextAction: body.nextAction,
    text: body.lines.join("\n"),
    html: body.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")
  };
}

export function buildDomainAdminDiagnosticsTemplate(input: DomainAdminDiagnosticsEmailInput): DomainAdminDiagnosticsEmail {
  const domain = normalizeDomainForEmail(input.domain);
  const providerName = String(input.providerName || "").trim() || "provider";
  const providerStatus = String(input.providerStatus || "").trim() || "unknown";
  const internalSummary = String(input.internalSummary || "").trim() || "No internal summary provided.";
  const lines = [
    `Domain diagnostics for ${domain}`,
    `Provider: ${providerName}`,
    `Provider status: ${providerStatus}`,
    `Internal summary: ${internalSummary}`
  ];

  return {
    audience: "admin",
    subject: `Internal domain diagnostics - ${domain}`,
    text: lines.join("\n"),
    html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")
  };
}
