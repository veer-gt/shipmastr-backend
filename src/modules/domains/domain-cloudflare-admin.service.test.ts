import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import {
  fetchCloudflareValidationRecordsForAdmin,
  runCloudflareCustomHostnameAdminAction,
  runCloudflareWorkerRouteAdminAction
} from "./domain-cloudflare-admin.service.js";

const baseSource = {
  CLOUDFLARE_AUTH_MODE: "api_token",
  CLOUDFLARE_API_TOKEN: "scoped-token",
  CLOUDFLARE_ZONE_ID: "zone-id",
  CLOUDFLARE_CUSTOM_METADATA_ENABLED: false,
  ALLOW_CLOUDFLARE_ADMIN_MUTATIONS: false,
  ALLOW_APEX_DOMAIN_AUTOMATION: false
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json" }
  });
}

function mockFetch(requests: Array<{ url: string; method: string; headers: Headers; body?: string }>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const record: { url: string; method: string; headers: Headers; body?: string } = {
      url: String(url),
      method: String(init?.method || "GET"),
      headers: new Headers(init?.headers)
    };
    if (typeof init?.body === "string") record.body = init.body;
    requests.push(record);

    if (record.method === "GET" && record.url.includes("/custom_hostnames?hostname=www.brand.example.in")) {
      return jsonResponse({
        success: true,
        result: [{
          id: "custom_hostname_full_id",
          hostname: "www.brand.example.in",
          status: "pending",
          ssl: { status: "pending_validation", method: "http" }
        }]
      });
    }

    if (record.method === "GET" && record.url.includes("/custom_hostnames/custom_hostname_full_id")) {
      return jsonResponse({
        success: true,
        result: {
          id: "custom_hostname_full_id",
          hostname: "www.brand.example.in",
          status: "pending",
          ssl: { status: "pending_validation", method: "http" },
          ownership_verification: {
            name: "_cf-custom-hostname.www.brand.example.in",
            value: "public-validation-token"
          },
          ownership_verification_http: {
            http_url: "http://www.brand.example.in/.well-known/cf-custom-hostname",
            http_body: "public-http-token"
          }
        }
      });
    }

    if (record.method === "GET" && record.url.includes("/workers/routes")) {
      return jsonResponse({
        success: true,
        result: [{ id: "route-existing", pattern: "storefront-origin.shipmastr.com/*", script: "shipmastr-origin-shim" }]
      });
    }

    if (record.method === "POST" && record.url.includes("/custom_hostnames")) {
      return jsonResponse({
        success: true,
        result: {
          id: "new_custom_hostname_id",
          hostname: "www.brand.example.in",
          status: "pending",
          ssl: { status: "initializing", method: "http" }
        }
      });
    }

    if (record.method === "POST" && record.url.includes("/workers/routes")) {
      return jsonResponse({
        success: true,
        result: { id: "new_route_id", pattern: "www.brand.example.in/*", script: "shipmastr-origin-shim" }
      });
    }

    throw new Error(`unexpected Cloudflare admin URL: ${record.method} ${record.url}`);
  }) as typeof fetch;
}

