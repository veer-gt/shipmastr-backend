import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import {
  buildCloudflareCustomHostnameBody,
  buildCloudflareHeaders,
  resolveCloudflareAuthMode,
  type CloudflareHeaderSource
} from "./providers/cloudflare.service.js";
import { normalizeActivationDomain } from "./domain-activation.service.js";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const ORIGIN_SHIM_WORKER_SCRIPT = "shipmastr-origin-shim";
const FORBIDDEN_PLATFORM_HOSTS = new Set([
  "shipmastr.com",
  "www.shipmastr.com",
  "api.shipmastr.com",
  "admin.shipmastr.com",
  "seller.shipmastr.com",
  "courier.shipmastr.com",
  "storefront-origin.shipmastr.com"
]);

type CloudflareAdminSource = CloudflareHeaderSource & {
  CLOUDFLARE_ZONE_ID?: string | undefined;
  ALLOW_CLOUDFLARE_ADMIN_MUTATIONS?: boolean | string | undefined;
  ALLOW_APEX_DOMAIN_AUTOMATION?: boolean | string | undefined;
};

type CloudflareFetch = typeof fetch;

export type CloudflareAdminMutationInput = {
  domain: string;
  confirmDomain?: string | undefined;
  dryRun?: boolean | undefined;
  source?: CloudflareAdminSource | undefined;
  fetchFn?: CloudflareFetch | undefined;
};

export type CloudflareValidationRecordsInput = {
  domain: string;
  source?: CloudflareAdminSource | undefined;
  fetchFn?: CloudflareFetch | undefined;
};

function envFlag(value: unknown) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(normalized);
}

function shortId(value: unknown) {
  const id = String(value || "");
  if (!id) return null;
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function zoneIdFromSource(source: CloudflareAdminSource) {
  const zoneId = String(source.CLOUDFLARE_ZONE_ID || "").trim();
  if (!zoneId) throw new HttpError(503, "CLOUDFLARE_ZONE_ID_MISSING");
  return zoneId;
}

function assertScopedCloudflareAuth(source: CloudflareAdminSource) {
  const authMode = resolveCloudflareAuthMode(source);
  if (authMode !== "api_token") {
    throw new HttpError(403, "CLOUDFLARE_GLOBAL_KEY_NOT_ALLOWED_FOR_ADMIN_AUTOMATION");
  }
  return buildCloudflareHeaders(source);
}

function isLikelyApexDomain(domain: string) {
  const labels = domain.split(".");
  if (domain === "shipmastr.co.in") return true;
  if (domain.endsWith(".co.in") && labels.length === 3) return true;
  return labels.length <= 2;
}

function normalizeCloudflareAdminDomain(input: string) {
  if (String(input || "").includes("*")) throw new HttpError(400, "WILDCARD_DOMAIN_NOT_ALLOWED");
  return normalizeActivationDomain(input);
}

function assertMutationDomainAllowed(domain: string, source: CloudflareAdminSource) {
  if (domain.includes("*")) throw new HttpError(400, "WILDCARD_DOMAIN_NOT_ALLOWED");
  if (FORBIDDEN_PLATFORM_HOSTS.has(domain) || domain.endsWith(".shipmastr.com")) {
    throw new HttpError(400, "DOMAIN_RESERVED_FOR_SHIPMASTR");
  }
  if (isLikelyApexDomain(domain) && !envFlag(source.ALLOW_APEX_DOMAIN_AUTOMATION)) {
    throw new HttpError(403, "APEX_DOMAIN_AUTOMATION_DISABLED");
  }
}

function prepareMutation(input: CloudflareAdminMutationInput) {
  const source = input.source || env;
  const domain = normalizeCloudflareAdminDomain(input.domain);
  const confirmDomain = input.confirmDomain ? normalizeCloudflareAdminDomain(input.confirmDomain) : "";
  const dryRun = input.dryRun !== false;

  assertMutationDomainAllowed(domain, source);
  if (!confirmDomain) throw new HttpError(400, "DOMAIN_CONFIRMATION_REQUIRED");
  if (confirmDomain !== domain) throw new HttpError(400, "DOMAIN_CONFIRMATION_MISMATCH");

  return {
    source,
    domain,
    dryRun,
    zoneId: dryRun ? null : zoneIdFromSource(source),
    mutationAllowed: envFlag(source.ALLOW_CLOUDFLARE_ADMIN_MUTATIONS)
  };
}

function getCloudflareReadiness(source: CloudflareAdminSource) {
  const zoneId = String(source.CLOUDFLARE_ZONE_ID || "").trim();
  if (!zoneId) {
    return {
      ready: false as const,
      reason: "CLOUDFLARE_ZONE_ID_MISSING",
      zoneId: null
    };
  }

  try {
    assertScopedCloudflareAuth(source);
  } catch (error) {
    return {
      ready: false as const,
      reason: error instanceof Error ? error.message : "CLOUDFLARE_AUTH_NOT_CONFIGURED",
      zoneId: null
    };
  }

  return {
    ready: true as const,
    reason: null,
    zoneId
  };
}

function cloudflareUrl(zoneId: string, path: string) {
  return `${CLOUDFLARE_API_BASE}/zones/${zoneId}${path}`;
}

function safeCloudflareError(payload: any, httpStatus: number) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  const code = first?.code ?? null;
  const message = String(first?.message || "Cloudflare request failed");
  return {
    httpStatus,
    code,
    safeMessage: /auth|token|key|secret/i.test(message)
      ? "Cloudflare authentication or permission check failed."
      : message.slice(0, 220)
  };
}

