import dotenv from "dotenv";
import {
  CLOUDFLARE_DOTENV_OPTIONS,
  CLOUDFLARE_TEST_HOSTNAME,
  buildCloudflareHeaders,
  runCloudflareTestHostnameSmoke
} from "./domains-cloudflare-test-hostname-smoke.mjs";

dotenv.config(CLOUDFLARE_DOTENV_OPTIONS);

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const ORIGIN_HOSTNAME = "storefront-origin.shipmastr.com";
const ORIGIN_RECORD_NAME = "storefront-origin.shipmastr.com";
const ORIGIN_TARGET = "shipmastr-storefront-renderer-jscfc5kumq-el.a.run.app";
const PLATFORM_RECORDS_TO_CHECK = ["shipmastr.com", "www.shipmastr.com"];

function hasArg(name) {
  return process.argv.includes(name);
}

function shortId(value) {
  const id = String(value || "");
  if (!id) return null;
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function safeErrors(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  return errors.map((error) => ({
    code: error?.code || undefined,
    message: error?.message || "Cloudflare request failed"
  }));
}

function assertBaseConfig(source = process.env) {
  if (source.ALLOW_LIVE_DOMAIN_REGISTRATION === "true") {
    throw new Error("REFUSING_WHILE_LIVE_REGISTRATION_UNBLOCKED");
  }
  if (!String(source.CLOUDFLARE_ZONE_ID || "").trim()) {
    throw new Error("CLOUDFLARE_ZONE_ID_REQUIRED");
  }
  buildCloudflareHeaders(source);
}

function assertFallbackMutationAllowed(source = process.env) {
  assertBaseConfig(source);
  if (source.ALLOW_CLOUDFLARE_FALLBACK_ORIGIN !== "true") {
    throw new Error("ALLOW_CLOUDFLARE_FALLBACK_ORIGIN_REQUIRED");
  }
}

async function cloudflareApi({ source = process.env, fetchFn = fetch, method, path, body }) {
  const zoneId = String(source.CLOUDFLARE_ZONE_ID || "").trim();
  const response = await fetchFn(`${CLOUDFLARE_API_BASE}/zones/${zoneId}${path}`, {
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

function summarizeDnsRecord(record) {
  if (!record) return null;
  return {
    id: shortId(record.id),
    name: record.name || null,
    type: record.type || null,
    proxied: Boolean(record.proxied),
    targetMatchesRenderer: record.type === "CNAME" && record.content === ORIGIN_TARGET,
    createdOn: record.created_on || null,
    modifiedOn: record.modified_on || null
  };
}

async function listDnsRecordsByName(name) {
  const query = new URLSearchParams({ name, per_page: "20" });
  const result = await cloudflareApi({
    method: "GET",
    path: `/dns_records?${query.toString()}`
  });

  if (!result.response.ok || result.payload?.success === false) {
    throw new Error(`CLOUDFLARE_DNS_LIST_FAILED:${JSON.stringify(safeErrors(result.payload))}`);
  }

  return Array.isArray(result.payload?.result) ? result.payload.result : [];
}

async function getFallbackOrigin() {
  const result = await cloudflareApi({
    method: "GET",
    path: "/custom_hostnames/fallback_origin"
  });

  if (result.response.status === 404) {
    return { configured: false, status: null, origin: null, errors: [] };
  }

  if (!result.response.ok || result.payload?.success === false) {
    return {
      configured: false,
      status: null,
      origin: null,
      errors: safeErrors(result.payload),
      httpStatus: result.response.status
    };
  }

  return {
    configured: Boolean(result.payload?.result?.origin),
    origin: result.payload?.result?.origin || null,
    status: result.payload?.result?.status || null,
    errors: Array.isArray(result.payload?.result?.errors) ? result.payload.result.errors : []
  };
}

async function createOriginDnsRecord() {
  const existing = await listDnsRecordsByName(ORIGIN_RECORD_NAME);

  if (existing.length > 1) {
    throw new Error("MULTIPLE_STOREFRONT_ORIGIN_RECORDS_FOUND");
  }

  if (existing.length === 1) {
    const record = existing[0];
    if (record.type !== "CNAME" || record.content !== ORIGIN_TARGET || record.proxied !== true) {
      throw new Error("STOREFRONT_ORIGIN_RECORD_CONFLICT");
    }
    return { created: false, record: summarizeDnsRecord(record), reason: "already_exists" };
  }

  const created = await cloudflareApi({
    method: "POST",
    path: "/dns_records",
    body: {
      type: "CNAME",
      name: ORIGIN_RECORD_NAME,
      content: ORIGIN_TARGET,
      proxied: true,
      ttl: 1,
      comment: "Shipmastr storefront renderer fallback origin - controlled test"
    }
  });

  if (!created.response.ok || created.payload?.success === false) {
    throw new Error(`CLOUDFLARE_ORIGIN_DNS_CREATE_FAILED:${JSON.stringify(safeErrors(created.payload))}`);
  }

  return { created: true, record: summarizeDnsRecord(created.payload.result) };
}

async function configureFallbackOrigin() {
  const result = await cloudflareApi({
    method: "PUT",
    path: "/custom_hostnames/fallback_origin",
    body: { origin: ORIGIN_HOSTNAME }
  });

  if (!result.response.ok || result.payload?.success === false) {
    throw new Error(`CLOUDFLARE_FALLBACK_ORIGIN_UPDATE_FAILED:${JSON.stringify(safeErrors(result.payload))}`);
  }

  return {
    origin: result.payload?.result?.origin || null,
    status: result.payload?.result?.status || null,
    errors: Array.isArray(result.payload?.result?.errors) ? result.payload.result.errors : []
  };
}

async function probeOrigin() {
  try {
    const response = await fetch(`https://${ORIGIN_HOSTNAME}/`, {
      method: "GET",
      redirect: "manual"
    });
    const text = await response.text();
    return {
      reachable: true,
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      rendererLikelyReached: /Shipmastr|Storefront|Powered by Shipmastr/i.test(text),
      cloudflareRayPresent: Boolean(response.headers.get("cf-ray"))
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runDryRun() {
  assertBaseConfig();

  const originRecords = await listDnsRecordsByName(ORIGIN_RECORD_NAME);
  const platformRecords = {};
  for (const name of PLATFORM_RECORDS_TO_CHECK) {
    const records = await listDnsRecordsByName(name);
    platformRecords[name] = records.map((record) => ({
      id: shortId(record.id),
      name: record.name || null,
      type: record.type || null,
      proxied: Boolean(record.proxied)
    }));
  }

  return {
    originRecordName: ORIGIN_RECORD_NAME,
    originTarget: ORIGIN_TARGET,
    originRecordCount: originRecords.length,
    originRecords: originRecords.map(summarizeDnsRecord),
    platformRecords,
    fallbackOrigin: await getFallbackOrigin()
  };
}

async function main() {
  const actions = {
    dryRun: await runDryRun()
  };

  if (hasArg("--create-origin-dns")) {
    assertFallbackMutationAllowed();
    actions.originDns = await createOriginDnsRecord();
  }

  if (hasArg("--probe-origin")) {
    actions.originProbe = await probeOrigin();
  }

  if (hasArg("--configure-fallback-origin")) {
    assertFallbackMutationAllowed();
    actions.fallbackOriginUpdate = await configureFallbackOrigin();
    actions.fallbackOriginAfterUpdate = await getFallbackOrigin();
  }

  if (hasArg("--create-test-hostname")) {
    assertFallbackMutationAllowed();
    let finalCleanupStatus = hasArg("--cleanup") ? "not_started" : "not_requested";
    const testHostname = await runCloudflareTestHostnameSmoke({
      hostname: CLOUDFLARE_TEST_HOSTNAME,
      cleanup: hasArg("--cleanup"),
      onCleanup: (status) => {
        finalCleanupStatus = status;
      }
    });
    actions.testCustomHostname = {
      ...testHostname,
      cleanupStatus: finalCleanupStatus
    };
  }

  console.log(JSON.stringify({
    actions,
    safety: {
      resellerClubRegistration: "not_called",
      dnsChangesLimitedTo: hasArg("--create-origin-dns") ? ORIGIN_RECORD_NAME : "none",
      hostingerChange: "not_attempted",
      shipmastrMarketingChange: "not_attempted",
      productionTrafficChange: "not_attempted",
      googleLoadBalancer: "not_created",
      secretsPrinted: false
    }
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({
      error: "CLOUDFLARE_FALLBACK_ORIGIN_SMOKE_BLOCKED",
      message: error instanceof Error ? error.message : String(error),
      safety: {
        resellerClubRegistration: "not_called",
        dnsChange: "not_attempted_or_limited_to_storefront_origin",
        hostingerChange: "not_attempted",
        productionTrafficChange: "not_attempted",
        googleLoadBalancer: "not_created",
        secretsPrinted: false
      }
    }, null, 2));
    process.exitCode = 1;
  });
}
