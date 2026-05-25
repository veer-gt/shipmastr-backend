import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import dotenv from "dotenv";

type SmokeModule = {
  CLOUDFLARE_DOTENV_OPTIONS: { override: boolean; quiet: boolean };
  CLOUDFLARE_APPROVED_REAL_HOSTNAME: string;
  CLOUDFLARE_APPROVED_REAL_HOSTNAMES: readonly string[];
  CLOUDFLARE_TEST_HOSTNAME: string;
  assertCloudflareRealHostnameAllowed(input: {
    hostname: string;
    approvedRealDomain?: string;
    cleanup?: boolean;
    source: Record<string, string | undefined>;
  }): string;
  assertCloudflareTestHostnameAllowed(input: { hostname: string; source: Record<string, string | undefined> }): string;
  buildCloudflareAuthDebugSummary(source?: Record<string, string | undefined>): {
    authMode: string;
    hasAuthorizationHeader: boolean;
    hasXAuthEmail: boolean;
    hasXAuthKey: boolean;
    hasContentType: boolean;
    hasZoneId: boolean;
    allowTestHostname: boolean;
    allowRealHostname: boolean;
    customMetadataEnabled: boolean;
  };
  buildCloudflareCustomHostnameBody(hostname: string, source?: Record<string, string | undefined>): unknown;
  buildCloudflareHeaders(source?: Record<string, string | undefined>): Record<string, string>;
  runCloudflareTestHostnameSmoke(input: {
    hostname: string;
    cleanup?: boolean;
    source: Record<string, string | undefined>;
    fetchFn: typeof fetch;
    onCleanup?: (status: string) => void;
  }): Promise<unknown>;
  runCloudflareRealHostnameCreation(input: {
    hostname: string;
    approvedRealDomain?: string;
    cleanup?: boolean;
    source: Record<string, string | undefined>;
    fetchFn: typeof fetch;
  }): Promise<unknown>;
  runCloudflareRealHostnameValidationRecordLookup(input: {
    hostname: string;
    approvedRealDomain?: string;
    cleanup?: boolean;
    source: Record<string, string | undefined>;
    fetchFn: typeof fetch;
  }): Promise<unknown>;
  safeCloudflareCustomHostnameSummary(input: unknown): unknown;
};

async function loadSmokeModule(): Promise<SmokeModule> {
  return import(pathToFileURL(join(process.cwd(), "scripts/domains-cloudflare-test-hostname-smoke.mjs")).href) as Promise<SmokeModule>;
}

const env = {
  CLOUDFLARE_API_TOKEN: "secret-cloudflare-token",
  CLOUDFLARE_ZONE_ID: "zone-id",
  ALLOW_CLOUDFLARE_TEST_HOSTNAME: "true",
  ALLOW_LIVE_DOMAIN_REGISTRATION: "false"
};

const realDomainEnv = {
  CLOUDFLARE_AUTH_MODE: "global_key",
  CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
  CLOUDFLARE_GLOBAL_API_KEY: "temporary-global-api-key",
  CLOUDFLARE_ZONE_ID: "zone-id",
  ALLOW_CLOUDFLARE_REAL_HOSTNAME: "true",
  ALLOW_LIVE_DOMAIN_REGISTRATION: "false",
  CLOUDFLARE_CUSTOM_METADATA_ENABLED: "false"
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json" }
  });
}

