import { HttpError } from "../../lib/httpError.js";

const DOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BLOCKED_DOMAINS = new Set([
  "shipmastr.com",
  "www.shipmastr.com",
  "api.shipmastr.com",
  "admin.shipmastr.com",
  "seller.shipmastr.com",
  "courier.shipmastr.com",
  "shipmastr.in",
  "www.shipmastr.in",
  "shipmastr.co.in",
  "www.shipmastr.co.in",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1"
]);

const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const KNOWN_SECOND_LEVEL_TLDS = new Set(["co.in"]);

export type DomainPrice = {
  registrationPaise: number;
  renewalPaise: number;
  currency: string;
};

export function normalizeDomain(input: string) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) throw new HttpError(400, "DOMAIN_REQUIRED");

  const withoutProtocol = raw.replace(/^https?:\/\//, "");
  const withoutPath = withoutProtocol.split(/[/?#]/)[0] || "";
  const withoutPort = withoutPath.replace(/:\d{1,5}$/, "");
  const domain = withoutPort.replace(/\.$/, "").replace(/^www\./, "");

  if (!domain || domain.length > 253 || domain.includes("..")) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  if (
    BLOCKED_DOMAINS.has(domain) ||
    IPV4_REGEX.test(domain) ||
    domain === "run.app" ||
    domain.endsWith(".run.app") ||
    domain.endsWith(".shipmastr.com") ||
    domain.endsWith(".shipmastr.in")
  ) {
    throw new HttpError(400, "DOMAIN_RESERVED_FOR_SHIPMASTR");
  }

  const labels = domain.split(".");
  if (labels.length < 2) throw new HttpError(400, "INVALID_DOMAIN");
  if (labels.some((label) => !DOMAIN_LABEL_REGEX.test(label))) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  const tld = labels.slice(1).join(".");
  if (tld.length < 2 || /^\d+$/.test(labels[labels.length - 1] || "")) throw new HttpError(400, "INVALID_DOMAIN");

  return {
    domain,
    normalizedDomain: domain,
    tld
  };
}

function normalizeDomainBase(input: string, options: { stripWww: boolean }) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) throw new HttpError(400, "DOMAIN_REQUIRED");

  const withoutProtocol = raw.replace(/^https?:\/\//, "");
  const withoutPath = withoutProtocol.split(/[/?#]/)[0] || "";
  const withoutPort = withoutPath.replace(/:\d{1,5}$/, "");
  let domain = withoutPort.replace(/\.$/, "");
  if (options.stripWww) domain = domain.replace(/^www\./, "");

  if (!domain || domain.length > 253 || domain.includes("..")) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  if (
    BLOCKED_DOMAINS.has(domain) ||
    IPV4_REGEX.test(domain) ||
    domain === "run.app" ||
    domain.endsWith(".run.app") ||
    domain.endsWith(".shipmastr.com") ||
    domain.endsWith(".shipmastr.in") ||
    domain.endsWith(".shipmastr.co.in")
  ) {
    throw new HttpError(400, "DOMAIN_RESERVED_FOR_SHIPMASTR");
  }

  const labels = domain.split(".");
  if (labels.length < 2) throw new HttpError(400, "INVALID_DOMAIN");
  if (labels.some((label) => !DOMAIN_LABEL_REGEX.test(label))) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  const possibleSecondLevelTld = labels.slice(-2).join(".");
  const tld = KNOWN_SECOND_LEVEL_TLDS.has(possibleSecondLevelTld)
    ? possibleSecondLevelTld
    : labels[labels.length - 1] || "";
  if (tld.length < 2 || /^\d+$/.test(labels[labels.length - 1] || "")) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  const apexLabelCount = KNOWN_SECOND_LEVEL_TLDS.has(tld) ? 3 : 2;
  const isApex = labels.length === apexLabelCount;

  return {
    domain,
    normalizedDomain: domain,
    tld,
    isApex
  };
}

export function normalizeMerchantDomainRequestDomain(input: string, options: { allowApex?: boolean } = {}) {
  const normalized = normalizeDomainBase(input, { stripWww: false });
  if (normalized.isApex && !options.allowApex) {
    throw new HttpError(409, "APEX_DOMAIN_REQUEST_REQUIRES_ADMIN_REVIEW");
  }
  return normalized;
}

export function formatDomainSafeMessage(domain: string, available?: boolean) {
  if (available === true) return `${domain} is available`;
  if (available === false) return `${domain} is not available`;
  return "Domain status is being checked";
}

export function fallbackPriceForTld(tld: string): DomainPrice {
  const normalizedTld = tld.toLowerCase();
  if (normalizedTld === "in" || normalizedTld === "co.in") {
    return { registrationPaise: 79900, renewalPaise: 99900, currency: "INR" };
  }

  if (normalizedTld === "com") {
    return { registrationPaise: 119900, renewalPaise: 139900, currency: "INR" };
  }

  return { registrationPaise: 99900, renewalPaise: 129900, currency: "INR" };
}

export function merchantDomainStatusLabel(status: string) {
  switch (status) {
    case "PAYMENT_REQUIRED":
      return "Payment required";
    case "REGISTERING":
      return "Registering";
    case "REGISTERED":
      return "Domain registered";
    case "DNS_PENDING":
    case "CLOUDFLARE_PENDING":
      return "DNS connecting";
    case "SSL_PENDING":
      return "SSL pending";
    case "ACTIVE":
      return "Store live";
    case "FAILED":
      return "Needs support";
    case "RENEWAL_DUE":
      return "Renewal due";
    default:
      return "Setup pending";
  }
}

export function redactProviderSecrets<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactProviderSecrets(item)) as T;

  const redacted = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const key of Object.keys(redacted)) {
    if (/api[-_]?key|auth[-_]?user(?:id)?|token|secret|password|credential/i.test(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = redactProviderSecrets(redacted[key]);
    }
  }
  return redacted as T;
}
