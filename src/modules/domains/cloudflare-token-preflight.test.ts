import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

type TokenPreflightModule = {
  runCloudflareTokenPreflight(input: {
    source: Record<string, string | undefined>;
    fetchFn: typeof fetch;
    customHostname?: string;
    originHostname?: string;
  }): Promise<any>;
};

async function loadPreflightModule(): Promise<TokenPreflightModule> {
  return import(pathToFileURL(join(process.cwd(), "scripts/domains-cloudflare-token-preflight.mjs")).href) as Promise<TokenPreflightModule>;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json" }
  });
}

const baseEnv = {
  CLOUDFLARE_AUTH_MODE: "api_token",
  CLOUDFLARE_API_TOKEN: "secret-scoped-token",
  CLOUDFLARE_ZONE_ID: "zone-id"
};

function mockCloudflareFetch(requests: Array<{ url: string; method: string; headers: Headers; body?: string }>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = String(url);
    const method = String(init?.method || "GET");
    const headers = new Headers(init?.headers);
    const requestRecord: { url: string; method: string; headers: Headers; body?: string } = {
      url: requestUrl,
      method,
      headers
    };
    if (typeof init?.body === "string") requestRecord.body = init.body;
    requests.push(requestRecord);

    if (method !== "GET") {
      return jsonResponse({
        success: false,
        errors: [{ code: "TEST_MUTATION", message: "mutation methods are forbidden in preflight" }]
      }, { status: 500 });
    }

    if (requestUrl.endsWith("/zones/zone-id")) {
      return jsonResponse({ success: true, result: { id: "zone-id", name: "shipmastr.com" } });
    }

    if (requestUrl.includes("/custom_hostnames?hostname=www.shipmastr.co.in")) {
      return jsonResponse({
        success: true,
        result: [{
          id: "cloudflare-www-custom-hostname-id",
          hostname: "www.shipmastr.co.in",
          status: "active",
          ssl: { status: "active", method: "http" }
        }]
      });
    }

    if (requestUrl.includes("/custom_hostnames?per_page=50")) {
      return jsonResponse({
        success: true,
        result: [{
          id: "cloudflare-www-custom-hostname-id",
          hostname: "www.shipmastr.co.in",
          status: "active",
          ssl: { status: "active", method: "http" }
        }]
      });
    }

    if (requestUrl.includes("/custom_hostnames/fallback_origin")) {
      return jsonResponse({
        success: true,
        result: { origin: "storefront-origin.shipmastr.com", status: "active" }
      });
    }

    if (requestUrl.includes("/workers/routes")) {
      return jsonResponse({
        success: true,
        result: [
          { id: "route-1", pattern: "www.shipmastr.co.in/*", script: "shipmastr-origin-shim" },
          { id: "route-2", pattern: "storefront-origin.shipmastr.com/*", script: "shipmastr-origin-shim" }
        ]
      });
    }

    if (requestUrl.includes("/dns_records?name=www.shipmastr.co.in")) {
      return jsonResponse({ success: true, result: [] });
    }

    if (requestUrl.includes("/dns_records?name=storefront-origin.shipmastr.com")) {
      return jsonResponse({
        success: true,
        result: [{
          id: "dns-1",
          type: "CNAME",
          name: "storefront-origin.shipmastr.com",
          content: "worker.example",
          proxied: true
        }]
      });
    }

    throw new Error(`unexpected Cloudflare preflight URL: ${requestUrl}`);
  }) as typeof fetch;
}

