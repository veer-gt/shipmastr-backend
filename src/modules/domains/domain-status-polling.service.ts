import { Resolver, resolveNs, resolveSoa, resolveTxt } from "node:dns/promises";
import { DomainProvider, DomainProvisioningStatus, DomainStatus, Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { buildCloudflareHeaders } from "./providers/cloudflare.service.js";
import { resellerClubService } from "./providers/resellerclub.service.js";
import {
  buildMerchantDomainStatusView,
  type MerchantDomainLifecycleStatus
} from "./domain-status.presenter.js";
import {
  domainStatusRetryPlan,
  selectDomainPollAuditEvent
} from "./domain-lifecycle-policy.js";
import {
  type DomainPollingCloudflareState,
  type DomainPollingNameserverState,
  type DomainPollingProviderState,
  type DomainPollingStorefrontState,
  type DomainPollingTxtState,
  type DomainStatusPollContext,
  type DomainStatusPollingAdapters,
  type DomainStatusPollResult
} from "./domain-status-polling.types.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

const DOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REGISTRY_HOLD_NAMESERVER_PATTERN = /verification-hold|suspended-domain/i;
const CORE_PLATFORM_HOSTS = new Set([
  "shipmastr.com",
  "www.shipmastr.com",
  "api.shipmastr.com",
  "admin.shipmastr.com",
  "seller.shipmastr.com",
  "courier.shipmastr.com",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1"
]);

export function normalizePollingDomain(input: string) {
  const raw = String(input || "").trim().toLowerCase();
  const withoutProtocol = raw.replace(/^https?:\/\//, "");
  const withoutPath = withoutProtocol.split(/[/?#]/)[0] || "";
  const withoutPort = withoutPath.replace(/:\d{1,5}$/, "");
  const domain = withoutPort.replace(/\.$/, "").replace(/^www\./, "");

  if (!domain || domain.length > 253 || domain.includes("..")) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  if (CORE_PLATFORM_HOSTS.has(domain) || domain.endsWith(".run.app")) {
    throw new HttpError(400, "DOMAIN_RESERVED_FOR_SHIPMASTR");
  }

  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_REGEX.test(label))) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  return domain;
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function booleanValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/verified|complete|active|true|yes/i.test(value)) return true;
    if (/pending|required|hold|false|no/i.test(value)) return false;
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function extractTxtValidation(validationRecords: Prisma.JsonValue | null | undefined) {
  const record = jsonObject(validationRecords);
  const polling = jsonObject(record.polling as Prisma.JsonValue | null | undefined);
  const txt = jsonObject(record.txt as Prisma.JsonValue | null | undefined);
  const ownership = jsonObject(record.ownershipTxt as Prisma.JsonValue | null | undefined);
  const cloudflareValidation = jsonObject(record.validationRecords as Prisma.JsonValue | null | undefined);
  const cloudflareTxt = Array.isArray(cloudflareValidation.txt) ? cloudflareValidation.txt[0] : null;
  const cloudflareTxtObject = jsonObject(cloudflareTxt as Prisma.JsonValue | null | undefined);

  return {
    name:
      firstString(record, ["txtName", "txtRecordName", "ownershipTxtName"]) ||
      firstString(polling, ["expectedTxtName"]) ||
      firstString(txt, ["name", "recordName"]) ||
      firstString(ownership, ["name", "recordName"]) ||
      firstString(cloudflareTxtObject, ["name"]),
    value:
      firstString(record, ["txtValue", "txtRecordValue", "ownershipTxtValue"]) ||
      firstString(polling, ["expectedTxtValue"]) ||
      firstString(txt, ["value", "content"]) ||
      firstString(ownership, ["value", "content"]) ||
      firstString(cloudflareTxtObject, ["value", "content"])
  };
}

function hasProviderSetupSignal(context: DomainStatusPollContext) {
  if (context.cloudflareCustomHostnameId) return true;

  const record = jsonObject(context.validationRecords);
  const txt = jsonObject(record.txt as Prisma.JsonValue | null | undefined);
  const ownership = jsonObject(record.ownershipTxt as Prisma.JsonValue | null | undefined);
  const cloudflareValidation = jsonObject(record.validationRecords as Prisma.JsonValue | null | undefined);
  const cloudflareTxt = Array.isArray(cloudflareValidation.txt) ? cloudflareValidation.txt[0] : null;
  const cloudflareHttp = Array.isArray(cloudflareValidation.http) ? cloudflareValidation.http[0] : null;
  const cloudflareTxtObject = jsonObject(cloudflareTxt as Prisma.JsonValue | null | undefined);
  const cloudflareHttpObject = jsonObject(cloudflareHttp as Prisma.JsonValue | null | undefined);

  if (firstString(record, [
    "cloudflareCustomHostnameId",
    "customHostnameId",
    "txtName",
    "txtRecordName",
    "ownershipTxtName",
    "txtValue",
    "txtRecordValue",
    "ownershipTxtValue",
    "dnsValidationStatus",
    "sslStatus"
  ])) {
    return true;
  }

  if (
    firstString(txt, ["name", "recordName", "value", "content"]) ||
    firstString(ownership, ["name", "recordName", "value", "content"]) ||
    firstString(cloudflareTxtObject, ["name", "value", "content"]) ||
    firstString(cloudflareHttpObject, ["url", "body", "value", "content"])
  ) {
    return true;
  }

  return false;
}

function isReviewOnlyRequest(context: DomainStatusPollContext) {
  if (hasProviderSetupSignal(context)) return false;
  const record = jsonObject(context.validationRecords);
  const requestStatus = String(record.requestStatus || "").toUpperCase();
  const currentStatus = String(context.currentStatus || "").toUpperCase();
  if (context.currentStatus) {
    if (currentStatus === DomainStatus.REQUESTED || currentStatus === "REVIEW_REQUIRED") return true;
    const reviewRequest = requestStatus === "PENDING_REVIEW" || requestStatus === "REQUESTED";
    const recoverablePrematureStatuses = new Set<string>([
      DomainStatus.CLOUDFLARE_PENDING,
      DomainStatus.DNS_PENDING,
      DomainStatus.APPROVAL_REQUIRED
    ]);
    const recoverablePrematureStatus = recoverablePrematureStatuses.has(currentStatus);
    return reviewRequest && recoverablePrematureStatus;
  }
  return requestStatus === "PENDING_REVIEW" || requestStatus === "REQUESTED";
}

function extractProviderStateFromRaw(raw: unknown): DomainPollingProviderState {
  const record = jsonObject(raw as Prisma.JsonValue);
  const orderDetails = jsonObject(record.orderdetails as Prisma.JsonValue | null | undefined);
  const data = Object.keys(orderDetails).length ? orderDetails : record;
  const nsRaw = data.nameservers || data.ns || data.currentNameservers;
  const nameservers = Array.isArray(nsRaw)
    ? nsRaw.map((item) => stringValue(item)).filter((item): item is string => Boolean(item))
    : typeof nsRaw === "string"
      ? nsRaw.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)
      : [];

  return {
    checked: true,
    status: firstString(data, ["status", "orderstatus", "domainstatus", "currentstatus"]),
    raaEmailVerified: booleanValue(data.raaEmailVerified || data.raaemailverificationstatus || data.emailVerificationStatus),
    domainVerificationComplete: booleanValue(data.domainVerification || data.domainVerificationStatus || data.verificationStatus),
    ekycVerified: booleanValue(data.ekycStatus || data.ekycVerification || data.kycStatus),
    nameservers
  };
}

function defaultProviderAdapter() {
  return {
    async getDomainStatus(context: DomainStatusPollContext): Promise<DomainPollingProviderState> {
      if (!context.resellerClubOrderId) return { checked: false };
      const details = await resellerClubService.getDomainDetails(context.domain);
      return extractProviderStateFromRaw(details.raw);
    }
  };
}

function createResolver(servers: string[]) {
  const resolver = new Resolver();
  resolver.setServers(servers);
  return resolver;
}

async function resolveSafely<T>(operation: () => Promise<T>, fallback: T) {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

async function resolveTxtFlat(name: string) {
  const values = await resolveTxt(name);
  return values.map((chunks) => chunks.join(""));
}

function defaultDnsAdapter() {
  return {
    async getNameserverState(domain: string): Promise<DomainPollingNameserverState> {
      const cloudflareOne = createResolver(["1.1.1.1"]);
      const google = createResolver(["8.8.8.8"]);
      const authoritative = await resolveSafely(() => resolveNs(domain), []);
      const publicResolverOne = await resolveSafely(() => cloudflareOne.resolveNs(domain), []);
      const publicResolverGoogle = await resolveSafely(() => google.resolveNs(domain), []);
      const soa = await resolveSafely(async () => {
        const record = await resolveSoa(domain);
        return `${record.nsname} ${record.hostmaster}`;
      }, null);
      const allRecords = [...authoritative, ...publicResolverOne, ...publicResolverGoogle, soa || ""];
      return {
        authoritative,
        publicResolverOne,
        publicResolverGoogle,
        soa,
        registryHoldDetected: allRecords.some((value) => REGISTRY_HOLD_NAMESERVER_PATTERN.test(value))
      };
    },

    async checkTxtRecord(expectedName?: string | null, expectedValue?: string | null): Promise<DomainPollingTxtState> {
      if (!expectedName || !expectedValue) {
        return {
          expectedName: expectedName || null,
          expectedValue: expectedValue || null,
          present: null,
          checked: false
        };
      }
      const values = await resolveSafely(() => resolveTxtFlat(expectedName), []);
      return {
        expectedName,
        expectedValue,
        present: values.includes(expectedValue),
        checked: true
      };
    }
  };
}

function cloudflareStatusFromRaw(raw: unknown, fallbackId?: string | null): DomainPollingCloudflareState {
  const record = jsonObject(raw as Prisma.JsonValue);
  const result = jsonObject(record.result as Prisma.JsonValue | null | undefined);
  const ssl = jsonObject(result.ssl as Prisma.JsonValue | null | undefined);
  const ownership = result.ownership_verification || result.ownership_verification_http;
  const ownershipObject = jsonObject(ownership as Prisma.JsonValue | null | undefined);
  return {
    checked: true,
    customHostnameId: stringValue(result.id) || fallbackId || null,
    status: stringValue(result.status),
    sslStatus: stringValue(ssl.status),
    validationMethod: stringValue(ssl.method) || stringValue(ownershipObject.method),
    validationRecordPresence: Boolean(result.ownership_verification || result.ownership_verification_http || result.verification_records)
  };
}

function defaultCloudflareAdapter() {
  return {
    async getCustomHostnameStatus(context: DomainStatusPollContext): Promise<DomainPollingCloudflareState> {
      if (!env.CLOUDFLARE_ZONE_ID || !context.cloudflareCustomHostnameId) return { checked: false };
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${encodeURIComponent(context.cloudflareCustomHostnameId)}`,
        { method: "GET", headers: buildCloudflareHeaders(env) }
      );
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          checked: true,
          customHostnameId: context.cloudflareCustomHostnameId,
          status: `HTTP_${response.status}`,
          sslStatus: null,
          validationMethod: null,
          validationRecordPresence: null
        };
      }
      return cloudflareStatusFromRaw(raw, context.cloudflareCustomHostnameId);
    }
  };
}

function defaultStorefrontAdapter() {
  return {
    async checkStorefront(domain: string): Promise<DomainPollingStorefrontState> {
      const response = await fetch(`https://${domain}/`, { method: "GET", redirect: "manual" });
      const body = await response.text().catch(() => "");
      const server = response.headers.get("server") || "";
      const googleFrontend404 = response.status === 404 && /google frontend/i.test(`${server} ${body}`);
      const hostingerDetected = /hostinger|hpanel|parkpage/i.test(body);
      const apiDetected = /shipmastr-api|express|api\.shipmastr/i.test(body);
      const expectedRendererResponse = /powered by shipmastr|shipmastr storefront|storefront/i.test(body) && !hostingerDetected && !apiDetected;
      return {
        checked: true,
        reachable: response.ok,
        status: response.status,
        googleFrontend404,
        hostingerDetected,
        apiDetected,
        expectedRendererResponse
      };
    }
  };
}

function mergeAdapters(adapters: DomainStatusPollingAdapters = {}): Required<DomainStatusPollingAdapters> {
  return {
    provider: adapters.provider || defaultProviderAdapter(),
    dns: adapters.dns || defaultDnsAdapter(),
    cloudflare: adapters.cloudflare || defaultCloudflareAdapter(),
    storefront: adapters.storefront || defaultStorefrontAdapter()
  };
}

function unresolvedProviderVerification(provider: DomainPollingProviderState) {
  if (!provider.checked) return false;
  return provider.raaEmailVerified === false || provider.domainVerificationComplete === false;
}

function unresolvedEkyc(provider: DomainPollingProviderState) {
  if (!provider.checked) return false;
  return provider.ekycVerified === false;
}

function activeCloudflare(cloudflare: DomainPollingCloudflareState) {
  return /active/i.test(String(cloudflare.status || ""));
}

function activeSsl(cloudflare: DomainPollingCloudflareState) {
  const sslStatus = String(cloudflare.sslStatus || "").trim().toLowerCase();
  return ["active", "issued", "valid", "verified"].includes(sslStatus);
}

export function deriveMerchantStatusFromPoll(input: {
  provider: DomainPollingProviderState;
  nameservers: DomainPollingNameserverState;
  txt: DomainPollingTxtState;
  cloudflare: DomainPollingCloudflareState;
  storefront: DomainPollingStorefrontState;
}): MerchantDomainLifecycleStatus {
  if (input.nameservers.registryHoldDetected) return "EKYC_PENDING";
  if (unresolvedEkyc(input.provider)) return "EKYC_PENDING";
  if (unresolvedProviderVerification(input.provider)) return "VERIFICATION_REQUIRED";
  if (input.txt.checked && input.txt.present === false) return "DNS_VALIDATION_PENDING";
  if (input.cloudflare.checked && !activeSsl(input.cloudflare)) return "SSL_ISSUING";
  if (input.storefront.checked && input.storefront.reachable && input.storefront.expectedRendererResponse && activeCloudflare(input.cloudflare) && activeSsl(input.cloudflare)) {
    return "LIVE";
  }
  if (input.storefront.checked && (input.storefront.googleFrontend404 || input.storefront.hostingerDetected || input.storefront.apiDetected)) {
    return "FAILED_NEEDS_SUPPORT";
  }
  if (activeCloudflare(input.cloudflare) && activeSsl(input.cloudflare)) return "CONNECTED";
  return "DNS_VALIDATION_PENDING";
}

function propagationStatus(input: {
  nameservers: DomainPollingNameserverState;
  txt: DomainPollingTxtState;
}) {
  if (input.nameservers.registryHoldDetected) return "REGISTRY_HOLD" as const;
  if (!input.txt.checked) return "NOT_CHECKED" as const;
  return input.txt.present ? "PROPAGATED" as const : "PENDING" as const;
}

function cloudflareValidationRecordPresence(value: DomainPollingCloudflareState) {
  if (value.validationRecordPresence === null || value.validationRecordPresence === undefined) return "unknown";
  return value.validationRecordPresence ? "present" : "missing";
}

export async function runDomainStatusPoll(
  context: DomainStatusPollContext,
  adapters: DomainStatusPollingAdapters = {}
): Promise<DomainStatusPollResult> {
  const domain = normalizePollingDomain(context.domain);
  const merged = mergeAdapters(adapters);
  const txtConfig = extractTxtValidation(context.validationRecords);
  const [provider, nameservers, txt, cloudflare] = await Promise.all([
    merged.provider.getDomainStatus({ ...context, domain }),
    merged.dns.getNameserverState(domain),
    merged.dns.checkTxtRecord(txtConfig.name, txtConfig.value),
    merged.cloudflare.getCustomHostnameStatus({ ...context, domain })
  ]);
  const shouldProbeStorefront = activeSsl(cloudflare) || cloudflare.status === "active";
  const storefront = shouldProbeStorefront
    ? await merged.storefront.checkStorefront(domain)
    : {
        checked: false,
        reachable: null,
        status: null,
        googleFrontend404: false,
        hostingerDetected: false,
        apiDetected: false,
        expectedRendererResponse: false
      };
  const derivedMerchantStatus = deriveMerchantStatusFromPoll({ provider, nameservers, txt, cloudflare, storefront });
  const merchantStatus = isReviewOnlyRequest({ ...context, domain })
    ? "REVIEW_REQUIRED"
    : derivedMerchantStatus;
  const checkedAt = new Date();
  const statusView = buildMerchantDomainStatusView({
    domain,
    status: merchantStatus,
    updatedAt: checkedAt
  });
  const dnsValidationStatus = propagationStatus({ nameservers, txt });
  const retryPlan = domainStatusRetryPlan(merchantStatus, {
    dnsPropagationStatus: dnsValidationStatus,
    sslStatus: cloudflare.sslStatus
  });
  const suggestedAuditEvent = selectDomainPollAuditEvent({
    merchantStatus,
    dnsPropagationStatus: dnsValidationStatus,
    txtPresent: txt.present,
    cloudflareChecked: cloudflare.checked,
    sslStatus: cloudflare.sslStatus,
    providerStatus: provider.status
  });

  return {
    domain,
    merchantStatus,
    statusView,
    provider,
    dns: {
      nameservers,
      txt,
      propagationStatus: dnsValidationStatus
    },
    cloudflare,
    storefront,
    adminDiagnostics: {
      domain,
      merchantStatus: statusView,
      providerDiagnostics: {
        providerStatus: provider.status || null,
        raaEmailVerified: provider.raaEmailVerified ?? null,
        domainVerificationComplete: provider.domainVerificationComplete ?? null,
        ekycVerified: provider.ekycVerified ?? null,
        registryHoldDetected: nameservers.registryHoldDetected,
        nameservers: nameservers.authoritative
      },
      cloudflareCustomHostnameId: cloudflare.customHostnameId || context.cloudflareCustomHostnameId || null,
      dnsValidationStatus,
      sslStatus: cloudflare.sslStatus || null,
      suggestedAuditEvent,
      retryPlan,
      rawStatusSummary: {
        checkedAt: checkedAt.toISOString(),
        providerChecked: provider.checked,
        txtChecked: txt.checked,
        txtPresent: txt.present,
        cloudflareChecked: cloudflare.checked,
        cloudflareStatus: cloudflare.status || null,
        sslStatus: cloudflare.sslStatus || null,
        validationRecordPresence: cloudflareValidationRecordPresence(cloudflare),
        storefrontChecked: storefront.checked,
        storefrontReachable: storefront.reachable,
        storefrontStatus: storefront.status || null,
        googleFrontend404: storefront.googleFrontend404,
        hostingerDetected: storefront.hostingerDetected,
        apiDetected: storefront.apiDetected,
        nextPollAfterMinutes: retryPlan.nextPollAfterMinutes,
        escalationText: retryPlan.escalationText
      }
    },
    checkedAt
  };
}

function domainStatusFromMerchantStatus(status: MerchantDomainLifecycleStatus) {
  switch (status) {
    case "REQUESTED":
    case "REVIEW_REQUIRED":
      return DomainStatus.REQUESTED;
    case "VERIFICATION_REQUIRED":
    case "EKYC_PENDING":
    case "REGISTRATION_STARTED":
    case "REGISTERED":
      return DomainStatus.REGISTERED;
    case "SSL_ISSUING":
      return DomainStatus.SSL_PENDING;
    case "CONNECTED":
      return DomainStatus.SSL_PENDING;
    case "LIVE":
      return DomainStatus.ACTIVE;
    case "FAILED_NEEDS_SUPPORT":
      return DomainStatus.FAILED;
    case "DNS_VALIDATION_PENDING":
    default:
      return DomainStatus.CLOUDFLARE_PENDING;
  }
}

function statusRank(status: DomainStatus) {
  const ranks: Partial<Record<DomainStatus, number>> = {
    [DomainStatus.SEARCHED]: 0,
    [DomainStatus.AVAILABLE]: 0,
    [DomainStatus.UNAVAILABLE]: 0,
    [DomainStatus.PAYMENT_REQUIRED]: 1,
    [DomainStatus.APPROVAL_REQUIRED]: 1,
    [DomainStatus.REGISTERING]: 2,
    [DomainStatus.REGISTERED]: 3,
    [DomainStatus.DNS_PENDING]: 4,
    [DomainStatus.CLOUDFLARE_PENDING]: 4,
    [DomainStatus.SSL_PENDING]: 5,
    [DomainStatus.ACTIVE]: 6,
    [DomainStatus.FAILED]: 7,
    [DomainStatus.SUSPENDED]: 7,
    [DomainStatus.EXPIRED]: 7,
    [DomainStatus.RENEWAL_DUE]: 7
  };
  return ranks[status] ?? 0;
}

function safeNextStatus(current: DomainStatus, next: DomainStatus) {
  if (next === DomainStatus.REQUESTED) return current === DomainStatus.REQUESTED ? next : current;
  if (next === DomainStatus.FAILED || statusRank(next) >= statusRank(current)) return next;
  return current;
}

function validationRecordsWithPoll(row: { validationRecords: Prisma.JsonValue | null }, result: DomainStatusPollResult) {
  const existing = jsonObject(row.validationRecords);
  return {
    ...existing,
    polling: {
      checkedAt: result.checkedAt.toISOString(),
      merchantStatus: result.merchantStatus,
      dnsPropagationStatus: result.dns.propagationStatus,
      registryHoldDetected: result.dns.nameservers.registryHoldDetected,
      txtChecked: result.dns.txt.checked,
      txtPresent: result.dns.txt.present,
      cloudflareStatus: result.cloudflare.status || null,
      sslStatus: result.cloudflare.sslStatus || null,
      storefrontChecked: result.storefront.checked,
      storefrontReachable: result.storefront.reachable,
      storefrontStatus: result.storefront.status || null,
      googleFrontend404: result.storefront.googleFrontend404,
      hostingerDetected: result.storefront.hostingerDetected,
      apiDetected: result.storefront.apiDetected
    }
  };
}

export async function getMerchantDomainPollingStatus(input: {
  userId: string;
  merchantId: string;
  domain: string;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  const domain = normalizePollingDomain(input.domain);
  const row = await client.merchantDomain.findFirst({
    where: {
      merchantId: input.merchantId,
      normalizedDomain: domain
    },
    select: {
      id: true,
      merchantId: true,
      domain: true,
      normalizedDomain: true,
      status: true,
      lastCheckedAt: true,
      updatedAt: true,
      validationRecords: true
    }
  });

  if (!row) throw new HttpError(404, "DOMAIN_NOT_FOUND");

  const record = jsonObject(row.validationRecords);
  const polling = jsonObject(record.polling as Prisma.JsonValue | null | undefined);
  const status = stringValue(polling.merchantStatus) || row.status;
  return {
    domain: row.normalizedDomain,
    statusView: buildMerchantDomainStatusView({
      domain: row.domain,
      status,
      updatedAt: row.lastCheckedAt || row.updatedAt
    })
  };
}

export async function pollAndPersistAdminDomainStatus(input: {
  domain: string;
  client?: DbClient;
  adapters?: DomainStatusPollingAdapters;
}) {
  const client = input.client || prisma;
  const domain = normalizePollingDomain(input.domain);
  const row = await client.merchantDomain.findUnique({
    where: { normalizedDomain: domain },
    select: {
      id: true,
      merchantId: true,
      storefrontId: true,
      domain: true,
      normalizedDomain: true,
      provider: true,
      status: true,
      resellerClubOrderId: true,
      cloudflareCustomHostnameId: true,
      sslStatus: true,
      validationRecords: true
    }
  });

  if (!row) throw new HttpError(404, "DOMAIN_NOT_FOUND");

  const result = await runDomainStatusPoll({
    domain: row.normalizedDomain,
    currentStatus: row.status,
    merchantDomainId: row.id,
    resellerClubOrderId: row.resellerClubOrderId,
    cloudflareCustomHostnameId: row.cloudflareCustomHostnameId,
    validationRecords: row.validationRecords
  }, input.adapters);
  const mappedNextStatus = domainStatusFromMerchantStatus(result.merchantStatus);
  const nextStatus = result.merchantStatus === "REVIEW_REQUIRED"
    ? DomainStatus.REQUESTED
    : safeNextStatus(row.status, mappedNextStatus);
  const validationRecords = validationRecordsWithPoll(row, result);

  await client.domainProvisioningEvent.create({
    data: {
      merchantId: row.merchantId,
      merchantDomainId: row.id,
      storefrontId: row.storefrontId,
      provider: row.provider || DomainProvider.MANUAL,
      eventType: result.adminDiagnostics.suggestedAuditEvent,
      status: result.merchantStatus === "FAILED_NEEDS_SUPPORT" ? DomainProvisioningStatus.FAILED : DomainProvisioningStatus.PROCESSING,
      safeMessage: result.statusView.message,
      requestPayload: {
        domain: row.normalizedDomain,
        readOnly: true
      },
      responsePayload: {
        merchantStatus: result.merchantStatus,
        dnsPropagationStatus: result.dns.propagationStatus,
        registryHoldDetected: result.dns.nameservers.registryHoldDetected,
        txtChecked: result.dns.txt.checked,
        txtPresent: result.dns.txt.present,
        cloudflareStatus: result.cloudflare.status || null,
        sslStatus: result.cloudflare.sslStatus || null,
        storefrontReachable: result.storefront.reachable,
        googleFrontend404: result.storefront.googleFrontend404,
        hostingerDetected: result.storefront.hostingerDetected,
        apiDetected: result.storefront.apiDetected,
        nextPollAfterMinutes: result.adminDiagnostics.retryPlan.nextPollAfterMinutes,
        escalationText: result.adminDiagnostics.retryPlan.escalationText
      }
    }
  });

  await client.merchantDomain.update({
    where: { id: row.id },
    data: {
      status: nextStatus,
      ...(result.cloudflare.sslStatus ? { sslStatus: result.cloudflare.sslStatus } : {}),
      validationRecords,
      lastCheckedAt: result.checkedAt
    }
  });

  return {
    domain: result.domain,
    statusView: result.statusView,
    diagnostics: result.adminDiagnostics,
    checkedAt: result.checkedAt
  };
}
