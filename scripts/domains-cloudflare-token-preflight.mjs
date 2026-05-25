import dotenv from "dotenv";
import {
  buildCloudflareAuthDebugSummary,
  buildCloudflareHeaders,
  CLOUDFLARE_DOTENV_OPTIONS
} from "./domains-cloudflare-test-hostname-smoke.mjs";

dotenv.config(CLOUDFLARE_DOTENV_OPTIONS);

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_CUSTOM_HOSTNAME = "www.shipmastr.co.in";
const DEFAULT_ORIGIN_HOSTNAME = "storefront-origin.shipmastr.com";
const EXPECTED_WORKER_ROUTES = Object.freeze([
  "www.shipmastr.co.in/*",
  "storefront-origin.shipmastr.com/*"
]);
const READ_ONLY_METHODS = new Set(["GET"]);
const SECRET_KEY_PATTERN = /(token|key|secret|authorization|x-auth-key|x-auth-email|bearer)/i;

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

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) && typeof nested === "string" ? "[redacted]" : redactSecrets(nested);
    }
    return output;
  }
  if (typeof value === "string" && /^bearer\s+/i.test(value)) return "[redacted]";
  return value;
}

function permissionHintForCheck(checkName) {
  if (checkName === "zone_read") return "Zone Read";
  if (checkName.startsWith("custom_hostnames") || checkName === "fallback_origin_read") return "SSL and Certificates Read";
  if (checkName === "workers_routes_read") return "Workers Routes Read";
  if (checkName.startsWith("dns_records")) return "DNS Read";
  if (checkName === "workers_script_read") return "Workers Scripts Read";
  return "Review Cloudflare API token permissions for this endpoint";
}

function safeCloudflareErrors(payload, checkName) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  if (!errors.length) return [];
  return errors.map((error) => {
    const code = Number(error?.code || 0) || error?.code || null;
    const message = String(error?.message || "Cloudflare request failed");
    let safeMessage = message;
    let likelyMissingPermission = permissionHintForCheck(checkName);

    if (Number(code) === 9109 || /invalid access token/i.test(message)) {
      safeMessage = "Invalid Cloudflare API token.";
      likelyMissingPermission = "Token value is invalid, expired, revoked, or not a raw API token";
    } else if (Number(code) === 10000 || /authentication error/i.test(message)) {
      safeMessage = "Cloudflare authentication failed.";
      likelyMissingPermission = "Authentication header/token is invalid or missing";
    } else if (/permission|not authorized|forbidden/i.test(message)) {
      safeMessage = "Cloudflare token lacks permission for this read.";
    }

    return {
      code,
      safeMessage,
      likelyMissingPermission
    };
  });
}

function summarizeCheckResult(checkName, payload) {
  const result = payload?.result;

  if (checkName === "zone_read") {
    return {
      zoneReadable: Boolean(result?.id),
      zoneName: result?.name || null
    };
  }

  if (checkName === "custom_hostnames_list") {
    return {
      count: Array.isArray(result) ? result.length : 0,
      hostnames: Array.isArray(result) ? result.map((entry) => entry?.hostname).filter(Boolean).slice(0, 10) : []
    };
  }

  if (checkName === "custom_hostnames_lookup_www") {
    const entries = Array.isArray(result) ? result : [];
    const hostname = entries[0] || null;
    return {
      found: Boolean(hostname?.id),
      hostname: hostname?.hostname || null,
      customHostnameId: shortId(hostname?.id),
      status: hostname?.status || null,
      sslStatus: hostname?.ssl?.status || null,
      validationMethod: hostname?.ssl?.method || null
    };
  }

  if (checkName === "custom_hostname_details_www") {
    return {
      found: Boolean(result?.id),
      hostname: result?.hostname || null,
      customHostnameId: shortId(result?.id),
      status: result?.status || null,
      sslStatus: result?.ssl?.status || null,
      validationMethod: result?.ssl?.method || null
    };
  }

  if (checkName === "fallback_origin_read") {
    return {
      available: Boolean(result),
      origin: result?.origin || result?.hostname || result?.fallback_origin || null,
      status: result?.status || null
    };
  }

  if (checkName === "workers_routes_read") {
    const routes = Array.isArray(result) ? result : [];
    return {
      count: routes.length,
      expectedRoutes: EXPECTED_WORKER_ROUTES.map((pattern) => ({
        pattern,
        present: routes.some((route) => route?.pattern === pattern),
        script: routes.find((route) => route?.pattern === pattern)?.script || null
      }))
    };
  }

  if (checkName.startsWith("dns_records")) {
    const records = Array.isArray(result) ? result : [];
    return {
      count: records.length,
      records: records.slice(0, 10).map((record) => ({
        type: record?.type || null,
        name: record?.name || null,
        proxied: Boolean(record?.proxied),
        contentPresent: Boolean(record?.content)
      }))
    };
  }

  return { present: Boolean(result) };
}

