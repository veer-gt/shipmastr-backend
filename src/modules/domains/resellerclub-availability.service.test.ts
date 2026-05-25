import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DomainProvisioningStatus } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import {
  buildResellerClubAvailabilityCheckRequest,
  checkResellerClubDomainAvailability
} from "./resellerclub-availability.service.js";

const providerEnv = {
  RESELLERCLUB_BASE_URL: "https://httpapi.example.test",
  RESELLERCLUB_AUTH_USERID: "reseller-id-123",
  RESELLERCLUB_API_KEY: "super-secret-api-key"
};

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, init);
}

describe("ResellerClub availability check adapter", () => {
  it("mounts the admin check endpoint behind the existing admin domains guard", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const domainRoutes = readFileSync("src/modules/domains/domains.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/admin\/domains", requireAdminJwt, adminDomainsRouter\);/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/check-availability"/);
  });

  it("builds the valid .in provider query shape without registration params", async () => {
    let requestedUrl = "";
    const fetchFn = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return response(JSON.stringify({ "brand.in": { status: "available" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const result = await checkResellerClubDomainAvailability({
      domain: "Brand.in",
      env: providerEnv,
      fetchFn
    });
    const url = new URL(requestedUrl);

    assert.equal(url.pathname, "/api/domains/available.json");
    assert.equal(url.searchParams.get("auth-userid"), providerEnv.RESELLERCLUB_AUTH_USERID);
    assert.equal(url.searchParams.get("api-key"), providerEnv.RESELLERCLUB_API_KEY);
    assert.equal(url.searchParams.get("domain-name"), "brand");
    assert.equal(url.searchParams.get("tlds"), "in");
    assert.equal(requestedUrl.includes("register.json"), false);
    assert.equal(result.available, true);
    assert.equal(result.status, "AVAILABLE");
  });

  it("rejects malformed domains and reserved Shipmastr domains", () => {
    assert.throws(
      () => buildResellerClubAvailabilityCheckRequest("https://brand.in/path", providerEnv),
      /INVALID_DOMAIN/
    );
    assert.throws(
      () => buildResellerClubAvailabilityCheckRequest("store.brand.in", providerEnv),
      /INVALID_DOMAIN/
    );
    assert.throws(
      () => buildResellerClubAvailabilityCheckRequest("shipmastr.com", providerEnv),
      /DOMAIN_RESERVED_FOR_SHIPMASTR/
    );
  });

  it("returns CONFIG_ERROR when provider credentials are missing", async () => {
    await assert.rejects(
      () => checkResellerClubDomainAvailability({
        domain: "brand.in",
        env: {
          RESELLERCLUB_BASE_URL: "https://httpapi.example.test",
          RESELLERCLUB_AUTH_USERID: undefined,
          RESELLERCLUB_API_KEY: undefined
        },
        fetchFn: (async () => {
          throw new Error("fetch should not run without env");
        }) as typeof fetch
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 500);
        assert.equal(error.message, "CONFIG_ERROR");
        return true;
      }
    );
  });

  it("maps provider 403 to PROVIDER_FORBIDDEN with safe copy", async () => {
    const result = await checkResellerClubDomainAvailability({
      domain: "brand.in",
      env: providerEnv,
      fetchFn: (async () => response("<html>Forbidden api-key secret</html>", {
        status: 403,
        headers: { "content-type": "text/html" }
      })) as typeof fetch
    });

    assert.equal(result.available, null);
    assert.equal(result.status, "PROVIDER_FORBIDDEN");
    assert.equal(result.message, "Provider rejected the request. IP whitelist or API access may still be propagating.");
    assert.equal(JSON.stringify(result).includes(providerEnv.RESELLERCLUB_API_KEY), false);
    assert.equal(JSON.stringify(result).includes(providerEnv.RESELLERCLUB_AUTH_USERID), false);
  });

  it("maps provider timeout to PROVIDER_TIMEOUT", async () => {
    const result = await checkResellerClubDomainAvailability({
      domain: "brand.in",
      env: providerEnv,
      fetchFn: (async () => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        throw error;
      }) as typeof fetch
    });

    assert.equal(result.available, null);
    assert.equal(result.status, "PROVIDER_TIMEOUT");
  });

  it("maps provider bad JSON to PROVIDER_BAD_RESPONSE", async () => {
    const result = await checkResellerClubDomainAvailability({
      domain: "brand.in",
      env: providerEnv,
      fetchFn: (async () => response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch
    });

    assert.equal(result.available, null);
    assert.equal(result.status, "PROVIDER_BAD_RESPONSE");
    assert.equal(result.providerStatus, "invalid_json");
  });

  it("does not return secrets in safe availability responses", async () => {
    const result = await checkResellerClubDomainAvailability({
      domain: "taken.in",
      env: providerEnv,
      fetchFn: (async () => response(JSON.stringify({ "taken.in": { status: "unavailable" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.available, false);
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(serialized.includes(providerEnv.RESELLERCLUB_API_KEY), false);
    assert.equal(serialized.includes(providerEnv.RESELLERCLUB_AUTH_USERID), false);
  });

  it("writes a redacted DOMAIN_AVAILABILITY_CHECKED event when storefrontDomainId is provided", async () => {
    const events: any[] = [];
    const client = {
      domainProvisioningEvent: {
        create: async (args: any) => {
          events.push(args.data);
          return { id: "event_1", ...args.data };
        }
      }
    };

    const result = await checkResellerClubDomainAvailability({
      domain: "brand.in",
      storefrontDomainId: "storefront_domain_1",
      env: providerEnv,
      client: client as any,
      fetchFn: (async () => response(JSON.stringify({ "brand.in": { status: "available" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch
    });
    const event = events[0];
    const serializedPayload = JSON.stringify(event.payload);

    assert.equal(result.status, "AVAILABLE");
    assert.equal(event.storefrontDomainId, "storefront_domain_1");
    assert.equal(event.eventType, "DOMAIN_AVAILABILITY_CHECKED");
    assert.equal(event.status, DomainProvisioningStatus.SUCCEEDED);
    assert.equal(event.payload.httpStatus, 200);
    assert.equal(event.payload.request.params["domain-name"], "brand");
    assert.equal(event.payload.request.params.tlds, "in");
    assert.equal(event.payload.request.params["api-key"], "[redacted]");
    assert.equal(event.payload.request.params["auth-userid"], "[redacted]");
    assert.equal(serializedPayload.includes(providerEnv.RESELLERCLUB_API_KEY), false);
    assert.equal(serializedPayload.includes(providerEnv.RESELLERCLUB_AUTH_USERID), false);
  });
});
