import { DomainProvider, DomainProvisioningStatus, Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { formatDomainSafeMessage, redactProviderSecrets } from "./domain.utils.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

export type ResellerClubAvailabilityStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "PROVIDER_FORBIDDEN"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_BAD_RESPONSE";

export type ResellerClubAvailabilityCheckResult = {
  domain: string;
  available: boolean | null;
  status: ResellerClubAvailabilityStatus;
  message: string;
  provider: "RESELLERCLUB";
  providerStatus?: string;
  httpStatus?: number;
};

type AvailabilityEnv = Pick<
  typeof env,
  "RESELLERCLUB_BASE_URL" | "RESELLERCLUB_AUTH_USERID" | "RESELLERCLUB_API_KEY"
>;

type AvailabilityLookup = {
  normalizedDomain: string;
  domainName: string;
  tlds: string;
};

type AvailabilityRequest = {
  url: URL;
  path: string;
  params: URLSearchParams;
  lookup: AvailabilityLookup;
};

const DOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_CHARS_REGEX = /^[a-z0-9.-]+$/;
const AVAILABILITY_PATH = "/api/domains/available.json";
const DEFAULT_RESELLERCLUB_BASE_URL = "https://httpapi.com";
const PROVIDER_TIMEOUT_MS = 8000;
const BLOCKED_PLATFORM_DOMAINS = new Set([
  "shipmastr.com",
  "www.shipmastr.com",
  "api.shipmastr.com",
  "admin.shipmastr.com",
  "seller.shipmastr.com",
  "courier.shipmastr.com",
  "localhost",
  "127.0.0.1"
]);

function normalizeAvailabilityDomain(input: string): AvailabilityLookup {
  const normalizedDomain = String(input || "").trim().toLowerCase().replace(/^www\./, "");
  if (!normalizedDomain) throw new HttpError(400, "DOMAIN_REQUIRED");
  if (!DOMAIN_CHARS_REGEX.test(normalizedDomain) || normalizedDomain.includes("..")) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }
  if (
    BLOCKED_PLATFORM_DOMAINS.has(normalizedDomain) ||
    normalizedDomain === "run.app" ||
    normalizedDomain.endsWith(".run.app") ||
    normalizedDomain.endsWith(".shipmastr.com")
  ) {
    throw new HttpError(400, "DOMAIN_RESERVED_FOR_SHIPMASTR");
  }

  const labels = normalizedDomain.split(".");
  if (labels.length !== 2 || labels.some((label) => !DOMAIN_LABEL_REGEX.test(label))) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  const [domainName, tlds] = labels;
  if (!domainName || !tlds || tlds.length < 2 || /^\d+$/.test(tlds)) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  return { normalizedDomain, domainName, tlds };
}

function availabilityConfig(source: AvailabilityEnv = env) {
  const baseUrl = (source.RESELLERCLUB_BASE_URL || DEFAULT_RESELLERCLUB_BASE_URL).replace(/\/+$/, "");
  const authUserid = source.RESELLERCLUB_AUTH_USERID;
  const apiKey = source.RESELLERCLUB_API_KEY;

  if (!authUserid || !apiKey) {
    throw new HttpError(500, "CONFIG_ERROR");
  }

  return { baseUrl, authUserid, apiKey };
}

export function buildResellerClubAvailabilityCheckRequest(domain: string, source: AvailabilityEnv = env): AvailabilityRequest {
  const lookup = normalizeAvailabilityDomain(domain);
  const { baseUrl, authUserid, apiKey } = availabilityConfig(source);
  const url = new URL(AVAILABILITY_PATH, `${baseUrl}/`);
  const params = new URLSearchParams({
    "auth-userid": authUserid,
    "api-key": apiKey,
    "domain-name": lookup.domainName,
    tlds: lookup.tlds
  });
  url.search = params.toString();
  return { url, path: AVAILABILITY_PATH, params, lookup };
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

function providerStatusFromRaw(domain: string, raw: unknown) {
  const data = raw as Record<string, unknown>;
  const direct = data[domain];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    const nested = direct as Record<string, unknown>;
    if (nested.status !== undefined) return String(nested.status);
    if (nested.available !== undefined) return String(nested.available);
  }
  if (data.status !== undefined) return String(data.status);
  if (data.available !== undefined) return String(data.available);
  return "";
}

function availabilityFromProviderStatus(status: string) {
  if (/unavailable|false|no/i.test(status)) return false;
  if (/available|true|yes/i.test(status)) return true;
  return null;
}

function providerAccessResult(input: {
  domain: string;
  httpStatus?: number | undefined;
  status: Extract<ResellerClubAvailabilityStatus, "PROVIDER_FORBIDDEN" | "PROVIDER_TIMEOUT" | "PROVIDER_BAD_RESPONSE">;
  providerStatus?: string | undefined;
}) {
  const messages: Record<typeof input.status, string> = {
    PROVIDER_FORBIDDEN: "Provider rejected the request. IP whitelist or API access may still be propagating.",
    PROVIDER_TIMEOUT: "Provider availability check timed out. Please retry after confirming provider access.",
    PROVIDER_BAD_RESPONSE: "Provider returned an unexpected availability response. Please retry or contact Shipmastr support."
  };

  return {
    domain: input.domain,
    available: null,
    status: input.status,
    message: messages[input.status],
    provider: "RESELLERCLUB" as const,
    ...(input.providerStatus ? { providerStatus: input.providerStatus } : {}),
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {})
  };
}

