import { resolve4, resolveCname, resolveNs, resolveSoa } from "node:dns/promises";
import { DomainProvider, DomainProvisioningStatus, DomainStatus, Prisma } from "@prisma/client";
import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { getStorefrontByDomain } from "../storefronts/storefronts.service.js";
import { buildCloudflareHeaders } from "./providers/cloudflare.service.js";
import { normalizeDomain } from "./domain.utils.js";

export type DomainActivationState =
  | "REQUESTED"
  | "REVIEW_REQUIRED"
  | "ADMIN_APPROVED"
  | "PROVIDER_SETUP_READY"
  | "PROVIDER_SETUP_STARTED"
  | "DNS_INSTRUCTIONS_AVAILABLE"
  | "DNS_VALIDATED"
  | "INTAKE"
  | "PROVIDER_VERIFICATION_PENDING"
  | "CLOUDFLARE_HOSTNAME_CREATED"
  | "TXT_VALIDATION_PENDING"
  | "CNAME_PENDING"
  | "WORKER_ROUTE_PENDING"
  | "STOREFRONT_MAPPING_PENDING"
  | "SSL_PENDING"
  | "LIVE"
  | "FAILED_NEEDS_REVIEW"
  | "NEEDS_ATTENTION";

export type DomainActivationWorkflowState =
  | "MERCHANT_REQUESTED"
  | "ADMIN_REVIEW_REQUIRED"
  | "ADMIN_APPROVED"
  | "PROVIDER_SETUP_READY"
  | "PROVIDER_SETUP_STARTED"
  | "DNS_INSTRUCTIONS_AVAILABLE"
  | "DNS_VALIDATED"
  | "SSL_PENDING"
  | "ACTIVE"
  | "NEEDS_ATTENTION";

type DbClient = Prisma.TransactionClient | typeof prisma;
type DomainActivationCheckState = DomainActivationState | "CONNECTED";
type DnsRecordCheck = {
  values: string[];
  checked: boolean;
  error: string | null;
};

export type DomainActivationStatusCheckAdapters = {
  dns?: {
    cname(domain: string): Promise<string[]>;
    a(domain: string): Promise<string[]>;
    ns(domain: string): Promise<string[]>;
    soa(domain: string): Promise<string | null>;
  };
  storefront?: {
    check(domain: string): Promise<{
      httpStatus: number | null;
      httpsStatus: number | null;
      workerShimHeaderPresent: boolean;
      workerShimHeaderValue: string | null;
      googleFrontend404: boolean;
      hostingerDetected: boolean;
      apiResponseDetected: boolean;
      expectedRendererResponse: boolean;
    }>;
  };
  cloudflare?: {
    check(context: { domain: string; customHostnameId?: string | null }): Promise<{
      checked: boolean;
      status: string | null;
      customHostnameId?: string | null;
      sslStatus?: string | null;
      validationMethod?: string | null;
      validationRecordPresence?: boolean | null;
    }>;
  };
};

const DOMAIN_PATTERN = /^[a-z0-9.-]+$/;
const RESERVED_ACTIVATION_DOMAINS = new Set([
  "shipmastr.com",
  "www.shipmastr.com",
  "api.shipmastr.com",
  "admin.shipmastr.com",
  "seller.shipmastr.com",
  "courier.shipmastr.com",
  "storefront-origin.shipmastr.com",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1"
]);

const ACTIVATION_COPY: Record<DomainActivationState, { label: string; description: string; actionKey: string }> = {
  REQUESTED: {
    label: "Request received",
    description: "The merchant request is recorded and waiting for admin review.",
    actionKey: "ADMIN_REVIEW"
  },
  REVIEW_REQUIRED: {
    label: "Review required",
    description: "Review the merchant request before starting provider setup.",
    actionKey: "ADMIN_REVIEW"
  },
  ADMIN_APPROVED: {
    label: "Approved",
    description: "The domain request is approved. Provider setup has not started yet.",
    actionKey: "START_PROVIDER_SETUP"
  },
  PROVIDER_SETUP_READY: {
    label: "Provider setup ready",
    description: "The domain is approved and ready for an explicit admin provider setup action.",
    actionKey: "START_PROVIDER_SETUP"
  },
  PROVIDER_SETUP_STARTED: {
    label: "Setup started",
    description: "Provider setup has been explicitly started by an admin.",
    actionKey: "CONTINUE_SETUP"
  },
  DNS_INSTRUCTIONS_AVAILABLE: {
    label: "DNS instructions available",
    description: "Connection instructions are available for the merchant or operator.",
    actionKey: "VIEW_DNS_INSTRUCTIONS"
  },
  DNS_VALIDATED: {
    label: "DNS validated",
    description: "The connection record is verified and the secure certificate step is next.",
    actionKey: "WAIT_FOR_SSL"
  },
  INTAKE: {
    label: "Start intake",
    description: "Confirm merchant ownership, approved hostname, and activation scope.",
    actionKey: "START_INTAKE"
  },
  PROVIDER_VERIFICATION_PENDING: {
    label: "Wait for verification",
    description: "Registry, ownership, or merchant verification is still pending.",
    actionKey: "WAIT_FOR_PROVIDER_VERIFICATION"
  },
  CLOUDFLARE_HOSTNAME_CREATED: {
    label: "Add validation record",
    description: "The hostname exists and needs its public validation record to publish.",
    actionKey: "ADD_VALIDATION_RECORD"
  },
  TXT_VALIDATION_PENDING: {
    label: "Wait for TXT validation",
    description: "Public ownership validation is still propagating or being checked.",
    actionKey: "WAIT_FOR_TXT_VALIDATION"
  },
  CNAME_PENDING: {
    label: "Add CNAME",
    description: "Point the approved hostname to the storefront origin path.",
    actionKey: "ADD_CNAME"
  },
  WORKER_ROUTE_PENDING: {
    label: "Add Worker route",
    description: "Create the exact-host Worker route for this hostname.",
    actionKey: "ADD_WORKER_ROUTE"
  },
  STOREFRONT_MAPPING_PENDING: {
    label: "Link storefront",
    description: "Attach this hostname to the correct storefront record.",
    actionKey: "LINK_STOREFRONT"
  },
  SSL_PENDING: {
    label: "Wait for certificate",
    description: "The secure certificate is still issuing.",
    actionKey: "WAIT_FOR_SSL"
  },
  LIVE: {
    label: "Monitor live domain",
    description: "The hostname is mapped to a live storefront.",
    actionKey: "MONITOR_LIVE"
  },
  FAILED_NEEDS_REVIEW: {
    label: "Review with support",
    description: "A failed state needs admin review before another action.",
    actionKey: "REVIEW_FAILURE"
  },
  NEEDS_ATTENTION: {
    label: "Needs attention",
    description: "This request was rejected or needs manual admin review before setup can continue.",
    actionKey: "REVIEW_FAILURE"
  }
};

