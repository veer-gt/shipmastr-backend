import dotenv from "dotenv";

export const CLOUDFLARE_DOTENV_OPTIONS = { override: false, quiet: true };

dotenv.config(CLOUDFLARE_DOTENV_OPTIONS);

export const CLOUDFLARE_TEST_HOSTNAME = "cf-test.shipmastr.com";
export const CLOUDFLARE_APPROVED_REAL_HOSTNAME = "shipmastr.co.in";
export const CLOUDFLARE_APPROVED_REAL_HOSTNAMES = Object.freeze([
  "shipmastr.co.in",
  "www.shipmastr.co.in"
]);

const BLOCKED_HOSTNAMES = new Set([
  "shipmastr.com",
  "www.shipmastr.com",
  "api.shipmastr.com",
  "seller.shipmastr.com",
  "admin.shipmastr.com"
]);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function shortId(value) {
  const id = String(value || "");
  if (!id) return null;
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function resolveCloudflareAuthMode(source = process.env) {
  const authMode = String(source.CLOUDFLARE_AUTH_MODE || "api_token").trim().toLowerCase();
  if (!["api_token", "global_key"].includes(authMode)) {
    throw new Error("UNSUPPORTED_CLOUDFLARE_AUTH_MODE");
  }
  return authMode;
}

export function buildCloudflareHeaders(source = process.env) {
  const authMode = resolveCloudflareAuthMode(source);

  if (authMode === "global_key") {
    const authEmail = String(source.CLOUDFLARE_AUTH_EMAIL || "").trim();
    const globalApiKey = String(source.CLOUDFLARE_GLOBAL_API_KEY || "").trim();
    if (!authEmail || !globalApiKey) {
      throw new Error("CLOUDFLARE_GLOBAL_KEY_AUTH_NOT_CONFIGURED");
    }
    return {
      "X-Auth-Email": authEmail,
      "X-Auth-Key": globalApiKey,
      "Content-Type": "application/json"
    };
  }

  const apiToken = String(source.CLOUDFLARE_API_TOKEN || "").trim().replace(/^bearer\s+/i, "");
  if (!apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN_AUTH_NOT_CONFIGURED");
  }
  return {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json"
  };
}

export function buildCloudflareAuthDebugSummary(source = process.env) {
  const authMode = resolveCloudflareAuthMode(source);
  let headers = {};
  try {
    headers = buildCloudflareHeaders(source);
  } catch {
    headers = {};
  }

  return {
    authMode,
    hasAuthorizationHeader: Object.prototype.hasOwnProperty.call(headers, "Authorization"),
    hasXAuthEmail: Object.prototype.hasOwnProperty.call(headers, "X-Auth-Email"),
    hasXAuthKey: Object.prototype.hasOwnProperty.call(headers, "X-Auth-Key"),
    hasContentType: Object.prototype.hasOwnProperty.call(headers, "Content-Type"),
    hasZoneId: Boolean(String(source.CLOUDFLARE_ZONE_ID || "").trim()),
    allowTestHostname: source.ALLOW_CLOUDFLARE_TEST_HOSTNAME === "true",
    allowRealHostname: source.ALLOW_CLOUDFLARE_REAL_HOSTNAME === "true",
    customMetadataEnabled: source.CLOUDFLARE_CUSTOM_METADATA_ENABLED === "true"
  };
}

export function normalizeCloudflareTestHostname(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname) || hostname.includes("..")) {
    throw new Error("INVALID_TEST_HOSTNAME");
  }
  return hostname;
}

export function assertCloudflareTestHostnameAllowed(input) {
  const source = input.source || process.env;
  const hostname = normalizeCloudflareTestHostname(input.hostname);

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("REFUSING_PLATFORM_HOSTNAME");
  }

  if (hostname !== CLOUDFLARE_TEST_HOSTNAME) {
    throw new Error("ONLY_CF_TEST_SHIPMASTR_COM_ALLOWED");
  }

  if (source.ALLOW_CLOUDFLARE_TEST_HOSTNAME !== "true") {
    throw new Error("ALLOW_CLOUDFLARE_TEST_HOSTNAME_REQUIRED");
  }

  if (source.ALLOW_LIVE_DOMAIN_REGISTRATION === "true") {
    throw new Error("REFUSING_WHILE_LIVE_REGISTRATION_UNBLOCKED");
  }

  if (!String(source.CLOUDFLARE_ZONE_ID || "").trim()) {
    throw new Error("CLOUDFLARE_PROVIDER_NOT_CONFIGURED");
  }

  try {
    buildCloudflareHeaders(source);
  } catch {
    throw new Error("CLOUDFLARE_PROVIDER_NOT_CONFIGURED");
  }

  return hostname;
}

