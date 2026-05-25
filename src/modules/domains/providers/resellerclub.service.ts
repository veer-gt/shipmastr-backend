import { env } from "../../../config/env.js";
import { HttpError } from "../../../lib/httpError.js";
import { logger } from "../../../lib/logger.js";
import {
  assertLiveDomainRegistrationAllowed,
  assertResellerClubAvailabilityAllowed,
  resolveDomainProviderMode
} from "../domain-provider-mode.js";
import { formatDomainSafeMessage, normalizeDomain, redactProviderSecrets } from "../domain.utils.js";
import { assertResellerClubRegistrationPayloadReady } from "../resellerclub-registration-preflight.js";

export type DomainAvailabilityResult = {
  domain: string;
  available: boolean;
  provider: "RESELLERCLUB";
  providerStatus: string;
  safeMessage: string;
  rawProviderPayload: unknown;
  raw: unknown;
};

export type ResellerClubAvailabilityLookup = {
  normalizedDomain: string;
  domainName: string;
  tlds: string;
};

export type RegisterDomainInput = {
  domain: string;
  merchantDomainId: string;
  paymentVerified: boolean;
  onboardingApproved: boolean;
  auditEventCreated: boolean;
  years: number;
  customerId: string;
  contactIds: {
    registrant: string;
    admin: string;
    tech: string;
    billing: string;
  };
  nameservers?: string[];
};

export type RegisterDomainResult = {
  provider: "RESELLERCLUB";
  orderId?: string;
  entityId?: string;
  raw: unknown;
};

const RESELLERCLUB_MULTI_LABEL_TLDS = new Set(["co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in"]);

function providerConfig(baseUrlOverride?: string) {
  const baseUrl = (baseUrlOverride || env.RESELLERCLUB_BASE_URL)?.replace(/\/+$/, "");
  const authUserid = env.RESELLERCLUB_AUTH_USERID;
  const apiKey = env.RESELLERCLUB_API_KEY;

  if (!baseUrl || !authUserid || !apiKey) {
    throw new HttpError(503, "DOMAIN_PROVIDER_NOT_CONFIGURED");
  }

  return { baseUrl, authUserid, apiKey };
}

function withAuthParams(params: Record<string, string>) {
  const { authUserid, apiKey } = providerConfig();
  return new URLSearchParams({
    "auth-userid": authUserid,
    "api-key": apiKey,
    ...params
  });
}

function stripHtmlForSafePreview(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function safeRequestSummary(baseUrl: string, path: string, method: string, params: URLSearchParams) {
  const baseHost = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return "invalid_base_url";
    }
  })();
  return {
    provider: "RESELLERCLUB",
    baseHost,
    path,
    method,
    paramNames: Array.from(params.keys()).sort(),
    domainName: params.get("domain-name") || "",
    tlds: params.get("tlds") || "",
    outboundIp: process.env.EXPECTED_PROVIDER_OUTBOUND_IP || undefined
  };
}

function safeResponseSummary(response: Response, bodyText: string) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "not_provided",
    bodyPreview: stripHtmlForSafePreview(bodyText)
  };
}

async function parseProviderBody(response: Response, bodyText: string) {
  if (!bodyText) return {};
  const contentType = response.headers.get("content-type") || "";
  if (!/json/i.test(contentType)) return { providerStatus: "non_json_response" };
  return JSON.parse(bodyText);
}

export function buildResellerClubAvailabilityLookup(domain: string): ResellerClubAvailabilityLookup {
  const normalized = normalizeDomain(domain);
  const labels = normalized.normalizedDomain.split(".");

  if (labels.length > 2) {
    const candidateTld = labels.slice(1).join(".");
    if (!RESELLERCLUB_MULTI_LABEL_TLDS.has(candidateTld)) {
      throw new HttpError(400, "DOMAIN_SUBDOMAIN_NOT_SUPPORTED");
    }
  }

  return {
    normalizedDomain: normalized.normalizedDomain,
    domainName: labels[0] || normalized.normalizedDomain,
    tlds: labels.slice(1).join(".")
  };
}

async function providerFetch(
  path: string,
  params: URLSearchParams,
  init: RequestInit = {},
  options: { baseUrl?: string } = {}
) {
  const { baseUrl } = providerConfig(options.baseUrl);
  const url = `${baseUrl}${path}`;
  const method = init.method || "GET";
  const requestUrl = method === "GET" ? `${url}?${params.toString()}` : url;
  const request = safeRequestSummary(baseUrl, path, method, params);
  const requestInit: RequestInit = {
    ...init,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(init.headers || {})
    }
  };

  if (method !== "GET") {
    requestInit.body = params.toString();
  }

  try {
    const response = await fetch(requestUrl, requestInit);
    const text = await response.text();
    const raw = await parseProviderBody(response, text);

    if (!response.ok) {
      logger.warn({
        request,
        response: env.RESELLERCLUB_DEBUG_SAFE ? safeResponseSummary(response, text) : { status: response.status }
      }, "Domain provider request failed");
      throw new HttpError(502, "DOMAIN_PROVIDER_TEMPORARILY_UNAVAILABLE");
    }

    if (env.RESELLERCLUB_DEBUG_SAFE) {
      logger.info({
        request,
        response: safeResponseSummary(response, text)
      }, "Domain provider availability debug");
    }

    return raw;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logger.warn({
      request,
      err: error instanceof Error ? error.message : String(error)
    }, "Domain provider request errored");
    throw new HttpError(502, "DOMAIN_PROVIDER_TEMPORARILY_UNAVAILABLE");
  }
}