async function cloudflareRequest(input: {
  source: CloudflareAdminSource;
  fetchFn: CloudflareFetch;
  zoneId: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}) {
  const headers = assertScopedCloudflareAuth(input.source);
  const init: RequestInit = {
    method: input.method,
    headers
  };
  if (input.body !== undefined) init.body = JSON.stringify(input.body);

  const response = await input.fetchFn(cloudflareUrl(input.zoneId, input.path), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const providerHttpStatus = response.status || 0;
    const adminHttpStatus = providerHttpStatus === 401 ? 502 : providerHttpStatus || 502;
    throw new HttpError(adminHttpStatus, "CLOUDFLARE_REQUEST_FAILED", safeCloudflareError(payload, providerHttpStatus));
  }
  return payload?.result;
}

function summarizeCustomHostname(raw: any) {
  if (!raw) {
    return {
      found: false,
      hostname: null,
      customHostnameId: null,
      status: null,
      sslStatus: null,
      validationMethod: null,
      validationRecordPresence: false
    };
  }

  return {
    found: true,
    hostname: raw.hostname || null,
    customHostnameId: shortId(raw.id),
    status: raw.status || null,
    sslStatus: raw.ssl?.status || null,
    validationMethod: raw.ssl?.method || null,
    validationRecordPresence: Boolean(raw.ownership_verification || raw.ownership_verification_http || raw.verification_records)
  };
}

function summarizeValidationRecords(raw: any) {
  const records = [];
  if (raw?.ownership_verification) {
    records.push({
      kind: "ownership_txt",
      type: "TXT",
      name: raw.ownership_verification.name || null,
      value: raw.ownership_verification.value || null
    });
  }
  if (raw?.ownership_verification_http) {
    records.push({
      kind: "ownership_http",
      type: "HTTP",
      url: raw.ownership_verification_http.http_url || raw.ownership_verification_http.url || null,
      body: raw.ownership_verification_http.http_body || raw.ownership_verification_http.body || null
    });
  }
  if (Array.isArray(raw?.verification_records)) {
    for (const record of raw.verification_records) {
      records.push({
        kind: "verification_record",
        type: record?.type || null,
        name: record?.name || null,
        value: record?.value || record?.content || null
      });
    }
  }
  return records;
}

async function findCustomHostname(input: {
  domain: string;
  source: CloudflareAdminSource;
  fetchFn: CloudflareFetch;
  zoneId: string;
}) {
  const result = await cloudflareRequest({
    source: input.source,
    fetchFn: input.fetchFn,
    zoneId: input.zoneId,
    method: "GET",
    path: `/custom_hostnames?hostname=${encodeURIComponent(input.domain)}`
  });
  const matches = Array.isArray(result) ? result : [];
  return matches.find((entry) => entry?.hostname === input.domain) || null;
}

export async function runCloudflareCustomHostnameAdminAction(input: CloudflareAdminMutationInput) {
  const prepared = prepareMutation(input);
  const fetchFn = input.fetchFn || fetch;
  const requestBody = buildCloudflareCustomHostnameBody({
    domain: prepared.domain,
    merchantId: "admin-controlled",
    storefrontId: null,
    merchantDomainId: "admin-controlled"
  }, { customMetadataEnabled: false });

  if (prepared.dryRun) {
    return {
      action: "cloudflare_custom_hostname",
      domain: prepared.domain,
      dryRun: true,
      mutationAllowed: prepared.mutationAllowed,
      wouldMutate: false,
      method: "POST",
      endpoint: `/zones/{zone_id}/custom_hostnames`,
      body: requestBody,
      safety: {
        exactDomainConfirmed: true,
        customMetadataIncluded: false,
        dnsChanged: false,
        resellerClubCalled: false,
        apexBlockedByDefault: true
      },
      nextAction: prepared.mutationAllowed
        ? "Set dryRun=false with the same confirmDomain to create this one Custom Hostname."
        : "Set ALLOW_CLOUDFLARE_ADMIN_MUTATIONS=true before real provider mutation."
    };
  }

  if (!prepared.mutationAllowed) throw new HttpError(403, "CLOUDFLARE_ADMIN_MUTATIONS_DISABLED");

  const result = await cloudflareRequest({
    source: prepared.source,
    fetchFn,
    zoneId: prepared.zoneId!,
    method: "POST",
    path: "/custom_hostnames",
    body: requestBody
  });

  return {
    action: "cloudflare_custom_hostname",
    domain: prepared.domain,
    dryRun: false,
    mutationAllowed: true,
    created: Boolean(result?.id),
    customHostname: summarizeCustomHostname(result),
    validationRecords: summarizeValidationRecords(result),
    safety: {
      customMetadataIncluded: false,
      dnsChanged: false,
      resellerClubCalled: false
    }
  };
}