describe("Cloudflare scoped token preflight", () => {
  it("uses Authorization Bearer only in api_token mode and performs read-only checks", async () => {
    const preflight = await loadPreflightModule();
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await preflight.runCloudflareTokenPreflight({
      source: baseEnv,
      fetchFn: mockCloudflareFetch(requests)
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal(result.auth.authMode, "api_token");
    assert.equal(result.auth.hasAuthorizationHeader, true);
    assert.equal(result.auth.hasXAuthEmail, false);
    assert.equal(result.auth.hasXAuthKey, false);
    assert.equal(result.safety.readOnly, true);
    assert.equal(requests.every((request) => request.method === "GET"), true);
    assert.equal(requests.some((request) => request.body), false);
    assert.equal(requests.every((request) => request.headers.has("authorization")), true);
    assert.equal(requests.some((request) => request.headers.has("x-auth-email")), false);
    assert.equal(requests.some((request) => request.headers.has("x-auth-key")), false);
    assert.equal(serialized.includes(baseEnv.CLOUDFLARE_API_TOKEN), false);
    assert.equal(serialized.includes(baseEnv.CLOUDFLARE_ZONE_ID), false);
  });

  it("uses Global API Key headers only in emergency global_key mode without mixed auth", async () => {
    const preflight = await loadPreflightModule();
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const globalEnv = {
      CLOUDFLARE_AUTH_MODE: "global_key",
      CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
      CLOUDFLARE_GLOBAL_API_KEY: "temporary-global-key",
      CLOUDFLARE_ZONE_ID: "zone-id"
    };
    const result = await preflight.runCloudflareTokenPreflight({
      source: globalEnv,
      fetchFn: mockCloudflareFetch(requests)
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.ok, true);
    assert.equal(result.auth.authMode, "global_key");
    assert.equal(result.auth.hasAuthorizationHeader, false);
    assert.equal(result.auth.hasXAuthEmail, true);
    assert.equal(result.auth.hasXAuthKey, true);
    assert.equal(requests.every((request) => request.headers.has("x-auth-email")), true);
    assert.equal(requests.every((request) => request.headers.has("x-auth-key")), true);
    assert.equal(requests.some((request) => request.headers.has("authorization")), false);
    assert.equal(serialized.includes(globalEnv.CLOUDFLARE_AUTH_EMAIL), false);
    assert.equal(serialized.includes(globalEnv.CLOUDFLARE_GLOBAL_API_KEY), false);
  });

  it("blocks safely when the scoped token is missing", async () => {
    const preflight = await loadPreflightModule();
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await preflight.runCloudflareTokenPreflight({
      source: { CLOUDFLARE_AUTH_MODE: "api_token", CLOUDFLARE_ZONE_ID: "zone-id" },
      fetchFn: mockCloudflareFetch(requests)
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks[0].name, "config_auth");
    assert.match(result.checks[0].errors[0].code, /CLOUDFLARE_API_TOKEN_AUTH_NOT_CONFIGURED/);
    assert.equal(requests.length, 0);
  });

  it("blocks safely when the zone id is missing", async () => {
    const preflight = await loadPreflightModule();
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await preflight.runCloudflareTokenPreflight({
      source: { CLOUDFLARE_AUTH_MODE: "api_token", CLOUDFLARE_API_TOKEN: "secret-scoped-token" },
      fetchFn: mockCloudflareFetch(requests)
    });

    assert.equal(result.ok, false);
    assert.equal(result.checks[0].name, "config_zone_id");
    assert.equal(result.checks[0].errors[0].code, "CLOUDFLARE_ZONE_ID_MISSING");
    assert.equal(requests.length, 0);
  });

  it("returns safe Cloudflare error summaries with likely missing permission hints", async () => {
    const preflight = await loadPreflightModule();
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const failingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: String(init?.method || "GET"),
        headers: new Headers(init?.headers)
      });

      if (String(url).endsWith("/zones/zone-id")) {
        return jsonResponse({ success: true, result: { id: "zone-id", name: "shipmastr.com" } });
      }

      if (String(url).includes("/custom_hostnames")) {
        return jsonResponse({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }]
        }, { status: 403 });
      }

      return jsonResponse({ success: true, result: [] });
    }) as typeof fetch;

    const result = await preflight.runCloudflareTokenPreflight({
      source: baseEnv,
      fetchFn: failingFetch
    });
    const serialized = JSON.stringify(result);
    const failingCheck = result.checks.find((check: any) => check.name === "custom_hostnames_list");

    assert.equal(result.ok, false);
    assert.equal(failingCheck.httpStatus, 403);
    assert.equal(failingCheck.errors[0].code, 10000);
    assert.equal(failingCheck.errors[0].safeMessage, "Cloudflare authentication failed.");
    assert.match(failingCheck.errors[0].likelyMissingPermission, /Authentication header/);
    assert.equal(serialized.includes(baseEnv.CLOUDFLARE_API_TOKEN), false);
  });
});