export function normalizeActivationDomain(input: string) {
  const raw = String(input || "").trim().toLowerCase();
  const withoutProtocol = raw.replace(/^https?:\/\//, "");
  const withoutPath = withoutProtocol.split(/[/?#]/)[0] || "";
  const domain = withoutPath.replace(/:\d{1,5}$/, "").replace(/\.$/, "");

  if (
    !domain ||
    domain.length > 253 ||
    !DOMAIN_PATTERN.test(domain) ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    throw new HttpError(400, "INVALID_DOMAIN");
  }

  if (
    RESERVED_ACTIVATION_DOMAINS.has(domain) ||
    domain.endsWith(".shipmastr.com") ||
    domain.endsWith(".run.app")
  ) {
    throw new HttpError(400, "DOMAIN_RESERVED_FOR_SHIPMASTR");
  }

  return domain;
}

function normalizeMerchantDomainForDiagnostics(domain: string) {
  try {
    return normalizeDomain(domain).normalizedDomain;
  } catch {
    return domain.replace(/^www\./, "");
  }
}

function safeDate(value?: Date | null) {
  return value ? value.toISOString() : null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function workflowRecord(value: unknown) {
  const record = jsonRecord(value);
  return jsonRecord(record.activationWorkflow);
}

function workflowStateFromRecords(value: unknown): DomainActivationWorkflowState | null {
  const record = jsonRecord(value);
  const workflow = workflowRecord(value);
  const state = String(workflow.state || record.workflowState || record.requestStatus || "").toUpperCase();
  switch (state) {
    case "PENDING_REVIEW":
    case "REQUESTED":
    case "MERCHANT_REQUESTED":
      return "MERCHANT_REQUESTED";
    case "IN_REVIEW":
    case "ADMIN_REVIEW_REQUIRED":
      return "ADMIN_REVIEW_REQUIRED";
    case "APPROVED":
    case "ADMIN_APPROVED":
      return "ADMIN_APPROVED";
    case "PROVIDER_SETUP_READY":
      return "PROVIDER_SETUP_READY";
    case "PROVIDER_SETUP_STARTED":
      return "PROVIDER_SETUP_STARTED";
    case "DNS_INSTRUCTIONS_AVAILABLE":
      return "DNS_INSTRUCTIONS_AVAILABLE";
    case "DNS_VALIDATED":
      return "DNS_VALIDATED";
    case "SSL_PENDING":
      return "SSL_PENDING";
    case "ACTIVE":
    case "LIVE":
      return "ACTIVE";
    case "REJECTED":
    case "NEEDS_ATTENTION":
      return "NEEDS_ATTENTION";
    default:
      return null;
  }
}

function dnsInstructionsFromRecords(value: unknown) {
  const instructions = jsonRecord(jsonRecord(value).dnsInstructions);
  const records = jsonArray(instructions.records).map((record) => ({
    type: typeof record.type === "string" ? record.type : null,
    name: typeof record.name === "string" ? record.name : null,
    value: typeof record.value === "string" ? record.value : null,
    ttl: typeof record.ttl === "string" || typeof record.ttl === "number" ? record.ttl : null,
    purpose: typeof record.purpose === "string" ? record.purpose : null
  }));

  return {
    available: instructions.available === true || records.length > 0,
    summary: typeof instructions.summary === "string" ? instructions.summary : null,
    records
  };
}

function workflowStateForMerchantDomain(merchantDomain?: any | null): DomainActivationWorkflowState | null {
  return workflowStateFromRecords(merchantDomain?.validationRecords);
}

function workflowIndicatesProviderSetupStarted(state: DomainActivationWorkflowState | null) {
  return Boolean(state && [
    "PROVIDER_SETUP_STARTED",
    "DNS_INSTRUCTIONS_AVAILABLE",
    "DNS_VALIDATED",
    "SSL_PENDING",
    "ACTIVE"
  ].includes(state));
}

function workflowUpdateRecords(input: {
  current: unknown;
  requestStatus: string;
  state: DomainActivationWorkflowState | "REJECTED";
  actorId?: string | undefined;
  note?: string | null | undefined;
  reason?: string | null | undefined;
  dnsInstructions?: Prisma.InputJsonValue | undefined;
}) {
  const current = jsonRecord(input.current);
  const currentWorkflow = workflowRecord(input.current);
  const now = new Date().toISOString();
  const activationWorkflow = {
    ...currentWorkflow,
    state: input.state,
    requestStatus: input.requestStatus,
    updatedAt: now,
    ...(input.actorId ? { updatedBy: input.actorId } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.reason ? { rejectionReason: input.reason } : {}),
    ...(input.state === "ADMIN_REVIEW_REQUIRED" ? { reviewedAt: now, reviewedBy: input.actorId || null } : {}),
    ...(input.state === "ADMIN_APPROVED" ? { approvedAt: now, approvedBy: input.actorId || null } : {}),
    ...(input.state === "PROVIDER_SETUP_STARTED" || input.state === "DNS_INSTRUCTIONS_AVAILABLE"
      ? { providerSetupStartedAt: now, providerSetupStartedBy: input.actorId || null, providerSetupStarted: true }
      : {})
  };

  return {
    ...current,
    requestStatus: input.requestStatus,
    activationWorkflow,
    ...(input.dnsInstructions !== undefined ? { dnsInstructions: input.dnsInstructions } : {})
  } as Prisma.InputJsonValue;
}

function summarizeActivationWorkflow(input: {
  merchantDomain?: any | null;
  storefrontDomain?: any | null;
  activationState: DomainActivationState;
}) {
  const workflowState = workflowStateForMerchantDomain(input.merchantDomain);
  const dnsInstructions = dnsInstructionsFromRecords(input.merchantDomain?.validationRecords);
  const providerSetupStarted = workflowIndicatesProviderSetupStarted(workflowState) || hasProviderSetupStarted(input);
  const dnsInstructionsVisible = dnsInstructions.available && providerSetupStarted;
  const approved =
    workflowState === "ADMIN_APPROVED" ||
    workflowState === "PROVIDER_SETUP_READY" ||
    providerSetupStarted ||
    input.activationState === "LIVE";
  const rejected = workflowState === "NEEDS_ATTENTION" || input.merchantDomain?.status === DomainStatus.FAILED;
  const state: DomainActivationWorkflowState =
    rejected
      ? "NEEDS_ATTENTION"
      : input.activationState === "LIVE"
        ? "ACTIVE"
        : dnsInstructionsVisible
          ? "DNS_INSTRUCTIONS_AVAILABLE"
          : workflowState === "PROVIDER_SETUP_STARTED"
            ? "PROVIDER_SETUP_STARTED"
            : approved
              ? "ADMIN_APPROVED"
              : input.activationState === "REVIEW_REQUIRED"
                ? "ADMIN_REVIEW_REQUIRED"
                : "MERCHANT_REQUESTED";

  return {
    state,
    approved,
    rejected,
    providerSetupStarted,
    providerActionsAllowed: approved && !rejected,
    providerGateReason: approved ? null : "Approve this domain request before provider setup actions.",
    dnsInstructionsAvailable: dnsInstructionsVisible,
    dnsInstructionsPending: providerSetupStarted && !dnsInstructions.available,
    dnsInstructions: dnsInstructionsVisible ? dnsInstructions : null,
    note: typeof workflowRecord(input.merchantDomain?.validationRecords).note === "string"
      ? workflowRecord(input.merchantDomain?.validationRecords).note
      : null,
    rejectionReason: typeof workflowRecord(input.merchantDomain?.validationRecords).rejectionReason === "string"
      ? workflowRecord(input.merchantDomain?.validationRecords).rejectionReason
      : null
  };
}

function summarizeStorefrontDomain(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    isPrimary: Boolean(row.isPrimary),
    verificationStatus: row.verificationStatus || null,
    dnsTarget: row.dnsTarget || null,
    sslStatus: row.sslStatus || null,
    failureReason: row.failureReason || null,
    lastCheckedAt: safeDate(row.lastCheckedAt),
    updatedAt: safeDate(row.updatedAt)
  };
}

function summarizeDbMapping(row: any) {
  if (!row) {
    return {
      exists: false,
      domain: null,
      status: "NOT_FOUND",
      storefrontId: null,
      storefrontName: null,
      merchantId: null,
      isPrimary: false,
      lastCheckedAt: null
    };
  }

  return {
    exists: true,
    domain: row.domain,
    status: row.status,
    storefrontId: row.storefrontId,
    storefrontName: row.storefront?.name || null,
    merchantId: row.storefront?.merchantId || null,
    isPrimary: Boolean(row.isPrimary),
    lastCheckedAt: safeDate(row.lastCheckedAt || row.updatedAt)
  };
}

function summarizeStorefront(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    merchantId: row.merchantId,
    merchant: row.merchant
      ? {
          id: row.merchant.id,
          name: row.merchant.name,
          email: row.merchant.email
        }
      : null
  };
}

function summarizeMerchantDomain(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    normalizedDomain: row.normalizedDomain,
    status: row.status,
    provider: row.provider,
    source: row.source,
    cloudflareCustomHostnameStatus: row.cloudflareCustomHostnameStatus || null,
    dnsValidationStatus: row.dnsValidationStatus || null,
    sslStatus: row.sslStatus || null,
    lastCheckedAt: safeDate(row.lastCheckedAt),
    updatedAt: safeDate(row.updatedAt)
  };
}

function hasProviderSetupStarted(input: { merchantDomain?: any | null; storefrontDomain?: any | null }) {
  const merchantDomain = input.merchantDomain || null;
  const storefrontDomain = input.storefrontDomain || null;
  const workflowState = workflowStateForMerchantDomain(merchantDomain);
  return Boolean(
    workflowIndicatesProviderSetupStarted(workflowState) ||
      merchantDomain?.cloudflareCustomHostnameId ||
      merchantDomain?.cloudflareCustomHostnameStatus ||
      merchantDomain?.dnsValidationStatus ||
      merchantDomain?.sslStatus ||
      storefrontDomain?.cloudflareCustomHostnameId ||
      storefrontDomain?.verificationStatus ||
      storefrontDomain?.dnsTarget ||
      storefrontDomain?.sslStatus
  );
}

function isReviewOnlyMerchantDomain(input: { merchantDomain?: any | null; storefrontDomain?: any | null }) {
  const status = String(input.merchantDomain?.status || "").toUpperCase();
  return status === DomainStatus.REQUESTED && !hasProviderSetupStarted(input);
}

function determineActivationState(input: {
  storefrontDomain: any | null;
  merchantDomain: any | null;
  storefrontLookupStatus: string;
}): DomainActivationState {
  const storefrontDomainStatus = input.storefrontDomain?.status;
  const merchantDomainStatus = input.merchantDomain?.status;
  const sslStatus = String(input.storefrontDomain?.sslStatus || input.merchantDomain?.sslStatus || "").toLowerCase();
  const dnsValidationStatus = String(input.merchantDomain?.dnsValidationStatus || input.storefrontDomain?.verificationStatus || "").toLowerCase();
  const hostnameStatus = String(input.merchantDomain?.cloudflareCustomHostnameStatus || "").toLowerCase();
  const workflowState = workflowStateForMerchantDomain(input.merchantDomain);
  const dnsInstructions = dnsInstructionsFromRecords(input.merchantDomain?.validationRecords);

  if (storefrontDomainStatus === DomainStatus.FAILED || storefrontDomainStatus === DomainStatus.SUSPENDED || merchantDomainStatus === DomainStatus.FAILED) {
    return "FAILED_NEEDS_REVIEW";
  }

  if (storefrontDomainStatus === DomainStatus.ACTIVE && input.storefrontLookupStatus === "ACTIVE") {
    return "LIVE";
  }

  if (workflowState === "NEEDS_ATTENTION") return "NEEDS_ATTENTION";
  if (workflowState === "DNS_VALIDATED") return "DNS_VALIDATED";
  if (workflowState === "DNS_INSTRUCTIONS_AVAILABLE" || dnsInstructions.available) return "DNS_INSTRUCTIONS_AVAILABLE";
  if (workflowState === "PROVIDER_SETUP_STARTED") return "PROVIDER_SETUP_STARTED";
  if (workflowState === "PROVIDER_SETUP_READY") return "PROVIDER_SETUP_READY";
  if (workflowState === "ADMIN_APPROVED") return "ADMIN_APPROVED";

  if (isReviewOnlyMerchantDomain(input)) {
    return "REVIEW_REQUIRED";
  }

  if (!input.storefrontDomain) {
    return "STOREFRONT_MAPPING_PENDING";
  }

  if (storefrontDomainStatus === DomainStatus.SSL_PENDING || sslStatus.includes("pending") || sslStatus.includes("initializing")) {
    return "SSL_PENDING";
  }

  if (storefrontDomainStatus === DomainStatus.CLOUDFLARE_PENDING || hostnameStatus === "active") {
    if (dnsValidationStatus.includes("accepted") || dnsValidationStatus.includes("propagated")) {
      return "CNAME_PENDING";
    }
    return "TXT_VALIDATION_PENDING";
  }

  if (merchantDomainStatus === DomainStatus.REGISTERING || merchantDomainStatus === DomainStatus.REGISTERED) {
    return "PROVIDER_VERIFICATION_PENDING";
  }

  if (input.merchantDomain?.cloudflareCustomHostnameId || hostnameStatus) {
    return "CLOUDFLARE_HOSTNAME_CREATED";
  }

  return "INTAKE";
}

async function getStorefrontDomainForActivation(domain: string, client: DbClient) {
  return client.storefrontDomain.findUnique({
    where: { domain },
    include: {
      storefront: {
        include: {
          merchant: true,
          settings: true
        }
      }
    }
  });
}

async function dnsCheck(operation: () => Promise<string[]>): Promise<DnsRecordCheck> {
  try {
    return { values: await operation(), checked: true, error: null };
  } catch (error) {
    return {
      values: [],
      checked: true,
      error: error instanceof Error ? error.message : "DNS_LOOKUP_FAILED"
    };
  }
}

function defaultStatusCheckDnsAdapter() {
  return {
    cname: (domain: string) => resolveCname(domain),
    a: (domain: string) => resolve4(domain),
    ns: (domain: string) => resolveNs(domain),
    async soa(domain: string) {
      const record = await resolveSoa(domain);
      return `${record.nsname} ${record.hostmaster}`;
    }
  };
}

function responseLooksLikeGoogleFrontend404(status: number, server: string, body: string) {
  return status === 404 && /google frontend|404 not found/i.test(`${server} ${body}`);
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function defaultStatusCheckStorefrontAdapter() {
  return {
    async check(domain: string) {
      let httpStatus: number | null = null;
      let httpsStatus: number | null = null;
      let workerShimHeaderValue: string | null = null;
      let googleFrontend404 = false;
      let hostingerDetected = false;
      let apiResponseDetected = false;
      let expectedRendererResponse = false;

      try {
        const httpResponse = await fetchWithTimeout(`http://${domain}/`);
        httpStatus = httpResponse.status;
      } catch {
        httpStatus = null;
      }

      try {
        const httpsResponse = await fetchWithTimeout(`https://${domain}/`);
        httpsStatus = httpsResponse.status;
        workerShimHeaderValue = httpsResponse.headers.get("x-shipmastr-origin-shim");
        const server = httpsResponse.headers.get("server") || "";
        const body = await httpsResponse.text().catch(() => "");
        googleFrontend404 = responseLooksLikeGoogleFrontend404(httpsResponse.status, server, body);
        hostingerDetected = /hostinger|hpanel|parkpage/i.test(body);
        apiResponseDetected = /shipmastr-api|api\.shipmastr|\"service\":\"shipmastr-api\"/i.test(body);
        expectedRendererResponse =
          /powered by shipmastr|shipmastr storefront|shipmastr demo store|storefront/i.test(body) &&
          !googleFrontend404 &&
          !hostingerDetected &&
          !apiResponseDetected;
      } catch {
        httpsStatus = null;
      }

      return {
        httpStatus,
        httpsStatus,
        workerShimHeaderPresent: workerShimHeaderValue === "cloudflare-worker",
        workerShimHeaderValue,
        googleFrontend404,
        hostingerDetected,
        apiResponseDetected,
        expectedRendererResponse
      };
    }
  };
}

function cloudflareAuthIsConfigured() {
  if (!env.CLOUDFLARE_ZONE_ID) return false;
  try {
    buildCloudflareHeaders(env);
    return true;
  } catch {
    return false;
  }
}

function defaultStatusCheckCloudflareAdapter() {
  return {
    async check(context: { domain: string; customHostnameId?: string | null }) {
      if (!context.customHostnameId) {
        return {
          checked: false,
          status: "not_checked_no_custom_hostname_id"
        };
      }

      if (!cloudflareAuthIsConfigured()) {
        return {
          checked: false,
          customHostnameId: context.customHostnameId,
          status: "not_checked_auth_missing"
        };
      }

      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${encodeURIComponent(context.customHostnameId)}`,
        { method: "GET", headers: buildCloudflareHeaders(env) }
      );
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          checked: true,
          customHostnameId: context.customHostnameId,
          status: `HTTP_${response.status}`,
          sslStatus: null,
          validationMethod: null,
          validationRecordPresence: null
        };
      }

      const result = raw?.result || {};
      return {
        checked: true,
        customHostnameId: result.id || context.customHostnameId,
        status: result.status || null,
        sslStatus: result.ssl?.status || null,
        validationMethod: result.ssl?.method || null,
        validationRecordPresence: Boolean(result.ownership_verification || result.ownership_verification_http || result.verification_records)
      };
    }
  };
}

function statusCheckAdapters(adapters: DomainActivationStatusCheckAdapters = {}) {
  return {
    dns: adapters.dns || defaultStatusCheckDnsAdapter(),
    storefront: adapters.storefront || defaultStatusCheckStorefrontAdapter(),
    cloudflare: adapters.cloudflare || defaultStatusCheckCloudflareAdapter()
  };
}

function deriveStatusCheckActivationState(input: {
  dbMapping: ReturnType<typeof summarizeDbMapping>;
  publicLookupStatus: string;
  dns: { cname: DnsRecordCheck; a: DnsRecordCheck };
  storefront: {
    httpsStatus: number | null;
    workerShimHeaderPresent: boolean;
    googleFrontend404: boolean;
    hostingerDetected: boolean;
    apiResponseDetected: boolean;
    expectedRendererResponse: boolean;
  };
  cloudflareStatus: string | null;
  sslStatus?: string | null;
  merchantDomainStatus?: string | null;
  providerSetupStarted?: boolean;
  workflowState?: DomainActivationWorkflowState | null;
  dnsInstructionsAvailable?: boolean;
}): DomainActivationCheckState {
  if (input.storefront.googleFrontend404 || input.storefront.hostingerDetected || input.storefront.apiResponseDetected) {
    return "FAILED_NEEDS_REVIEW";
  }

  if (input.workflowState === "NEEDS_ATTENTION") return "NEEDS_ATTENTION";
  if (input.workflowState === "ADMIN_APPROVED" || input.workflowState === "PROVIDER_SETUP_READY") return "PROVIDER_SETUP_READY";
  if (input.workflowState === "DNS_INSTRUCTIONS_AVAILABLE" || input.dnsInstructionsAvailable) return "DNS_INSTRUCTIONS_AVAILABLE";
  if (input.workflowState === "PROVIDER_SETUP_STARTED") return "PROVIDER_SETUP_STARTED";
  if (input.workflowState === "DNS_VALIDATED") return "DNS_VALIDATED";

  if (String(input.merchantDomainStatus || "").toUpperCase() === DomainStatus.REQUESTED && !input.providerSetupStarted) {
    return "REVIEW_REQUIRED";
  }

  if (!input.dbMapping.exists) return "STOREFRONT_MAPPING_PENDING";

  const hasDnsAnswer = input.dns.cname.values.length > 0 || input.dns.a.values.length > 0;
  if (!hasDnsAnswer) return "CNAME_PENDING";

  const sslReady = ["active", "issued", "valid", "verified"].includes(String(input.sslStatus || "").toLowerCase());
  const httpsReady = input.storefront.httpsStatus !== null && input.storefront.httpsStatus >= 200 && input.storefront.httpsStatus < 400;
  if (!httpsReady) return "SSL_PENDING";

  if (
    input.dbMapping.status === DomainStatus.ACTIVE &&
    input.publicLookupStatus === "ACTIVE" &&
    input.storefront.workerShimHeaderPresent &&
    input.storefront.expectedRendererResponse
  ) {
    return "LIVE";
  }

  if (sslReady || httpsReady) return "CONNECTED";
  return "WORKER_ROUTE_PENDING";
}

function nextActionForStatusCheck(state: DomainActivationCheckState, warnings: string[]) {
  if (state === "CONNECTED") {
    return {
      label: "Confirm storefront content",
      description: "HTTPS is reachable; confirm Worker routing, storefront lookup, and final live status.",
      actionKey: "CONFIRM_STOREFRONT"
    };
  }

  if (warnings.length > 0 && state === "LIVE") {
    return {
      label: "Review warnings",
      description: "The storefront appears live, but one or more checks produced a warning.",
      actionKey: "REVIEW_WARNINGS"
    };
  }

  return ACTIVATION_COPY[state] || ACTIVATION_COPY.FAILED_NEEDS_REVIEW;
}

function publicLookupSummary(row: Awaited<ReturnType<typeof getStorefrontByDomain>> | null) {
  if (!row) {
    return {
      checked: true,
      status: "NOT_FOUND",
      payload: null
    };
  }

  return {
    checked: true,
    status: row.status,
    payload: {
      domain: row.domain,
      storeName: row.storeName,
      status: row.status,
      themeJson: row.themeJson
    }
  };
}

export async function checkAdminDomainActivationStatus(input: {
  domain: string;
  actorId?: string | undefined;
  client?: DbClient;
  adapters?: DomainActivationStatusCheckAdapters;
}) {
  const client = input.client || prisma;
  const normalizedDomain = normalizeActivationDomain(input.domain);
  const merchantDomainKey = normalizeMerchantDomainForDiagnostics(normalizedDomain);
  const adapters = statusCheckAdapters(input.adapters);

  const [storefrontDomain, merchantDomain, publicLookup, cname, a, ns, soa, storefront] = await Promise.all([
    getStorefrontDomainForActivation(normalizedDomain, client),
    client.merchantDomain.findUnique({ where: { normalizedDomain: merchantDomainKey } }),
    getStorefrontByDomain(normalizedDomain, client as any),
    dnsCheck(() => adapters.dns.cname(normalizedDomain)),
    dnsCheck(() => adapters.dns.a(normalizedDomain)),
    dnsCheck(() => adapters.dns.ns(normalizedDomain)),
    dnsCheck(async () => {
      const value = await adapters.dns.soa(normalizedDomain);
      return value ? [value] : [];
    }),
    adapters.storefront.check(normalizedDomain)
  ]);

  const merchantDomainAny = merchantDomain as any | null;
  const cloudflareCustomHostnameId =
    storefrontDomain?.cloudflareCustomHostnameId ||
    merchantDomainAny?.cloudflareCustomHostnameId ||
    null;
  const cloudflare = await adapters.cloudflare.check({
    domain: normalizedDomain,
    customHostnameId: cloudflareCustomHostnameId
  });
  const dbMapping = summarizeDbMapping(storefrontDomain);
  const publicLookupResult = publicLookupSummary(publicLookup);
  const workflowState = workflowStateForMerchantDomain(merchantDomainAny);
  const dnsInstructions = dnsInstructionsFromRecords(merchantDomainAny?.validationRecords);
  const tls = {
    httpsSucceeded: storefront.httpsStatus !== null && storefront.httpsStatus >= 200 && storefront.httpsStatus < 400,
    status: storefront.httpsStatus,
    sslStatus: cloudflare.sslStatus || storefrontDomain?.sslStatus || merchantDomainAny?.sslStatus || null
  };
  const warnings: string[] = [];
  if (!dbMapping.exists) warnings.push("STOREFRONT_DOMAIN_ROW_MISSING");
  if (publicLookupResult.status !== "ACTIVE") warnings.push("PUBLIC_LOOKUP_NOT_ACTIVE");
  if (cname.values.length === 0 && a.values.length === 0) warnings.push("DNS_TARGET_MISSING");
  if (!storefront.workerShimHeaderPresent) warnings.push("WORKER_SHIM_HEADER_MISSING");
  if (storefront.googleFrontend404) warnings.push("GOOGLE_FRONTEND_404_DETECTED");
  if (storefront.hostingerDetected) warnings.push("HOSTINGER_PAGE_DETECTED");
  if (storefront.apiResponseDetected) warnings.push("API_RESPONSE_DETECTED");
  if (!tls.httpsSucceeded) warnings.push("HTTPS_NOT_REACHABLE");
  if (cloudflare.status === "not_checked_auth_missing") warnings.push("CLOUDFLARE_AUTH_MISSING_NON_FATAL");

  const activationState = deriveStatusCheckActivationState({
    dbMapping,
    publicLookupStatus: publicLookupResult.status,
    dns: { cname, a },
    storefront,
    cloudflareStatus: cloudflare.status,
    sslStatus: tls.sslStatus,
    merchantDomainStatus: merchantDomainAny?.status || null,
    providerSetupStarted: hasProviderSetupStarted({ merchantDomain: merchantDomainAny, storefrontDomain }),
    workflowState,
    dnsInstructionsAvailable: dnsInstructions.available
  });
  const checkedAt = new Date();
  const nextAction = nextActionForStatusCheck(activationState, warnings);

  await client.auditLog.create({
    data: {
      ...(dbMapping.merchantId ? { merchantId: dbMapping.merchantId } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
      action: "DOMAIN_STATUS_CHECKED",
      entityType: "StorefrontDomain",
      entityId: storefrontDomain?.id || normalizedDomain,
      metadata: {
        domain: normalizedDomain,
        readOnly: true,
        activationState,
        warnings,
        providerMutation: false,
        dnsChanged: false,
        cloudflareMutation: false,
        resellerClubMutation: false,
        emailSent: false
      } as Prisma.InputJsonValue
    }
  });

  return {
    domain: input.domain,
    normalizedDomain,
    checkedAt: checkedAt.toISOString(),
    activationState,
    dbMapping,
    publicLookup: publicLookupResult,
    dns: {
      cname,
      a,
      ns,
      soa
    },
    storefront,
    tls,
    cloudflare,
    nextAction,
    warnings
  };
}

export async function getAdminDomainActivationOverview(input: { domain: string; client?: DbClient }) {
  const client = input.client || prisma;
  const normalizedDomain = normalizeActivationDomain(input.domain);
  const merchantDomainKey = normalizeMerchantDomainForDiagnostics(normalizedDomain);

  const [storefrontDomain, merchantDomain, storefrontLookup] = await Promise.all([
    getStorefrontDomainForActivation(normalizedDomain, client),
    client.merchantDomain.findUnique({ where: { normalizedDomain: merchantDomainKey } }),
    getStorefrontByDomain(normalizedDomain, client as any)
  ]);

  const merchantDomainAny = merchantDomain as any | null;
  const storefrontLookupStatus = storefrontLookup?.status || "NOT_FOUND";
  const activationState = determineActivationState({
    storefrontDomain,
    merchantDomain: merchantDomainAny,
    storefrontLookupStatus
  });
  const nextAction = ACTIVATION_COPY[activationState];
  const workflow = summarizeActivationWorkflow({
    merchantDomain: merchantDomainAny,
    storefrontDomain,
    activationState
  });
  const lastCheckedAt =
    storefrontDomain?.lastCheckedAt ||
    merchantDomain?.lastCheckedAt ||
    storefrontDomain?.updatedAt ||
    merchantDomain?.updatedAt ||
    null;

  return {
    domain: input.domain,
    normalizedDomain,
    storefrontDomainStatus: storefrontDomain?.status || "NOT_FOUND",
    storefrontLookupStatus,
    storefront: summarizeStorefront(storefrontDomain?.storefront),
    merchant: storefrontDomain?.storefront?.merchant
      ? {
          id: storefrontDomain.storefront.merchant.id,
          name: storefrontDomain.storefront.merchant.name,
          email: storefrontDomain.storefront.merchant.email
        }
      : null,
    activationState,
    workflow,
    nextAction,
    lastCheckedAt: safeDate(lastCheckedAt),
    diagnostics: {
      merchantDomain: summarizeMerchantDomain(merchantDomainAny),
      storefrontDomain: summarizeStorefrontDomain(storefrontDomain),
      storefrontLookup: storefrontLookup
        ? {
            domain: storefrontLookup.domain,
            storeName: storefrontLookup.storeName,
            status: storefrontLookup.status
          }
        : null,
      cloudflareCustomHostnameStatus: merchantDomainAny?.cloudflareCustomHostnameStatus || null,
      dnsValidationStatus: merchantDomainAny?.dnsValidationStatus || storefrontDomain?.verificationStatus || null,
      workerRouteStatus: storefrontDomain ? "MANUAL_CHECK_REQUIRED" : "NOT_LINKED",
      sslStatus: storefrontDomain?.sslStatus || merchantDomainAny?.sslStatus || null,
      placeholders: {
        checkStatus: "read-only only",
        linkStorefront: "db-only upsert",
        markDnsRecordAdded: "disabled placeholder",
        markWorkerRouteAdded: "disabled placeholder",
        markLive: "disabled placeholder"
      }
    }
  };
}

async function getMerchantDomainForAdminAction(domain: string, client: DbClient) {
  const normalizedDomain = normalizeActivationDomain(domain);
  const merchantDomainKey = normalizeMerchantDomainForDiagnostics(normalizedDomain);
  const merchantDomain = await client.merchantDomain.findUnique({
    where: { normalizedDomain: merchantDomainKey }
  });
  if (!merchantDomain) throw new HttpError(404, "DOMAIN_REQUEST_NOT_FOUND");
  return { normalizedDomain, merchantDomain: merchantDomain as any };
}

async function writeDomainWorkflowEvent(input: {
  client: DbClient;
  merchantDomain: any;
  eventType: string;
  status?: DomainProvisioningStatus;
  provider?: DomainProvider;
  payload: Prisma.InputJsonValue;
  safeMessage: string;
}) {
  await input.client.domainProvisioningEvent.create({
    data: {
      merchantId: input.merchantDomain.merchantId,
      merchantDomainId: input.merchantDomain.id,
      storefrontId: input.merchantDomain.storefrontId || null,
      provider: input.provider || DomainProvider.MANUAL,
      eventType: input.eventType,
      status: input.status || DomainProvisioningStatus.SUCCEEDED,
      payload: input.payload,
      safeMessage: input.safeMessage
    }
  });
}

async function updateDomainWorkflow(input: {
  pathDomain: string;
  actorId?: string | undefined;
  note?: string | null | undefined;
  reason?: string | null | undefined;
  action: "review" | "approve" | "reject" | "start-provider-setup";
  dnsInstructions?: Prisma.InputJsonValue | undefined;
  client: DbClient;
}) {
  const { normalizedDomain, merchantDomain } = await getMerchantDomainForAdminAction(input.pathDomain, input.client);
  const note = String(input.note || "").trim() || null;
  const reason = String(input.reason || "").trim() || null;

  if (input.action === "reject" && !reason) {
    throw new HttpError(400, "REJECTION_REASON_REQUIRED");
  }

  const currentWorkflowState = workflowStateForMerchantDomain(merchantDomain);
  if (input.action === "start-provider-setup") {
    const approved =
      currentWorkflowState === "ADMIN_APPROVED" ||
      currentWorkflowState === "PROVIDER_SETUP_READY" ||
      workflowIndicatesProviderSetupStarted(currentWorkflowState) ||
      merchantDomain.status === DomainStatus.APPROVAL_REQUIRED;
    if (!approved) throw new HttpError(409, "DOMAIN_REQUEST_APPROVAL_REQUIRED");
  }

  const actionConfig = {
    review: {
      requestStatus: "IN_REVIEW",
      workflowState: "ADMIN_REVIEW_REQUIRED" as const,
      domainStatus: DomainStatus.REQUESTED,
      provider: DomainProvider.MANUAL,
      eventType: "DOMAIN_ACTIVATION_REVIEWED",
      eventStatus: DomainProvisioningStatus.SUCCEEDED,
      safeMessage: "Domain request marked for admin review"
    },
    approve: {
      requestStatus: "APPROVED",
      workflowState: "ADMIN_APPROVED" as const,
      domainStatus: DomainStatus.APPROVAL_REQUIRED,
      provider: DomainProvider.MANUAL,
      eventType: "DOMAIN_ACTIVATION_APPROVED",
      eventStatus: DomainProvisioningStatus.SUCCEEDED,
      safeMessage: "Domain request approved by Shipmastr admin"
    },
    reject: {
      requestStatus: "REJECTED",
      workflowState: "NEEDS_ATTENTION" as const,
      domainStatus: DomainStatus.FAILED,
      provider: DomainProvider.MANUAL,
      eventType: "DOMAIN_ACTIVATION_REJECTED",
      eventStatus: DomainProvisioningStatus.FAILED,
      safeMessage: "Domain request needs manual support review"
    },
    "start-provider-setup": {
      requestStatus: "PROVIDER_SETUP_STARTED",
      workflowState: input.dnsInstructions ? "DNS_INSTRUCTIONS_AVAILABLE" as const : "PROVIDER_SETUP_STARTED" as const,
      domainStatus: DomainStatus.CLOUDFLARE_PENDING,
      provider: DomainProvider.CLOUDFLARE,
      eventType: "DOMAIN_PROVIDER_SETUP_STARTED",
      eventStatus: DomainProvisioningStatus.PROCESSING,
      safeMessage: "Domain setup started by Shipmastr admin"
    }
  }[input.action];

  const validationRecords = workflowUpdateRecords({
    current: merchantDomain.validationRecords,
    requestStatus: actionConfig.requestStatus,
    state: actionConfig.workflowState,
    actorId: input.actorId,
    note,
    reason,
    dnsInstructions: input.dnsInstructions
  });

  const updated = await input.client.merchantDomain.update({
    where: { id: merchantDomain.id },
    data: {
      status: actionConfig.domainStatus,
      provider: actionConfig.provider,
      validationRecords,
      lastCheckedAt: new Date()
    }
  });

  await writeDomainWorkflowEvent({
    client: input.client,
    merchantDomain: updated,
    eventType: actionConfig.eventType,
    status: actionConfig.eventStatus,
    provider: actionConfig.provider,
    payload: {
      domain: normalizedDomain,
      action: input.action,
      workflowState: actionConfig.workflowState,
      providerMutation: false,
      dnsChanged: false,
      cloudflareMutation: false,
      workerRouteChanged: false,
      emailSent: false,
      ...(note ? { note } : {}),
      ...(reason ? { reason } : {})
    } as Prisma.InputJsonValue,
    safeMessage: actionConfig.safeMessage
  });

  return getAdminDomainActivationOverview({ domain: normalizedDomain, client: input.client });
}

export async function reviewAdminDomainRequest(input: {
  domain: string;
  actorId?: string | undefined;
  note?: string | null | undefined;
  client?: DbClient;
}) {
  const work = (client: DbClient) => updateDomainWorkflow({
    pathDomain: input.domain,
    actorId: input.actorId,
    note: input.note,
    action: "review",
    client
  });
  if (input.client) return work(input.client);
  return prisma.$transaction((tx) => work(tx));
}

export async function approveAdminDomainRequest(input: {
  domain: string;
  actorId?: string | undefined;
  note?: string | null | undefined;
  client?: DbClient;
}) {
  const work = (client: DbClient) => updateDomainWorkflow({
    pathDomain: input.domain,
    actorId: input.actorId,
    note: input.note,
    action: "approve",
    client
  });
  if (input.client) return work(input.client);
  return prisma.$transaction((tx) => work(tx));
}

export async function rejectAdminDomainRequest(input: {
  domain: string;
  actorId?: string | undefined;
  reason: string;
  client?: DbClient;
}) {
  const work = (client: DbClient) => updateDomainWorkflow({
    pathDomain: input.domain,
    actorId: input.actorId,
    reason: input.reason,
    action: "reject",
    client
  });
  if (input.client) return work(input.client);
  return prisma.$transaction((tx) => work(tx));
}

export async function startAdminDomainProviderSetup(input: {
  domain: string;
  confirmDomain: string;
  actorId?: string | undefined;
  note?: string | null | undefined;
  dnsInstructions?: Prisma.InputJsonValue | undefined;
  client?: DbClient;
}) {
  const normalizedDomain = normalizeActivationDomain(input.domain);
  const confirmDomain = normalizeActivationDomain(input.confirmDomain);
  if (confirmDomain !== normalizedDomain) throw new HttpError(400, "DOMAIN_CONFIRMATION_MISMATCH");
  const work = (client: DbClient) => updateDomainWorkflow({
    pathDomain: normalizedDomain,
    actorId: input.actorId,
    note: input.note,
    action: "start-provider-setup",
    dnsInstructions: input.dnsInstructions,
    client
  });
  if (input.client) return work(input.client);
  return prisma.$transaction((tx) => work(tx));
}

export async function getAdminDomainDnsInstructions(input: { domain: string; client?: DbClient }) {
  const client = input.client || prisma;
  const { normalizedDomain, merchantDomain } = await getMerchantDomainForAdminAction(input.domain, client);
  const instructions = dnsInstructionsFromRecords(merchantDomain.validationRecords);
  const workflowState = workflowStateForMerchantDomain(merchantDomain);
  const providerSetupStarted = workflowIndicatesProviderSetupStarted(workflowState);
  const available = instructions.available && providerSetupStarted;
  return {
    domain: normalizedDomain,
    available,
    workflowState,
    instructions: available ? instructions : null,
    nextAction: available
      ? "Share these connection instructions with the merchant or operator."
      : providerSetupStarted
        ? "Provider setup has started. DNS instructions are pending preparation."
        : "DNS instructions are not available until provider setup has explicitly started."
  };
}

export async function linkAdminDomainStorefront(input: {
  pathDomain: string;
  domain?: string | undefined;
  storefrontId: string;
  isPrimary?: boolean | undefined;
  client?: DbClient;
}) {
  const pathDomain = normalizeActivationDomain(input.pathDomain);
  const requestedDomain = normalizeActivationDomain(input.domain || input.pathDomain);
  if (requestedDomain !== pathDomain) {
    throw new HttpError(400, "DOMAIN_MISMATCH");
  }

  const work = async (client: DbClient) => {
    const storefront = await client.storefront.findUnique({
      where: { id: input.storefrontId },
      include: {
        merchant: true
      }
    });
    if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

    if (input.isPrimary) {
      await client.storefrontDomain.updateMany({
        where: { storefrontId: storefront.id },
        data: { isPrimary: false }
      });
    }

    const existing = await client.storefrontDomain.findUnique({
      where: { domain: requestedDomain },
      select: { id: true, status: true }
    });

    const domain = await client.storefrontDomain.upsert({
      where: { domain: requestedDomain },
      update: {
        storefrontId: storefront.id,
        isPrimary: Boolean(input.isPrimary),
        lastCheckedAt: new Date()
      },
      create: {
        storefrontId: storefront.id,
        domain: requestedDomain,
        status: DomainStatus.REQUESTED,
        isPrimary: Boolean(input.isPrimary),
        lastCheckedAt: new Date()
      }
    });

    const payload: Prisma.InputJsonValue = {
      domain: requestedDomain,
      storefrontId: storefront.id,
      previousStatus: existing?.status || null,
      newStatus: domain.status,
      isPrimary: Boolean(input.isPrimary),
      providerMutation: false
    };

    await client.domainProvisioningEvent.create({
      data: {
        merchantId: storefront.merchantId,
        storefrontId: storefront.id,
        storefrontDomainId: domain.id,
        provider: DomainProvider.MANUAL,
        eventType: "STOREFRONT_DOMAIN_LINKED",
        status: DomainProvisioningStatus.SUCCEEDED,
        payload,
        safeMessage: "Storefront domain linked by Shipmastr admin"
      }
    });

    return getAdminDomainActivationOverview({ domain: requestedDomain, client });
  };

  if (input.client) {
    return work(input.client);
  }

  return prisma.$transaction((tx) => work(tx));
}