describe("admin Cloudflare mutation gate design", () => {
  it("mounts Cloudflare admin routes behind the existing admin domains guard", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const domainRoutes = readFileSync("src/modules/domains/domains.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/admin\/domains", requireAdminJwt, adminDomainsRouter\);/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/cloudflare\/custom-hostname"/);
    assert.match(domainRoutes, /adminDomainsRouter\.get\("\/:domain\/cloudflare\/validation-records"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/cloudflare\/worker-route"/);
  });

  it("previews Custom Hostname creation without a Cloudflare mutation by default", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await runCloudflareCustomHostnameAdminAction({
      domain: "www.brand.example.in",
      confirmDomain: "www.brand.example.in",
      source: baseSource,
      fetchFn: mockFetch(requests)
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.mutationAllowed, false);
    assert.equal(result.wouldMutate, false);
    assert.equal(result.body.hostname, "www.brand.example.in");
    assert.equal("custom_metadata" in result.body, false);
    assert.equal(requests.length, 0);
  });

  it("previews Cloudflare mutations even when read/write Cloudflare config is not present", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const sourceWithoutCloudflareConfig = {
      ALLOW_CLOUDFLARE_ADMIN_MUTATIONS: false,
      ALLOW_APEX_DOMAIN_AUTOMATION: false
    };

    const customHostname = await runCloudflareCustomHostnameAdminAction({
      domain: "www.brand.example.in",
      confirmDomain: "www.brand.example.in",
      source: sourceWithoutCloudflareConfig,
      fetchFn: mockFetch(requests)
    });
    const workerRoute = await runCloudflareWorkerRouteAdminAction({
      domain: "www.brand.example.in",
      confirmDomain: "www.brand.example.in",
      source: sourceWithoutCloudflareConfig,
      fetchFn: mockFetch(requests)
    });

    assert.equal(customHostname.dryRun, true);
    assert.equal(customHostname.wouldMutate, false);
    assert.equal(workerRoute.dryRun, true);
    assert.equal(workerRoute.body?.pattern, "www.brand.example.in/*");
    assert.equal(requests.length, 0);
  });

  it("blocks real Custom Hostname mutation unless the env gate is enabled", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];

    await assert.rejects(
      () => runCloudflareCustomHostnameAdminAction({
        domain: "www.brand.example.in",
        confirmDomain: "www.brand.example.in",
        dryRun: false,
        source: baseSource,
        fetchFn: mockFetch(requests)
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.message, "CLOUDFLARE_ADMIN_MUTATIONS_DISABLED");
        return true;
      }
    );

    assert.equal(requests.length, 0);
  });

  it("requires exact confirmDomain before any mutation preview", async () => {
    await assert.rejects(
      () => runCloudflareCustomHostnameAdminAction({
        domain: "www.brand.example.in",
        confirmDomain: "other.example.in",
        source: baseSource
      }),
      /DOMAIN_CONFIRMATION_MISMATCH/
    );

    await assert.rejects(
      () => runCloudflareCustomHostnameAdminAction({
        domain: "www.brand.example.in",
        source: baseSource
      }),
      /DOMAIN_CONFIRMATION_REQUIRED/
    );
  });

  it("blocks apex, platform, and wildcard domains by default", async () => {
    await assert.rejects(
      () => runCloudflareCustomHostnameAdminAction({
        domain: "shipmastr.co.in",
        confirmDomain: "shipmastr.co.in",
        source: baseSource
      }),
      /APEX_DOMAIN_AUTOMATION_DISABLED/
    );
    await assert.rejects(
      () => runCloudflareCustomHostnameAdminAction({
        domain: "www.shipmastr.com",
        confirmDomain: "www.shipmastr.com",
        source: baseSource
      }),
      /DOMAIN_RESERVED_FOR_SHIPMASTR/
    );
    await assert.rejects(
      () => runCloudflareCustomHostnameAdminAction({
        domain: "*.example.in",
        confirmDomain: "*.example.in",
        source: baseSource
      }),
      /WILDCARD_DOMAIN_NOT_ALLOWED/
    );
  });

  it("uses scoped API token auth only for read-only validation records", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await fetchCloudflareValidationRecordsForAdmin({
      domain: "www.brand.example.in",
      source: baseSource,
      fetchFn: mockFetch(requests)
    });

    assert.equal(result.found, true);
    assert.equal(result.safety.readOnly, true);
    assert.equal(result.safety.cloudflareMutation, false);
    assert.equal(result.validationRecords.length, 2);
    assert.equal(requests.every((request) => request.method === "GET"), true);
    assert.equal(requests.every((request) => request.headers.has("authorization")), true);
    assert.equal(requests.some((request) => request.headers.has("x-auth-key")), false);
  });

  it("maps upstream Cloudflare 401 responses to an inline admin provider error", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: String(init?.method || "GET"),
        headers: new Headers(init?.headers)
      });
      return jsonResponse({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }]
      }, { status: 401 });
    }) as typeof fetch;

    await assert.rejects(
      () => fetchCloudflareValidationRecordsForAdmin({
        domain: "www.brand.example.in",
        source: baseSource,
        fetchFn
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.message, "CLOUDFLARE_REQUEST_FAILED");
        assert.deepEqual(error.details, {
          httpStatus: 401,
          code: 10000,
          safeMessage: "Cloudflare authentication or permission check failed."
        });
        return true;
      }
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.headers.has("authorization"), true);
  });

  it("returns a safe not-checked result when validation-record Cloudflare config is absent", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await fetchCloudflareValidationRecordsForAdmin({
      domain: "www.brand.example.in",
      source: {
        ALLOW_CLOUDFLARE_ADMIN_MUTATIONS: false,
        ALLOW_APEX_DOMAIN_AUTOMATION: false
      },
      fetchFn: mockFetch(requests)
    });

    assert.equal(result.checked, false);
    assert.equal(result.found, false);
    assert.equal(result.cloudflareStatus, "not_checked_config_missing");
    assert.equal(result.reason, "CLOUDFLARE_ZONE_ID_MISSING");
    assert.equal(result.safety.readOnly, true);
    assert.equal(result.safety.cloudflareMutation, false);
    assert.equal(requests.length, 0);
  });

  it("does not use global_key mode for normal admin Cloudflare paths", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await fetchCloudflareValidationRecordsForAdmin({
      domain: "www.brand.example.in",
      source: {
        ...baseSource,
        CLOUDFLARE_AUTH_MODE: "global_key",
        CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
        CLOUDFLARE_GLOBAL_API_KEY: "temporary-key"
      },
      fetchFn: mockFetch(requests)
    });

    assert.equal(result.checked, false);
    assert.equal(result.cloudflareStatus, "not_checked_config_missing");
    assert.equal(result.reason, "CLOUDFLARE_GLOBAL_KEY_NOT_ALLOWED_FOR_ADMIN_AUTOMATION");
    assert.equal(requests.length, 0);
  });

  it("previews an exact Worker route and blocks broad wildcard routes", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await runCloudflareWorkerRouteAdminAction({
      domain: "www.brand.example.in",
      confirmDomain: "www.brand.example.in",
      source: baseSource,
      fetchFn: mockFetch(requests)
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.body?.pattern, "www.brand.example.in/*");
    assert.equal(result.body?.script, "shipmastr-origin-shim");
    assert.equal(result.safety.broadWildcardRoute, false);
    assert.equal(requests.length, 0);
  });

  it("creates exactly one Worker route only when dryRun is false and the env gate is enabled", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
    const result = await runCloudflareWorkerRouteAdminAction({
      domain: "www.brand.example.in",
      confirmDomain: "www.brand.example.in",
      dryRun: false,
      source: {
        ...baseSource,
        ALLOW_CLOUDFLARE_ADMIN_MUTATIONS: true
      },
      fetchFn: mockFetch(requests)
    });

    const post = requests.find((request) => request.method === "POST");
    assert.ok(post);
    assert.deepEqual(JSON.parse(post.body || "{}"), {
      pattern: "www.brand.example.in/*",
      script: "shipmastr-origin-shim"
    });
    assert.equal(result.route?.pattern, "www.brand.example.in/*");
    assert.equal(requests.every((request) => request.headers.has("authorization")), true);
    assert.equal(requests.some((request) => request.headers.has("x-auth-key")), false);
  });
});