export async function fetchCloudflareValidationRecordsForAdmin(input: CloudflareValidationRecordsInput) {
  const source = input.source || env;
  const fetchFn = input.fetchFn || fetch;
  const domain = normalizeCloudflareAdminDomain(input.domain);
  assertMutationDomainAllowed(domain, source);
  const readiness = getCloudflareReadiness(source);
  if (!readiness.ready) {
    return {
      action: "cloudflare_validation_records",
      domain,
      checked: false,
      found: false,
      cloudflareStatus: "not_checked_config_missing",
      reason: readiness.reason,
      customHostname: summarizeCustomHostname(null),
      validationRecords: [],
      safety: {
        readOnly: true,
        dnsChanged: false,
        cloudflareMutation: false,
        resellerClubCalled: false
      }
    };
  }
  const zoneId = readiness.zoneId;
  const found = await findCustomHostname({ domain, source, fetchFn, zoneId });

  if (!found?.id) {
    return {
      action: "cloudflare_validation_records",
      domain,
      checked: true,
      found: false,
      customHostname: summarizeCustomHostname(null),
      validationRecords: [],
      safety: {
        readOnly: true,
        dnsChanged: false,
        cloudflareMutation: false,
        resellerClubCalled: false
      }
    };
  }

  const details = await cloudflareRequest({
    source,
    fetchFn,
    zoneId,
    method: "GET",
    path: `/custom_hostnames/${encodeURIComponent(found.id)}`
  });

  return {
    action: "cloudflare_validation_records",
    domain,
    checked: true,
    found: true,
    customHostname: summarizeCustomHostname(details),
    validationRecords: summarizeValidationRecords(details),
    safety: {
      readOnly: true,
      dnsChanged: false,
      cloudflareMutation: false,
      resellerClubCalled: false
    }
  };
}

export async function runCloudflareWorkerRouteAdminAction(input: CloudflareAdminMutationInput) {
  const prepared = prepareMutation(input);
  const fetchFn = input.fetchFn || fetch;
  const pattern = `${prepared.domain}/*`;
  const requestBody = {
    pattern,
    script: ORIGIN_SHIM_WORKER_SCRIPT
  };

  if (prepared.dryRun) {
    return {
      action: "cloudflare_worker_route",
      domain: prepared.domain,
      dryRun: true,
      mutationAllowed: prepared.mutationAllowed,
      wouldMutate: false,
      method: "POST",
      endpoint: `/zones/{zone_id}/workers/routes`,
      body: requestBody,
      safety: {
        exactDomainConfirmed: true,
        wildcardRoute: false,
        broadWildcardRoute: false,
        dnsChanged: false,
        resellerClubCalled: false,
        apexBlockedByDefault: true
      },
      nextAction: prepared.mutationAllowed
        ? "Set dryRun=false with the same confirmDomain to create this exact Worker route."
        : "Set ALLOW_CLOUDFLARE_ADMIN_MUTATIONS=true before real provider mutation."
    };
  }

  if (!prepared.mutationAllowed) throw new HttpError(403, "CLOUDFLARE_ADMIN_MUTATIONS_DISABLED");

  const existing = await cloudflareRequest({
    source: prepared.source,
    fetchFn,
    zoneId: prepared.zoneId!,
    method: "GET",
    path: "/workers/routes"
  });
  const routes = Array.isArray(existing) ? existing : [];
  const match = routes.find((route) => route?.pattern === pattern);
  if (match) {
    return {
      action: "cloudflare_worker_route",
      domain: prepared.domain,
      dryRun: false,
      mutationAllowed: true,
      created: false,
      alreadyExists: true,
      route: {
        id: shortId(match.id),
        pattern: match.pattern,
        script: match.script || null
      },
      safety: {
        dnsChanged: false,
        resellerClubCalled: false
      }
    };
  }

  const result = await cloudflareRequest({
    source: prepared.source,
    fetchFn,
    zoneId: prepared.zoneId!,
    method: "POST",
    path: "/workers/routes",
    body: requestBody
  });

  return {
    action: "cloudflare_worker_route",
    domain: prepared.domain,
    dryRun: false,
    mutationAllowed: true,
    created: Boolean(result?.id),
    alreadyExists: false,
    route: {
      id: shortId(result?.id),
      pattern: result?.pattern || pattern,
      script: result?.script || ORIGIN_SHIM_WORKER_SCRIPT
    },
    safety: {
      dnsChanged: false,
      resellerClubCalled: false
    }
  };
}