function providerStatusFromRaw(domain: string, raw: unknown) {
  const data = raw as Record<string, unknown>;
  const direct = data[domain];
  const status =
    typeof direct === "string"
      ? direct
      : typeof direct === "object" && direct
        ? String((direct as Record<string, unknown>).status || (direct as Record<string, unknown>).available || "")
        : String(data.status || data.available || "");
  return status || "unknown";
}

function parseAvailability(domain: string, raw: unknown) {
  const status = providerStatusFromRaw(domain, raw);

  const available = /available|true|yes/i.test(status) && !/unavailable|false|no/i.test(status);
  return available;
}

export const resellerClubService = {
  async checkAvailability(domain: string, options: { baseUrl?: string } = {}): Promise<DomainAvailabilityResult> {
    const lookup = buildResellerClubAvailabilityLookup(domain);
    const normalizedDomain = lookup.normalizedDomain;
    const mode = resolveDomainProviderMode(env.SHIPMASTR_DOMAIN_PROVIDER_MODE);
    if (mode === "mock") {
      const available = !/taken|unavailable/i.test(normalizedDomain);
      const providerStatus = available ? "available" : "unavailable";
      const raw = {
        providerMode: "mock",
        status: providerStatus
      };
      return {
        domain: normalizedDomain,
        available,
        provider: "RESELLERCLUB",
        providerStatus,
        safeMessage: formatDomainSafeMessage(normalizedDomain, available),
        rawProviderPayload: raw,
        raw
      };
    }

    assertResellerClubAvailabilityAllowed({
      mode: env.SHIPMASTR_DOMAIN_PROVIDER_MODE,
      allowAvailabilityCheck: env.ALLOW_RESELLERCLUB_AVAILABILITY_CHECK,
      baseUrl: env.RESELLERCLUB_BASE_URL,
      authUserid: env.RESELLERCLUB_AUTH_USERID,
      apiKey: env.RESELLERCLUB_API_KEY,
      operation: "availability"
    });

    // ResellerClub availability parameters can vary for bundled lookups by TLD.
    // Verify exact active-account docs before production cutover.
    const params = withAuthParams({
      "domain-name": lookup.domainName,
      tlds: lookup.tlds
    });

    const raw = await providerFetch("/api/domains/available.json", params, {}, options);
    const available = parseAvailability(normalizedDomain, raw);
    const providerStatus = providerStatusFromRaw(normalizedDomain, raw);
    return {
      domain: normalizedDomain,
      available,
      provider: "RESELLERCLUB",
      providerStatus,
      safeMessage: formatDomainSafeMessage(normalizedDomain, available),
      rawProviderPayload: raw,
      raw
    };
  },

  async registerDomain(input: RegisterDomainInput): Promise<RegisterDomainResult> {
    assertLiveDomainRegistrationAllowed({
      mode: env.SHIPMASTR_DOMAIN_PROVIDER_MODE,
      allowLiveDomainRegistration: env.ALLOW_LIVE_DOMAIN_REGISTRATION,
      paymentVerified: input.paymentVerified,
      onboardingApproved: input.onboardingApproved,
      merchantDomainId: input.merchantDomainId,
      domain: input.domain,
      auditEventCreated: input.auditEventCreated
    });
    assertResellerClubRegistrationPayloadReady({
      domain: input.domain,
      customerId: input.customerId,
      contactIds: input.contactIds,
      nameserverParamsVerified: env.RESELLERCLUB_IN_NAMESERVER_PARAMS_VERIFIED
    });

    const nameservers = input.nameservers || [];
    const params: Record<string, string> = {
      "domain-name": input.domain,
      years: String(input.years),
      "customer-id": input.customerId,
      "reg-contact-id": input.contactIds.registrant,
      "admin-contact-id": input.contactIds.admin,
      "tech-contact-id": input.contactIds.tech,
      "billing-contact-id": input.contactIds.billing,
      "invoice-option": "NoInvoice"
    };

    nameservers.forEach((ns, index) => {
      params[`ns${index + 1}`] = ns;
    });

    // Verify exact nameserver parameter shape for .in in active ResellerClub docs before production.
    const raw = await providerFetch("/api/domains/register.json", withAuthParams(params), { method: "POST" });
    const data = raw as Record<string, unknown>;

    const result: RegisterDomainResult = {
      provider: "RESELLERCLUB",
      raw
    };
    const orderId = data["orderid"] ? String(data["orderid"]) : data["order-id"] ? String(data["order-id"]) : "";
    const entityId = data["entityid"] ? String(data["entityid"]) : data["entity-id"] ? String(data["entity-id"]) : "";
    if (orderId) result.orderId = orderId;
    if (entityId) result.entityId = entityId;
    return result;
  },

  async getDomainDetails(domain: string) {
    const raw = await providerFetch("/api/domains/details.json", withAuthParams({ "domain-name": domain }));
    return { provider: "RESELLERCLUB" as const, raw };
  },

  async renewDomain() {
    throw new HttpError(501, "DOMAIN_RENEWAL_NOT_ENABLED");
  },

  async configureNameservers() {
    throw new HttpError(501, "DOMAIN_NAMESERVER_UPDATE_NOT_ENABLED");
  },

  redactConfigForLogs(value: unknown) {
    return redactProviderSecrets(value);
  }
};