export function assertCloudflareRealHostnameAllowed(input) {
  const source = input.source || process.env;
  const hostname = normalizeCloudflareTestHostname(input.hostname);
  const approvedRealDomain = normalizeCloudflareTestHostname(input.approvedRealDomain);

  if (!CLOUDFLARE_APPROVED_REAL_HOSTNAMES.includes(hostname)) {
    throw new Error("ONLY_APPROVED_REAL_HOSTNAME_ALLOWED");
  }

  if (approvedRealDomain !== hostname) {
    throw new Error("APPROVED_REAL_DOMAIN_REQUIRED");
  }

  if (input.cleanup) {
    throw new Error("REAL_HOSTNAME_CLEANUP_BLOCKED_WITHOUT_CONFIRM_DELETE");
  }

  if (source.ALLOW_CLOUDFLARE_REAL_HOSTNAME !== "true") {
    throw new Error("ALLOW_CLOUDFLARE_REAL_HOSTNAME_REQUIRED");
  }

  if (source.ALLOW_LIVE_DOMAIN_REGISTRATION !== "false") {
    throw new Error("ALLOW_LIVE_DOMAIN_REGISTRATION_MUST_BE_FALSE");
  }

  if (source.CLOUDFLARE_CUSTOM_METADATA_ENABLED !== "false") {
    throw new Error("CLOUDFLARE_CUSTOM_METADATA_MUST_BE_FALSE");
  }

  if (!String(source.CLOUDFLARE_ZONE_ID || "").trim()) {
    throw new Error("CLOUDFLARE_PROVIDER_NOT_CONFIGURED");
  }

  try {
    buildCloudflareHeaders(source);
  } catch {
    throw new Error("CLOUDFLARE_PROVIDER_NOT_CONFIGURED");
  }

  return hostname;
}

export function buildCloudflareCustomHostnameBody(hostname, source = process.env) {
  const body = {
    hostname,
    ssl: {
      method: "http",
      type: "dv",
      settings: {
        min_tls_version: "1.2"
      }
    }
  };

  if (source.CLOUDFLARE_CUSTOM_METADATA_ENABLED === "true") {
    body.custom_metadata = {
      source: "shipmastr-domains",
      purpose: "cloudflare-test-hostname",
      test_hostname: "true"
    };
  }

  return body;
}

function validationRecordPresence(result) {
  const sslRecords = result?.ssl?.validation_records;
  const rootRecords = result?.validation_records;
  const ownership = result?.ownership_verification;
  return Boolean(
    (Array.isArray(sslRecords) && sslRecords.length > 0) ||
    (Array.isArray(rootRecords) && rootRecords.length > 0) ||
    ownership
  );
}

function safeValidationRecordsSummary(result) {
  const records = [];

  if (result?.ownership_verification) {
    records.push({
      scope: "ownership",
      type: result.ownership_verification.type || null,
      namePresent: Boolean(result.ownership_verification.name),
      valuePresent: Boolean(result.ownership_verification.value)
    });
  }

  if (result?.ownership_verification_http) {
    records.push({
      scope: "ownership_http",
      type: "http",
      urlPresent: Boolean(result.ownership_verification_http.http_url),
      bodyPresent: Boolean(result.ownership_verification_http.http_body)
    });
  }

  for (const record of result?.ssl?.validation_records || []) {
    records.push({
      scope: "ssl",
      type: record.txt_name ? "txt" : record.http_url ? "http" : record.cname ? "cname" : "unknown",
      txtNamePresent: Boolean(record.txt_name),
      txtValuePresent: Boolean(record.txt_value),
      httpUrlPresent: Boolean(record.http_url),
      httpBodyPresent: Boolean(record.http_body),
      cnamePresent: Boolean(record.cname),
      cnameTargetPresent: Boolean(record.cname_target),
      status: record.status || null
    });
  }

  for (const record of result?.validation_records || []) {
    records.push({
      scope: "validation",
      type: record.txt_name ? "txt" : record.http_url ? "http" : record.cname ? "cname" : "unknown",
      txtNamePresent: Boolean(record.txt_name),
      txtValuePresent: Boolean(record.txt_value),
      httpUrlPresent: Boolean(record.http_url),
      httpBodyPresent: Boolean(record.http_body),
      cnamePresent: Boolean(record.cname),
      cnameTargetPresent: Boolean(record.cname_target),
      status: record.status || null
    });
  }

  return records;
}