function safePayload(input: {
  request: AvailabilityRequest;
  result: ResellerClubAvailabilityCheckResult;
  response?: {
    contentType?: string | null | undefined;
    bodyPreview?: string | undefined;
  } | undefined;
}) {
  return redactProviderSecrets({
    provider: "RESELLERCLUB",
    operation: "availability",
    providerStatus: input.result.providerStatus || input.result.status,
    httpStatus: input.result.httpStatus ?? null,
    available: input.result.available,
    request: {
      method: "GET",
      path: input.request.path,
      params: {
        "auth-userid": input.request.params.get("auth-userid"),
        "api-key": input.request.params.get("api-key"),
        "domain-name": input.request.lookup.domainName,
        tlds: input.request.lookup.tlds
      }
    },
    response: input.response || null
  }) as Prisma.InputJsonValue;
}

async function writeAvailabilityEvent(input: {
  client: DbClient;
  storefrontDomainId: string;
  request: AvailabilityRequest;
  result: ResellerClubAvailabilityCheckResult;
  response?: {
    contentType?: string | null | undefined;
    bodyPreview?: string | undefined;
  } | undefined;
}) {
  await input.client.domainProvisioningEvent.create({
    data: {
      storefrontDomainId: input.storefrontDomainId,
      provider: DomainProvider.RESELLERCLUB,
      eventType: "DOMAIN_AVAILABILITY_CHECKED",
      status: input.result.available === null ? DomainProvisioningStatus.FAILED : DomainProvisioningStatus.SUCCEEDED,
      payload: safePayload(input),
      safeMessage: input.result.message
    } satisfies Prisma.DomainProvisioningEventUncheckedCreateInput
  });
}

export async function checkResellerClubDomainAvailability(input: {
  domain: string;
  storefrontDomainId?: string | undefined;
  client?: DbClient | undefined;
  env?: AvailabilityEnv | undefined;
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<ResellerClubAvailabilityCheckResult> {
  const request = buildResellerClubAvailabilityCheckRequest(input.domain, input.env || env);
  const fetchFn = input.fetchFn || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? PROVIDER_TIMEOUT_MS);

  let result: ResellerClubAvailabilityCheckResult;
  let responseSummary: { contentType?: string | null | undefined; bodyPreview?: string | undefined } | undefined;

  try {
    const response = await fetchFn(request.url.toString(), {
      method: "GET",
      signal: controller.signal
    });
    const text = await response.text();
    responseSummary = {
      contentType: response.headers.get("content-type"),
      bodyPreview: stripHtmlForSafePreview(text)
    };

    if (response.status === 403) {
      result = providerAccessResult({
        domain: request.lookup.normalizedDomain,
        status: "PROVIDER_FORBIDDEN",
        httpStatus: response.status,
        providerStatus: "forbidden"
      });
    } else if (!response.ok) {
      result = providerAccessResult({
        domain: request.lookup.normalizedDomain,
        status: "PROVIDER_BAD_RESPONSE",
        httpStatus: response.status,
        providerStatus: `http_${response.status}`
      });
    } else {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        result = providerAccessResult({
          domain: request.lookup.normalizedDomain,
          status: "PROVIDER_BAD_RESPONSE",
          httpStatus: response.status,
          providerStatus: "invalid_json"
        });
        if (input.storefrontDomainId) {
          await writeAvailabilityEvent({
            client: input.client || prisma,
            storefrontDomainId: input.storefrontDomainId,
            request,
            result,
            response: responseSummary
          });
        }
        return result;
      }

      const providerStatus = providerStatusFromRaw(request.lookup.normalizedDomain, raw);
      const available = availabilityFromProviderStatus(providerStatus);
      if (available === null) {
        result = providerAccessResult({
          domain: request.lookup.normalizedDomain,
          status: "PROVIDER_BAD_RESPONSE",
          httpStatus: response.status,
          providerStatus: providerStatus || "unknown"
        });
      } else {
        result = {
          domain: request.lookup.normalizedDomain,
          available,
          status: available ? "AVAILABLE" : "UNAVAILABLE",
          message: formatDomainSafeMessage(request.lookup.normalizedDomain, available),
          provider: "RESELLERCLUB",
          providerStatus,
          httpStatus: response.status
        };
      }
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const name = error && typeof error === "object" && "name" in error ? String((error as { name?: string }).name) : "";
    const message = error instanceof Error ? error.message : String(error);
    result = providerAccessResult({
      domain: request.lookup.normalizedDomain,
      status: /Abort|Timeout/i.test(name) || /timeout|aborted/i.test(message) ? "PROVIDER_TIMEOUT" : "PROVIDER_BAD_RESPONSE",
      providerStatus: /Abort|Timeout/i.test(name) || /timeout|aborted/i.test(message) ? "timeout" : "request_error"
    });
  } finally {
    clearTimeout(timeout);
  }

  if (input.storefrontDomainId) {
    await writeAvailabilityEvent({
      client: input.client || prisma,
      storefrontDomainId: input.storefrontDomainId,
      request,
      result,
      response: responseSummary
    });
  }

  return result;
}