describe("Cloudflare test hostname smoke script", () => {
  it("refuses production/internal hostnames and only allows the explicit test hostname", async () => {
    const smoke = await loadSmokeModule();

    for (const hostname of [
      "shipmastr.com",
      "www.shipmastr.com",
      "api.shipmastr.com",
      "seller.shipmastr.com",
      "admin.shipmastr.com",
      "merchant-example.com"
    ]) {
      assert.throws(
        () => smoke.assertCloudflareTestHostnameAllowed({ hostname, source: env }),
        /REFUSING_PLATFORM_HOSTNAME|ONLY_CF_TEST_SHIPMASTR_COM_ALLOWED/
      );
    }

    assert.equal(
      smoke.assertCloudflareTestHostnameAllowed({ hostname: smoke.CLOUDFLARE_TEST_HOSTNAME, source: env }),
      smoke.CLOUDFLARE_TEST_HOSTNAME
    );
  });

  it("requires the explicit Cloudflare test hostname gate and keeps live registration blocked", async () => {
    const smoke = await loadSmokeModule();

    assert.throws(
      () => smoke.assertCloudflareTestHostnameAllowed({
        hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
        source: { ...env, ALLOW_CLOUDFLARE_TEST_HOSTNAME: "false" }
      }),
      /ALLOW_CLOUDFLARE_TEST_HOSTNAME_REQUIRED/
    );
    assert.throws(
      () => smoke.assertCloudflareTestHostnameAllowed({
        hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
        source: { ...env, ALLOW_LIVE_DOMAIN_REGISTRATION: "true" }
      }),
      /REFUSING_WHILE_LIVE_REGISTRATION_UNBLOCKED/
    );
  });

  it("omits optional Custom Hostname metadata by default", async () => {
    const smoke = await loadSmokeModule();
    const body = smoke.buildCloudflareCustomHostnameBody(smoke.CLOUDFLARE_TEST_HOSTNAME) as any;

    assert.equal(body.hostname, smoke.CLOUDFLARE_TEST_HOSTNAME);
    assert.equal(body.ssl.method, "http");
    assert.equal(body.ssl.type, "dv");
    assert.equal(body.custom_metadata, undefined);
    assert.equal(JSON.stringify(body).includes(env.CLOUDFLARE_API_TOKEN), false);
    assert.equal(JSON.stringify(body).includes(env.CLOUDFLARE_ZONE_ID), false);
  });

  it("includes optional Custom Hostname metadata only behind the explicit feature flag", async () => {
    const smoke = await loadSmokeModule();
    const body = smoke.buildCloudflareCustomHostnameBody(smoke.CLOUDFLARE_TEST_HOSTNAME, {
      CLOUDFLARE_CUSTOM_METADATA_ENABLED: "true"
    }) as any;

    assert.equal(body.custom_metadata.source, "shipmastr-domains");
    assert.equal(body.custom_metadata.purpose, "cloudflare-test-hostname");
    assert.equal(body.custom_metadata.test_hostname, "true");
  });

  it("creates, reads, and cleans up only the script-created test hostname without logging token values", async () => {
    const smoke = await loadSmokeModule();
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    let cleanupStatus = "";
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: String(init?.method || "GET"),
        body: typeof init?.body === "string" ? init.body : undefined
      });

      if (String(init?.headers || "").includes(env.CLOUDFLARE_API_TOKEN)) {
        throw new Error("test harness cannot inspect Headers object");
      }

      if (String(url).endsWith(`/zones/${env.CLOUDFLARE_ZONE_ID}`)) {
        return jsonResponse({ success: true, result: { id: env.CLOUDFLARE_ZONE_ID, name: "shipmastr.com" } });
      }
      if (init?.method === "POST") {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_custom_hostname_test_id",
            hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
            status: "pending",
            ssl: {
              status: "pending_validation",
              method: "http",
              validation_records: [{ txt_name: "_cf-custom-hostname", txt_value: "safe-value" }]
            }
          }
        });
      }
      if (init?.method === "GET") {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_custom_hostname_test_id",
            hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
            status: "pending",
            ssl: {
              status: "pending_validation",
              method: "http",
              validation_records: [{ txt_name: "_cf-custom-hostname", txt_value: "safe-value" }]
            }
          }
        });
      }
      if (init?.method === "DELETE") {
        return jsonResponse({ success: true, result: { id: "cloudflare_custom_hostname_test_id" } });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const result = await smoke.runCloudflareTestHostnameSmoke({
      hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
      cleanup: true,
      source: env,
      fetchFn,
      onCleanup: (status) => {
        cleanupStatus = status;
      }
    }) as any;
    const serializedResult = JSON.stringify(result);
    const deleteRequest = requests.find((request) => request.method === "DELETE");
    const createRequest = requests.find((request) => request.method === "POST");

    assert.equal(result.created, true);
    assert.equal(result.details.validationRecordPresence, true);
    assert.equal(cleanupStatus, "deleted");
    assert.ok(deleteRequest?.url.endsWith("/custom_hostnames/cloudflare_custom_hostname_test_id"));
    assert.equal(createRequest?.body?.includes(smoke.CLOUDFLARE_TEST_HOSTNAME), true);
    assert.equal(serializedResult.includes(env.CLOUDFLARE_API_TOKEN), false);
    assert.equal(serializedResult.includes(env.CLOUDFLARE_ZONE_ID), false);
  });

  it("supports temporary Global API Key auth when explicitly requested", async () => {
    const smoke = await loadSmokeModule();
    const requests: Array<{ url: string; method: string; headers: Headers; body: string | undefined }> = [];
    const globalEnv = {
      CLOUDFLARE_AUTH_MODE: "global_key",
      CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
      CLOUDFLARE_GLOBAL_API_KEY: "temporary-global-api-key",
      CLOUDFLARE_ZONE_ID: "zone-id",
      ALLOW_CLOUDFLARE_TEST_HOSTNAME: "true",
      ALLOW_LIVE_DOMAIN_REGISTRATION: "false"
    };
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(url),
        method: String(init?.method || "GET"),
        headers,
        body: typeof init?.body === "string" ? init.body : undefined
      });

      if (String(url).endsWith(`/zones/${globalEnv.CLOUDFLARE_ZONE_ID}`)) {
        return jsonResponse({ success: true, result: { id: globalEnv.CLOUDFLARE_ZONE_ID, name: "shipmastr.com" } });
      }
      if (init?.method === "POST") {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_custom_hostname_test_id",
            hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
            status: "pending",
            ssl: { status: "pending_validation", method: "http" }
          }
        });
      }
      if (init?.method === "GET") {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_custom_hostname_test_id",
            hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
            status: "pending",
            ssl: { status: "pending_validation", method: "http" }
          }
        });
      }
      if (init?.method === "DELETE") return jsonResponse({ success: true });
      throw new Error("unexpected request");
    }) as typeof fetch;

    const result = await smoke.runCloudflareTestHostnameSmoke({
      hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
      cleanup: true,
      source: globalEnv,
      fetchFn
    }) as any;
    const firstHeaders = requests[0]?.headers;
    const serialized = JSON.stringify(result);

    assert.equal(result.created, true);
    assert.equal(firstHeaders?.get("x-auth-email"), globalEnv.CLOUDFLARE_AUTH_EMAIL);
    assert.equal(firstHeaders?.get("x-auth-key"), globalEnv.CLOUDFLARE_GLOBAL_API_KEY);
    assert.equal(firstHeaders?.has("authorization"), false);
    assert.equal(serialized.includes(globalEnv.CLOUDFLARE_GLOBAL_API_KEY), false);
    assert.equal(serialized.includes(globalEnv.CLOUDFLARE_AUTH_EMAIL), false);
  });

  it("builds mutually exclusive Global API Key headers", async () => {
    const smoke = await loadSmokeModule();
    const headers = smoke.buildCloudflareHeaders({
      CLOUDFLARE_AUTH_MODE: "global_key",
      CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
      CLOUDFLARE_GLOBAL_API_KEY: "temporary-global-api-key"
    });

    assert.equal(headers.Authorization, undefined);
    assert.equal(headers["X-Auth-Email"], "admin@example.test");
    assert.equal(headers["X-Auth-Key"], "temporary-global-api-key");
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("builds mutually exclusive API token headers", async () => {
    const smoke = await loadSmokeModule();
    const headers = smoke.buildCloudflareHeaders({
      CLOUDFLARE_AUTH_MODE: "api_token",
      CLOUDFLARE_API_TOKEN: "Bearer temporary-token-value"
    });

    assert.equal(headers.Authorization, "Bearer temporary-token-value");
    assert.equal(headers["X-Auth-Email"], undefined);
    assert.equal(headers["X-Auth-Key"], undefined);
    assert.equal(headers["Content-Type"], "application/json");
  });

  it("debug auth header summary prints booleans only and no secret values", async () => {
    const smoke = await loadSmokeModule();
    const source = {
      CLOUDFLARE_AUTH_MODE: "global_key",
      CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
      CLOUDFLARE_GLOBAL_API_KEY: "temporary-global-api-key",
      CLOUDFLARE_ZONE_ID: "zone-id",
      ALLOW_CLOUDFLARE_TEST_HOSTNAME: "true",
      ALLOW_LIVE_DOMAIN_REGISTRATION: "false",
      CLOUDFLARE_CUSTOM_METADATA_ENABLED: "false"
    };

    const summary = smoke.buildCloudflareAuthDebugSummary(source);
    const serialized = JSON.stringify(summary);

    assert.deepEqual(summary, {
      authMode: "global_key",
      hasAuthorizationHeader: false,
      hasXAuthEmail: true,
      hasXAuthKey: true,
      hasContentType: true,
      hasZoneId: true,
      allowTestHostname: true,
      allowRealHostname: false,
      customMetadataEnabled: false
    });
    assert.equal(serialized.includes(source.CLOUDFLARE_AUTH_EMAIL), false);
    assert.equal(serialized.includes(source.CLOUDFLARE_GLOBAL_API_KEY), false);
    assert.equal(serialized.includes(source.CLOUDFLARE_ZONE_ID), false);
  });

  it("keeps runtime shell env values ahead of dotenv values", async () => {
    const smoke = await loadSmokeModule();
    const tempDir = mkdtempSync(join(tmpdir(), "shipmastr-cloudflare-env-"));
    const envPath = join(tempDir, ".env");
    const processEnv: Record<string, string | undefined> = {
      CLOUDFLARE_AUTH_MODE: "global_key",
      CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
      CLOUDFLARE_GLOBAL_API_KEY: "temporary-global-api-key"
    };

    try {
      writeFileSync(envPath, [
        "CLOUDFLARE_AUTH_MODE=api_token",
        "CLOUDFLARE_API_TOKEN=dotenv-token"
      ].join("\n"));

      dotenv.config({
        ...smoke.CLOUDFLARE_DOTENV_OPTIONS,
        path: envPath,
        processEnv
      });

      const headers = smoke.buildCloudflareHeaders(processEnv);

      assert.equal(processEnv.CLOUDFLARE_AUTH_MODE, "global_key");
      assert.equal(processEnv.CLOUDFLARE_API_TOKEN, "dotenv-token");
      assert.equal(headers.Authorization, undefined);
      assert.equal(headers["X-Auth-Email"], processEnv.CLOUDFLARE_AUTH_EMAIL);
      assert.equal(headers["X-Auth-Key"], processEnv.CLOUDFLARE_GLOBAL_API_KEY);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("maps Cloudflare custom_metadata entitlement errors to a safe internal status", async () => {
    const smoke = await loadSmokeModule();
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith(`/zones/${env.CLOUDFLARE_ZONE_ID}`)) {
        return jsonResponse({ success: true, result: { id: env.CLOUDFLARE_ZONE_ID, name: "shipmastr.com" } });
      }
      if (init?.method === "POST") {
        return jsonResponse({
          success: false,
          errors: [{ code: 1413, message: "No custom metadata access has been allocated for this zone or account." }]
        }, { status: 403 });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const result = await smoke.runCloudflareTestHostnameSmoke({
      hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
      cleanup: true,
      source: env,
      fetchFn
    }) as any;
    const serialized = JSON.stringify(result);

    assert.equal(result.created, false);
    assert.equal(result.cloudflareErrors[0].code, 1413);
    assert.equal(result.cloudflareErrors[0].internalStatus, "CUSTOM_METADATA_NOT_ENABLED");
    assert.equal(serialized.includes(env.CLOUDFLARE_API_TOKEN), false);
  });

  it("blocks shipmastr.co.in in default smoke mode without the explicit real-domain flag", async () => {
    const smoke = await loadSmokeModule();

    assert.throws(
      () => smoke.assertCloudflareTestHostnameAllowed({
        hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        source: env
      }),
      /ONLY_CF_TEST_SHIPMASTR_COM_ALLOWED/
    );
  });

  it("requires the real-domain allow gate for shipmastr.co.in", async () => {
    const smoke = await loadSmokeModule();

    assert.throws(
      () => smoke.assertCloudflareRealHostnameAllowed({
        hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        approvedRealDomain: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        source: { ...realDomainEnv, ALLOW_CLOUDFLARE_REAL_HOSTNAME: "false" }
      }),
      /ALLOW_CLOUDFLARE_REAL_HOSTNAME_REQUIRED/
    );
  });

  it("requires the approved real-domain flag to match shipmastr.co.in exactly", async () => {
    const smoke = await loadSmokeModule();

    assert.throws(
      () => smoke.assertCloudflareRealHostnameAllowed({
        hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        approvedRealDomain: "other-domain.example",
        source: realDomainEnv
      }),
      /APPROVED_REAL_DOMAIN_REQUIRED/
    );
  });

  it("allows only the approved real-domain allowlist and requires the flag to match the requested hostname", async () => {
    const smoke = await loadSmokeModule();

    assert.deepEqual(
      smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAMES,
      ["shipmastr.co.in", "www.shipmastr.co.in"]
    );

    assert.equal(
      smoke.assertCloudflareRealHostnameAllowed({
        hostname: "www.shipmastr.co.in",
        approvedRealDomain: "www.shipmastr.co.in",
        source: realDomainEnv
      }),
      "www.shipmastr.co.in"
    );

    assert.throws(
      () => smoke.assertCloudflareRealHostnameAllowed({
        hostname: "shop.shipmastr.co.in",
        approvedRealDomain: "shop.shipmastr.co.in",
        source: realDomainEnv
      }),
      /ONLY_APPROVED_REAL_HOSTNAME_ALLOWED/
    );

    assert.throws(
      () => smoke.assertCloudflareRealHostnameAllowed({
        hostname: "www.shipmastr.co.in",
        approvedRealDomain: "shipmastr.co.in",
        source: realDomainEnv
      }),
      /APPROVED_REAL_DOMAIN_REQUIRED/
    );
  });

  it("blocks real-domain creation when live registration is unblocked", async () => {
    const smoke = await loadSmokeModule();

    assert.throws(
      () => smoke.assertCloudflareRealHostnameAllowed({
        hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        approvedRealDomain: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        source: { ...realDomainEnv, ALLOW_LIVE_DOMAIN_REGISTRATION: "true" }
      }),
      /ALLOW_LIVE_DOMAIN_REGISTRATION_MUST_BE_FALSE/
    );
  });

  it("blocks real-domain creation when custom_metadata is enabled", async () => {
    const smoke = await loadSmokeModule();

    assert.throws(
      () => smoke.assertCloudflareRealHostnameAllowed({
        hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        approvedRealDomain: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        source: { ...realDomainEnv, CLOUDFLARE_CUSTOM_METADATA_ENABLED: "true" }
      }),
      /CLOUDFLARE_CUSTOM_METADATA_MUST_BE_FALSE/
    );
  });

  it("blocks cleanup for the real-domain path by default", async () => {
    const smoke = await loadSmokeModule();

    assert.throws(
      () => smoke.assertCloudflareRealHostnameAllowed({
        hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        approvedRealDomain: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
        cleanup: true,
        source: realDomainEnv
      }),
      /REAL_HOSTNAME_CLEANUP_BLOCKED_WITHOUT_CONFIRM_DELETE/
    );
  });

  it("creates only shipmastr.co.in in real-domain mode without custom_metadata or cleanup", async () => {
    const smoke = await loadSmokeModule();
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: String(init?.method || "GET"),
        body: typeof init?.body === "string" ? init.body : undefined
      });

      if (String(url).endsWith(`/zones/${realDomainEnv.CLOUDFLARE_ZONE_ID}`)) {
        return jsonResponse({ success: true, result: { id: realDomainEnv.CLOUDFLARE_ZONE_ID, name: "shipmastr.com" } });
      }
      if (String(url).includes("/custom_hostnames?hostname=")) {
        return jsonResponse({ success: true, result: [] });
      }
      if (init?.method === "POST") {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_real_hostname_id",
            hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
            status: "pending",
            ssl: {
              status: "initializing",
              method: "http",
              validation_records: [{ http_url: "https://redacted.test", http_body: "redacted" }]
            },
            ownership_verification: {
              type: "txt",
              name: "_cf-custom-hostname.shipmastr.co.in",
              value: "redacted"
            }
          }
        });
      }
      if (init?.method === "GET" && String(url).includes("/custom_hostnames/cloudflare_real_hostname_id")) {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_real_hostname_id",
            hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
            status: "pending",
            ssl: {
              status: "initializing",
              method: "http",
              validation_records: [{ http_url: "https://redacted.test", http_body: "redacted" }]
            },
            ownership_verification: {
              type: "txt",
              name: "_cf-custom-hostname.shipmastr.co.in",
              value: "redacted"
            }
          }
        });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const result = await smoke.runCloudflareRealHostnameCreation({
      hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
      approvedRealDomain: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
      source: realDomainEnv,
      fetchFn
    }) as any;
    const postRequest = requests.find((request) => request.method === "POST");

    assert.equal(result.created, true);
    assert.equal(result.hostname, smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME);
    assert.equal(result.customMetadataIncluded, false);
    assert.equal(result.cleanupStatus, "not_requested");
    assert.equal(result.details.validationRecordPresence, true);
    assert.equal(postRequest?.body?.includes("\"custom_metadata\""), false);
    assert.equal(requests.some((request) => request.method === "DELETE"), false);
    assert.equal(requests.some((request) => request.url.includes("/dns_records")), false);
  });

  it("creates only www.shipmastr.co.in in real-domain mode without DNS mutation or cleanup", async () => {
    const smoke = await loadSmokeModule();
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    const hostname = "www.shipmastr.co.in";
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: String(init?.method || "GET"),
        body: typeof init?.body === "string" ? init.body : undefined
      });

      if (String(url).endsWith(`/zones/${realDomainEnv.CLOUDFLARE_ZONE_ID}`)) {
        return jsonResponse({ success: true, result: { id: realDomainEnv.CLOUDFLARE_ZONE_ID, name: "shipmastr.com" } });
      }
      if (String(url).includes("/custom_hostnames?hostname=")) {
        return jsonResponse({ success: true, result: [] });
      }
      if (init?.method === "POST") {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_www_real_hostname_id",
            hostname,
            status: "pending",
            ssl: {
              status: "initializing",
              method: "http",
              validation_records: [{ http_url: "https://redacted.test", http_body: "redacted" }]
            }
          }
        });
      }
      if (init?.method === "GET" && String(url).includes("/custom_hostnames/cloudflare_www_real_hostname_id")) {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_www_real_hostname_id",
            hostname,
            status: "pending",
            ssl: {
              status: "initializing",
              method: "http",
              validation_records: [{ http_url: "https://redacted.test", http_body: "redacted" }]
            }
          }
        });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const result = await smoke.runCloudflareRealHostnameCreation({
      hostname,
      approvedRealDomain: hostname,
      source: realDomainEnv,
      fetchFn
    }) as any;
    const postRequest = requests.find((request) => request.method === "POST");

    assert.equal(result.created, true);
    assert.equal(result.hostname, hostname);
    assert.equal(result.customMetadataIncluded, false);
    assert.equal(result.cleanupStatus, "not_requested");
    assert.equal(result.details.validationRecordPresence, true);
    assert.equal(postRequest?.body?.includes("\"custom_metadata\""), false);
    assert.equal(requests.some((request) => request.method === "DELETE"), false);
    assert.equal(requests.some((request) => request.url.includes("/dns_records")), false);
  });

  it("prints public validation records for shipmastr.co.in without creating or changing DNS", async () => {
    const smoke = await loadSmokeModule();
    const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: String(init?.method || "GET"),
        body: typeof init?.body === "string" ? init.body : undefined
      });

      if (String(url).endsWith(`/zones/${realDomainEnv.CLOUDFLARE_ZONE_ID}`)) {
        return jsonResponse({ success: true, result: { id: realDomainEnv.CLOUDFLARE_ZONE_ID, name: "shipmastr.com" } });
      }
      if (String(url).includes("/custom_hostnames?hostname=")) {
        return jsonResponse({
          success: true,
          result: [{
            id: "cloudflare_real_hostname_id",
            hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME
          }]
        });
      }
      if (init?.method === "GET" && String(url).includes("/custom_hostnames/cloudflare_real_hostname_id")) {
        return jsonResponse({
          success: true,
          result: {
            id: "cloudflare_real_hostname_id",
            hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
            status: "pending",
            ssl: {
              status: "initializing",
              method: "http",
              validation_records: [{
                http_url: "https://shipmastr.co.in/.well-known/cf-custom-hostname-challenge/example",
                http_body: "public-http-validation-body"
              }]
            },
            ownership_verification: {
              type: "txt",
              name: "_cf-custom-hostname.shipmastr.co.in",
              value: "public-txt-validation-value"
            }
          }
        });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const result = await smoke.runCloudflareRealHostnameValidationRecordLookup({
      hostname: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
      approvedRealDomain: smoke.CLOUDFLARE_APPROVED_REAL_HOSTNAME,
      source: realDomainEnv,
      fetchFn
    }) as any;
    const serialized = JSON.stringify(result);

    assert.equal(result.details.validationRecords.txt[0].name, "_cf-custom-hostname.shipmastr.co.in");
    assert.equal(result.details.validationRecords.txt[0].value, "public-txt-validation-value");
    assert.equal(result.details.validationRecords.http[0].url.includes("shipmastr.co.in"), true);
    assert.equal(result.details.whereToAddTxt.includes("OrderBox/WebPro"), true);
    assert.equal(result.details.nameserverChangeRequired, false);
    assert.equal(requests.some((request) => request.method === "POST"), false);
    assert.equal(requests.some((request) => request.method === "DELETE"), false);
    assert.equal(requests.some((request) => request.url.includes("/dns_records")), false);
    assert.equal(serialized.includes(realDomainEnv.CLOUDFLARE_GLOBAL_API_KEY), false);
    assert.equal(serialized.includes(realDomainEnv.CLOUDFLARE_AUTH_EMAIL), false);
  });

  it("requires Global API Key auth mode before accepting temporary global credentials", async () => {
    const smoke = await loadSmokeModule();

    assert.throws(
      () => smoke.assertCloudflareTestHostnameAllowed({
        hostname: smoke.CLOUDFLARE_TEST_HOSTNAME,
        source: {
          CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
          CLOUDFLARE_GLOBAL_API_KEY: "temporary-global-api-key",
          CLOUDFLARE_ZONE_ID: "zone-id",
          ALLOW_CLOUDFLARE_TEST_HOSTNAME: "true",
          ALLOW_LIVE_DOMAIN_REGISTRATION: "false"
        }
      }),
      /CLOUDFLARE_PROVIDER_NOT_CONFIGURED/
    );
  });

  it("keeps the script free of ResellerClub and DNS mutation paths", () => {
    const script = readFileSync("scripts/domains-cloudflare-test-hostname-smoke.mjs", "utf8");

    assert.equal(script.includes("RESELLERCLUB"), false);
    assert.equal(script.includes("httpapi.com"), false);
    assert.equal(script.includes("register.json"), false);
    assert.equal(script.includes("/dns_records"), false);
    assert.equal(script.includes("console.log(process.env"), false);
  });
});