function publicValidationRecords(result) {
  const txt = [];
  const http = [];

  if (result?.ownership_verification?.type === "txt") {
    txt.push({
      scope: "ownership",
      name: result.ownership_verification.name || null,
      value: result.ownership_verification.value || null
    });
  }

  if (result?.ownership_verification_http) {
    http.push({
      scope: "ownership_http",
      url: result.ownership_verification_http.http_url || null,
      body: result.ownership_verification_http.http_body || null
    });
  }

  for (const record of result?.ssl?.validation_records || []) {
    if (record.txt_name || record.txt_value) {
      txt.push({
        scope: "ssl",
        name: record.txt_name || null,
        value: record.txt_value || null,
        status: record.status || null
      });
    }

    if (record.http_url || record.http_body) {
      http.push({
        scope: "ssl",
        url: record.http_url || null,
        body: record.http_body || null,
        status: record.status || null
      });
    }
  }

  for (const record of result?.validation_records || []) {
    if (record.txt_name || record.txt_value) {
      txt.push({
        scope: "validation",
        name: record.txt_name || null,
        value: record.txt_value || null,
        status: record.status || null
      });
    }

    if (record.http_url || record.http_body) {
      http.push({
        scope: "validation",
        url: record.http_url || null,
        body: record.http_body || null,
        status: record.status || null
      });
    }
  }

  return { txt, http };
}

function requiredNextDnsAction(result) {
  if (result?.status === "active" && result?.ssl?.status === "active") {
    return "No DNS validation action required; hostname and SSL are active.";
  }

  const recordSummary = safeValidationRecordsSummary(result);
  if (recordSummary.some((record) => record.type === "txt")) {
    return "Add the returned TXT validation record(s) at the authoritative DNS provider; values are intentionally not printed in normal safe output.";
  }

  if (recordSummary.some((record) => record.type === "cname")) {
    return "Add the returned CNAME validation record(s) at the authoritative DNS provider; values are intentionally not printed in normal safe output.";
  }

  if (recordSummary.some((record) => record.type === "http")) {
    return "HTTP validation is pending; do not change DNS until the validation target and cutover plan are reviewed.";
  }

  return "Validation requirement not returned yet; fetch Custom Hostname details again before changing DNS or nameservers.";
}

function requiredPublicValidationAction(result) {
  const records = publicValidationRecords(result);
  const hostname = result?.hostname || "the approved real hostname";

  if (records.txt.length > 0) {
    return `Add the TXT validation record(s) at the current authoritative DNS provider for ${hostname}. Nameserver change is not required yet.`;
  }

  if (records.http.length > 0) {
    return "HTTP ownership validation details are present. Review the URL/body before changing DNS or nameservers.";
  }

  return requiredNextDnsAction(result);
}

export function safeCloudflareCustomHostnameSummary(result) {
  return {
    hostname: result?.hostname || null,
    customHostnameId: shortId(result?.id),
    status: result?.status || null,
    sslStatus: result?.ssl?.status || null,
    validationMethod: result?.ssl?.method || null,
    validationRecordPresence: validationRecordPresence(result),
    validationRecordsSafeSummary: safeValidationRecordsSummary(result),
    requiredNextDnsAction: requiredNextDnsAction(result)
  };
}

export function publicCloudflareValidationRecordSummary(result) {
  const hostname = result?.hostname || "the approved real hostname";
  return {
    hostname: result?.hostname || null,
    customHostnameId: shortId(result?.id),
    status: result?.status || null,
    sslStatus: result?.ssl?.status || null,
    validationMethod: result?.ssl?.method || null,
    validationRecordPresence: validationRecordPresence(result),
    validationRecords: publicValidationRecords(result),
    whereToAddTxt: `Current authoritative DNS provider for ${hostname}: OrderBox/WebPro DNS.`,
    nameserverChangeRequired: false,
    requiredNextDnsAction: requiredPublicValidationAction(result)
  };
}