function checkOk(check) {
  return check.ok === true || check.required === false;
}

function hasBlockingAuthFailure(check) {
  return (check.errors || []).some((error) => {
    const code = Number(error?.code || 0);
    return code === 9109 || code === 10000 || /invalid|authentication/i.test(String(error?.safeMessage || ""));
  });
}

async function cloudflareGet({ source, fetchFn, zoneId, checkName, path, required = true }) {
  const method = "GET";
  if (!READ_ONLY_METHODS.has(method)) throw new Error("CLOUDFLARE_PREFLIGHT_MUTATION_BLOCKED");

  const url = `${CLOUDFLARE_API_BASE}/zones/${zoneId}${path}`;
  const startedAt = Date.now();

  try {
    const response = await fetchFn(url, {
      method,
      headers: buildCloudflareHeaders(source)
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { success: false, errors: [{ message: "Cloudflare returned a non-JSON response" }] };
    }

    const ok = response.ok && payload?.success !== false;
    return {
      name: checkName,
      required,
      method,
      path,
      ok,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      result: ok ? summarizeCheckResult(checkName, payload) : null,
      errors: ok ? [] : safeCloudflareErrors(payload, checkName)
    };
  } catch (error) {
    return {
      name: checkName,
      required,
      method,
      path,
      ok: false,
      httpStatus: 0,
      durationMs: Date.now() - startedAt,
      result: null,
      errors: [{
        code: "NETWORK_OR_RUNTIME_ERROR",
        safeMessage: String(error?.message || error || "Cloudflare request failed"),
        likelyMissingPermission: permissionHintForCheck(checkName)
      }]
    };
  }
}

export async function runCloudflareTokenPreflight(input = {}) {
  const source = input.source || process.env;
  const fetchFn = input.fetchFn || fetch;
  const customHostname = String(input.customHostname || DEFAULT_CUSTOM_HOSTNAME).trim().toLowerCase();
  const originHostname = String(input.originHostname || DEFAULT_ORIGIN_HOSTNAME).trim().toLowerCase();
  const zoneId = String(source.CLOUDFLARE_ZONE_ID || "").trim();
  const authSummary = buildCloudflareAuthDebugSummary(source);
  const startedAt = new Date().toISOString();

  const result = {
    ok: false,
    checkedAt: startedAt,
    auth: authSummary,
    target: {
      customHostname,
      originHostname,
      expectedWorkerRoutes: [...EXPECTED_WORKER_ROUTES]
    },
    checks: [],
    missingPermissionHints: [],
    safety: {
      readOnly: true,
      mutationMethodsUsed: [],
      tokenPrinted: false,
      dnsChanged: false,
      cloudflareMutation: false,
      resellerClubMutation: false,
      customHostnameCreated: false,
      workerRouteCreated: false
    }
  };

  if (!zoneId) {
    result.checks.push({
      name: "config_zone_id",
      required: true,
      method: "none",
      path: null,
      ok: false,
      httpStatus: 0,
      result: null,
      errors: [{
        code: "CLOUDFLARE_ZONE_ID_MISSING",
        safeMessage: "CLOUDFLARE_ZONE_ID is not configured.",
        likelyMissingPermission: "Set CLOUDFLARE_ZONE_ID for the shipmastr.com zone"
      }]
    });
    result.missingPermissionHints = ["Set CLOUDFLARE_ZONE_ID for the shipmastr.com zone"];
    return result;
  }

  try {
    buildCloudflareHeaders(source);
  } catch (error) {
    result.checks.push({
      name: "config_auth",
      required: true,
      method: "none",
      path: null,
      ok: false,
      httpStatus: 0,
      result: null,
      errors: [{
        code: String(error?.message || "CLOUDFLARE_AUTH_NOT_CONFIGURED"),
        safeMessage: "Cloudflare API token auth is not configured.",
        likelyMissingPermission: authSummary.authMode === "global_key"
          ? "Provide CLOUDFLARE_AUTH_EMAIL and CLOUDFLARE_GLOBAL_API_KEY only for emergency/manual mode"
          : "Provide CLOUDFLARE_API_TOKEN as a raw scoped API token"
      }]
    });
    result.missingPermissionHints = result.checks.flatMap((check) => check.errors.map((error) => error.likelyMissingPermission));
    return result;
  }

  const checks = [
    { name: "zone_read", path: "" },
    { name: "custom_hostnames_list", path: "/custom_hostnames?per_page=50" },
    { name: "custom_hostnames_lookup_www", path: `/custom_hostnames?hostname=${encodeURIComponent(customHostname)}` },
    { name: "fallback_origin_read", path: "/custom_hostnames/fallback_origin", required: false },
    { name: "workers_routes_read", path: "/workers/routes" },
    { name: `dns_records_${customHostname}`, path: `/dns_records?name=${encodeURIComponent(customHostname)}` },
    { name: `dns_records_${originHostname}`, path: `/dns_records?name=${encodeURIComponent(originHostname)}` }
  ];

  for (const check of checks) {
    const checkResult = await cloudflareGet({
      source,
      fetchFn,
      zoneId,
      checkName: check.name,
      path: check.path,
      required: check.required !== false
    });
    result.checks.push(checkResult);

    if (check.name === "zone_read" && !checkResult.ok && hasBlockingAuthFailure(checkResult)) {
      break;
    }

    if (check.name === "custom_hostnames_lookup_www" && checkResult.ok) {
      const customHostnameId = checkResult.result?.customHostnameId;
      const rawEntry = await cloudflareGet({
        source,
        fetchFn,
        zoneId,
        checkName: "custom_hostname_details_www",
        path: customHostnameId && !String(customHostnameId).includes("…")
          ? `/custom_hostnames/${encodeURIComponent(customHostnameId)}`
          : "",
        required: false
      });

      if (customHostnameId && !String(customHostnameId).includes("…")) {
        result.checks.push(rawEntry);
      }
    }
  }

  const requiredChecksOk = result.checks.filter((check) => check.required !== false).every(checkOk);
  result.ok = requiredChecksOk;
  result.missingPermissionHints = Array.from(new Set(
    result.checks
      .filter((check) => !checkOk(check))
      .flatMap((check) => check.errors || [])
      .map((error) => error.likelyMissingPermission)
      .filter(Boolean)
  ));

  return redactSecrets(result);
}

function main() {
  const json = hasArg("--json");
  runCloudflareTokenPreflight({
    source: process.env,
    fetchFn: fetch,
    customHostname: argValue("--custom-hostname") || DEFAULT_CUSTOM_HOSTNAME,
    originHostname: argValue("--origin-hostname") || DEFAULT_ORIGIN_HOSTNAME
  }).then((result) => {
    const output = JSON.stringify(result, null, 2);
    console.log(output);
    if (!result.ok) process.exitCode = 1;
    if (!json && result.ok) {
      console.error("Cloudflare scoped token preflight passed with read-only checks.");
    }
  }).catch((error) => {
    console.log(JSON.stringify({
      ok: false,
      error: String(error?.message || error || "Cloudflare scoped token preflight failed"),
      safety: {
        readOnly: true,
        tokenPrinted: false,
        dnsChanged: false,
        cloudflareMutation: false,
        resellerClubMutation: false
      }
    }, null, 2));
    process.exitCode = 1;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