async function cloudflareApi({ source, fetchFn, method, path, body }) {
  const zoneId = String(source.CLOUDFLARE_ZONE_ID || "").trim();
  const url = `https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`;
  const response = await fetchFn(url, {
    method,
    headers: buildCloudflareHeaders(source),
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { success: false, errors: [{ message: "Cloudflare returned a non-JSON response" }] };
  }
  return { response, payload };
}

function safeCloudflareErrors(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  return errors.map((error) => ({
    code: error?.code || undefined,
    internalStatus: Number(error?.code) === 1413 ? "CUSTOM_METADATA_NOT_ENABLED" : "CLOUDFLARE_CUSTOM_HOSTNAME_ERROR",
    message: error?.message || "Cloudflare request failed"
  }));
}

export async function runCloudflareTestHostnameSmoke(input) {
  const source = input.source || process.env;
  const fetchFn = input.fetchFn || fetch;
  const hostname = assertCloudflareTestHostnameAllowed({ hostname: input.hostname, source });
  const cleanup = Boolean(input.cleanup);
  let createdId = "";
  let cleanupStatus = cleanup ? "not_started" : "not_requested";

  const zoneCheck = await cloudflareApi({
    source,
    fetchFn,
    method: "GET",
    path: ""
  });
  if (!zoneCheck.response.ok || zoneCheck.payload?.success === false) {
    throw new Error(`CLOUDFLARE_ZONE_ACCESS_FAILED:${JSON.stringify(safeCloudflareErrors(zoneCheck.payload))}`);
  }

  try {
    const create = await cloudflareApi({
      source,
      fetchFn,
      method: "POST",
      path: "/custom_hostnames",
      body: buildCloudflareCustomHostnameBody(hostname, source)
    });

    if (!create.response.ok || create.payload?.success === false || !create.payload?.result?.id) {
      return {
        created: false,
        hostname,
        zoneAccess: true,
        cloudflareErrors: safeCloudflareErrors(create.payload),
        httpStatus: create.response.status,
        cleanupStatus
      };
    }

    createdId = String(create.payload.result.id);
    const details = await cloudflareApi({
      source,
      fetchFn,
      method: "GET",
      path: `/custom_hostnames/${encodeURIComponent(createdId)}`
    });
    const detailResult = details.payload?.result || create.payload.result;

    return {
      created: true,
      hostname,
      zoneAccess: true,
      create: safeCloudflareCustomHostnameSummary(create.payload.result),
      details: safeCloudflareCustomHostnameSummary(detailResult),
      cleanupStatus
    };
  } finally {
    if (cleanup && createdId) {
      const deleted = await cloudflareApi({
        source,
        fetchFn,
        method: "DELETE",
        path: `/custom_hostnames/${encodeURIComponent(createdId)}`
      });
      cleanupStatus = deleted.response.ok && deleted.payload?.success !== false ? "deleted" : "delete_failed";
      input.onCleanup?.(cleanupStatus);
    }
  }
}

export async function runCloudflareRealHostnameCreation(input) {
  const source = input.source || process.env;
  const fetchFn = input.fetchFn || fetch;
  const hostname = assertCloudflareRealHostnameAllowed({
    hostname: input.hostname,
    approvedRealDomain: input.approvedRealDomain,
    cleanup: input.cleanup,
    source
  });

  const zoneCheck = await cloudflareApi({
    source,
    fetchFn,
    method: "GET",
    path: ""
  });
  if (!zoneCheck.response.ok || zoneCheck.payload?.success === false) {
    throw new Error(`CLOUDFLARE_ZONE_ACCESS_FAILED:${JSON.stringify(safeCloudflareErrors(zoneCheck.payload))}`);
  }

  const existing = await cloudflareApi({
    source,
    fetchFn,
    method: "GET",
    path: `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`
  });
  if (!existing.response.ok || existing.payload?.success === false) {
    throw new Error(`CLOUDFLARE_CUSTOM_HOSTNAME_LOOKUP_FAILED:${JSON.stringify(safeCloudflareErrors(existing.payload))}`);
  }

  let created = false;
  let result = Array.isArray(existing.payload?.result)
    ? existing.payload.result.find((entry) => entry?.hostname === hostname)
    : null;
  let createHttpStatus = null;

  if (!result) {
    const create = await cloudflareApi({
      source,
      fetchFn,
      method: "POST",
      path: "/custom_hostnames",
      body: buildCloudflareCustomHostnameBody(hostname, source)
    });
    createHttpStatus = create.response.status;

    if (!create.response.ok || create.payload?.success === false || !create.payload?.result?.id) {
      return {
        created: false,
        hostname,
        zoneAccess: true,
        cloudflareErrors: safeCloudflareErrors(create.payload),
        httpStatus: create.response.status,
        customMetadataIncluded: false,
        cleanupStatus: "not_requested"
      };
    }

    created = true;
    result = create.payload.result;
  }

  const details = await cloudflareApi({
    source,
    fetchFn,
    method: "GET",
    path: `/custom_hostnames/${encodeURIComponent(result.id)}`
  });
  const detailResult = details.payload?.result || result;

  return {
    created,
    hostname,
    zoneAccess: true,
    createHttpStatus,
    detailsHttpStatus: details.response.status,
    details: safeCloudflareCustomHostnameSummary(detailResult),
    customMetadataIncluded: false,
    cleanupStatus: "not_requested"
  };
}

export async function runCloudflareRealHostnameValidationRecordLookup(input) {
  const source = input.source || process.env;
  const fetchFn = input.fetchFn || fetch;
  const hostname = assertCloudflareRealHostnameAllowed({
    hostname: input.hostname,
    approvedRealDomain: input.approvedRealDomain,
    cleanup: input.cleanup,
    source
  });

  const zoneCheck = await cloudflareApi({
    source,
    fetchFn,
    method: "GET",
    path: ""
  });
  if (!zoneCheck.response.ok || zoneCheck.payload?.success === false) {
    throw new Error(`CLOUDFLARE_ZONE_ACCESS_FAILED:${JSON.stringify(safeCloudflareErrors(zoneCheck.payload))}`);
  }

  const existing = await cloudflareApi({
    source,
    fetchFn,
    method: "GET",
    path: `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`
  });
  if (!existing.response.ok || existing.payload?.success === false) {
    throw new Error(`CLOUDFLARE_CUSTOM_HOSTNAME_LOOKUP_FAILED:${JSON.stringify(safeCloudflareErrors(existing.payload))}`);
  }

  const result = Array.isArray(existing.payload?.result)
    ? existing.payload.result.find((entry) => entry?.hostname === hostname)
    : null;

  if (!result?.id) {
    throw new Error("CLOUDFLARE_REAL_HOSTNAME_NOT_FOUND");
  }

  const details = await cloudflareApi({
    source,
    fetchFn,
    method: "GET",
    path: `/custom_hostnames/${encodeURIComponent(result.id)}`
  });
  if (!details.response.ok || details.payload?.success === false) {
    throw new Error(`CLOUDFLARE_CUSTOM_HOSTNAME_DETAILS_FAILED:${JSON.stringify(safeCloudflareErrors(details.payload))}`);
  }

  return {
    hostname,
    zoneAccess: true,
    detailsHttpStatus: details.response.status,
    details: publicCloudflareValidationRecordSummary(details.payload?.result || result),
    dnsChange: "not_attempted",
    nameserverChange: "not_attempted",
    customMetadataIncluded: false,
    cleanupStatus: "not_requested"
  };
}

async function main() {
  if (hasArg("--debug-auth-headers")) {
    console.log(JSON.stringify(buildCloudflareAuthDebugSummary(), null, 2));
    return;
  }

  const hostname = argValue("--hostname");
  if (!hostname) {
    throw new Error(`Usage: npm run domains:cloudflare-test-hostname-smoke -- --hostname ${CLOUDFLARE_TEST_HOSTNAME} --cleanup`);
  }

  const approvedRealDomain = argValue("--approved-real-domain");
  if (approvedRealDomain) {
    const result = hasArg("--print-validation-records")
      ? await runCloudflareRealHostnameValidationRecordLookup({
        hostname,
        approvedRealDomain,
        cleanup: hasArg("--cleanup")
      })
      : await runCloudflareRealHostnameCreation({
        hostname,
        approvedRealDomain,
        cleanup: hasArg("--cleanup")
      });

    console.log(JSON.stringify({
      ...result,
      safety: {
        resellerClubRegistration: "not_called",
        dnsChange: "not_attempted",
        nameserverChange: "not_attempted",
        cleanup: "not_attempted",
        customMetadata: "not_included",
        productionTrafficChange: "not_attempted",
        secretsPrinted: false
      }
    }, null, 2));
    return;
  }

  let finalCleanupStatus = hasArg("--cleanup") ? "not_started" : "not_requested";
  const result = await runCloudflareTestHostnameSmoke({
    hostname,
    cleanup: hasArg("--cleanup"),
    onCleanup: (status) => {
      finalCleanupStatus = status;
    }
  });

  console.log(JSON.stringify({
    ...result,
    cleanupStatus: finalCleanupStatus,
    safety: {
      resellerClubRegistration: "not_called",
      dnsChange: "not_attempted",
      productionTrafficChange: "not_attempted",
      secretsPrinted: false
    }
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({
      error: "CLOUDFLARE_TEST_HOSTNAME_SMOKE_BLOCKED",
      message: error instanceof Error ? error.message : String(error),
      safety: {
        resellerClubRegistration: "not_called",
        dnsChange: "not_attempted",
        productionTrafficChange: "not_attempted",
        secretsPrinted: false
      }
    }, null, 2));
    process.exitCode = 1;
  });
}
