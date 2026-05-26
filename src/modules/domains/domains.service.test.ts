import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DomainProvider, DomainProvisioningStatus, DomainStatus, MerchantDomainSource } from "@prisma/client";
import { requireInternalSecret } from "../../middleware/internal.js";
import { HttpError } from "../../lib/httpError.js";
import {
  assertLiveDomainRegistrationAllowed,
  assertResellerClubAvailabilityAllowed,
  resolveDomainProviderMode,
  summarizeDomainProviderEnv
} from "./domain-provider-mode.js";
import { normalizeDomain, normalizeMerchantDomainRequestDomain, redactProviderSecrets } from "./domain.utils.js";
import {
  assertResellerClubRegistrationPayloadReady,
  assertResellerClubRegistrationPreflightFromEnv,
  buildResellerClubRegistrationPreflightSummary
} from "./resellerclub-registration-preflight.js";
import {
  connectExistingDomain,
  createDomainPurchaseIntent,
  getAdminDomainDiagnostics,
  getMerchantDomain,
  listAdminDomains,
  recordDomainProvisioningEvent,
  requestMerchantDomainActivation,
  searchMerchantDomain,
  startDomainRegistration
} from "./domains.service.js";
import {
  buildCloudflareHeaders,
  buildCloudflareCustomHostnameBody,
  buildCloudflareCustomHostnameSpec,
  cloudflareCustomHostnameInternalStatus,
  cloudflareDuplicateHostnameSafeMessage
} from "./providers/cloudflare.service.js";
import { buildResellerClubAvailabilityLookup, resellerClubService } from "./providers/resellerclub.service.js";

const merchantUser = {
  id: "user_1",
  merchantId: "merchant_1",
  role: "MERCHANT_OWNER",
  userType: "MERCHANT_ACCOUNT",
  merchant: {
    id: "merchant_1",
    name: "Skymax",
    onboardingStatus: "READY_TO_SHIP"
  }
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      findUnique: async () => merchantUser
    },
    domainProduct: {
      findFirst: async () => null
    },
    merchantDomain: {
      findUnique: async () => null,
      create: async (args: any) => ({
        id: "domain_1",
        merchantId: args.data.merchantId,
        storefrontId: args.data.storefrontId || null,
        domain: args.data.domain,
        normalizedDomain: args.data.normalizedDomain,
        source: args.data.source,
        provider: args.data.provider,
        status: args.data.status,
        isPrimary: false,
        sslStatus: null,
        validationRecords: args.data.validationRecords || null,
        expiresAt: null,
        autoRenew: args.data.autoRenew ?? true,
        lastCheckedAt: null,
        createdAt: new Date("2026-05-18T00:00:00.000Z"),
        updatedAt: new Date("2026-05-18T00:00:00.000Z")
      }),
      update: async (args: any) => ({
        id: args.where.id,
        merchantId: "merchant_1",
        storefrontId: args.data.storefrontId || null,
        domain: "brand.in",
        normalizedDomain: "brand.in",
        source: "EXTERNAL_CONNECTED",
        provider: args.data.provider || "CLOUDFLARE",
        status: args.data.status || "DNS_PENDING",
        isPrimary: false,
        sslStatus: args.data.sslStatus || null,
        validationRecords: args.data.validationRecords || null,
        expiresAt: args.data.expiresAt || null,
        autoRenew: true,
        lastCheckedAt: args.data.lastCheckedAt || null,
        createdAt: new Date("2026-05-18T00:00:00.000Z"),
        updatedAt: new Date("2026-05-18T00:00:00.000Z")
      })
    },
    domainProvisioningEvent: {
      create: async () => ({ id: "event_1" }),
      upsert: async () => ({ id: "event_1" })
    },
    ...overrides
  };
}

describe("Shipmastr Domains white-label module", () => {
  it("normalizes domains and rejects invalid or Shipmastr-owned domains", () => {
    assert.deepEqual(normalizeDomain(" https://www.Brand.IN:443/path "), {
      domain: "brand.in",
      normalizedDomain: "brand.in",
      tld: "in"
    });
    assert.deepEqual(normalizeDomain("BRAND.IN."), {
      domain: "brand.in",
      normalizedDomain: "brand.in",
      tld: "in"
    });

    assert.throws(() => normalizeDomain("not a domain"), /INVALID_DOMAIN/);
    assert.throws(() => normalizeDomain("brand .in"), /INVALID_DOMAIN/);
    assert.throws(() => normalizeDomain("shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeDomain("status.shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeDomain("api.shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeDomain("admin.shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeDomain("seller.shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeDomain("courier.shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeDomain("localhost"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeDomain("127.0.0.1"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeDomain("demo.run.app"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
  });

  it("mounts merchant, admin, and internal provisioning routes with the correct auth guards", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/merchant\/domains", requireJwtAuth, merchantDomainsRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/domains", requireJwtAuth, domainStatusRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/admin\/domains", requireAdminJwt, adminDomainsRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/internal\/provisioning", requireInternalSecret, internalDomainProvisioningRouter\);/);
    const domainRoutes = readFileSync("src/modules/domains/domains.routes.ts", "utf8");
    assert.match(domainRoutes, /merchantDomainsRouter\.post\("\/request"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/approve"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/reject"/);
    assert.match(domainRoutes, /adminDomainsRouter\.post\("\/:domain\/start-provider-setup"/);
  });

  it("uses safe admin queue labels for manual DNS and real provider states", async () => {
    const now = new Date("2026-05-26T04:30:00.000Z");
    const row = (domain: string, overrides: Record<string, unknown> = {}) => ({
      id: `domain_${domain}`,
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain,
      normalizedDomain: domain,
      source: MerchantDomainSource.EXTERNAL_CONNECTED,
      provider: DomainProvider.MANUAL,
      status: DomainStatus.REQUESTED,
      isPrimary: false,
      sslStatus: null,
      validationRecords: {
        requestStatus: "PENDING_REVIEW",
        intent: "CONNECT_EXISTING_DOMAIN"
      },
      expiresAt: null,
      autoRenew: true,
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now,
      merchant: { id: "merchant_1", name: "Skymax", email: "ops@example.test" },
      ...overrides
    });

    const result = await listAdminDomains({
      client: makeClient({
        merchantDomain: {
          findMany: async () => [
            row("request-only.example.in"),
            row("approved.example.in", {
              status: DomainStatus.APPROVAL_REQUIRED,
              validationRecords: {
                requestStatus: "APPROVED",
                activationWorkflow: { state: "ADMIN_APPROVED" }
              }
            }),
            row("manual-instructions.example.in", {
              status: DomainStatus.CLOUDFLARE_PENDING,
              provider: DomainProvider.CLOUDFLARE,
              validationRecords: {
                requestStatus: "PROVIDER_SETUP_STARTED",
                activationWorkflow: { state: "DNS_INSTRUCTIONS_AVAILABLE", providerSetupStarted: true },
                dnsInstructions: {
                  available: true,
                  records: [{ type: "CNAME", name: "manual-instructions.example.in", value: "storefront-origin.shipmastr.com" }]
                }
              }
            }),
            row("manual-pending.example.in", {
              status: DomainStatus.CLOUDFLARE_PENDING,
              provider: DomainProvider.CLOUDFLARE,
              validationRecords: {
                requestStatus: "PROVIDER_SETUP_STARTED",
                activationWorkflow: { state: "PROVIDER_SETUP_STARTED", providerSetupStarted: true }
              }
            }),
            row("cf-pending.example.in", {
              status: DomainStatus.CLOUDFLARE_PENDING,
              provider: DomainProvider.CLOUDFLARE,
              cloudflareCustomHostnameId: "cfh_123",
              validationRecords: { customHostnameId: "cfh_123" }
            }),
            row("dns-pending.example.in", {
              status: DomainStatus.CLOUDFLARE_PENDING,
              provider: DomainProvider.CLOUDFLARE,
              cloudflareCustomHostnameId: "cfh_456",
              dnsValidationStatus: "pending",
              validationRecords: { customHostnameId: "cfh_456", txtName: "_cf-custom-hostname.dns-pending.example.in" }
            }),
            row("active.example.in", {
              status: DomainStatus.ACTIVE,
              provider: DomainProvider.CLOUDFLARE,
              cloudflareCustomHostnameId: "cfh_active",
              sslStatus: "active"
            }),
            row("failed.example.in", {
              status: DomainStatus.FAILED,
              validationRecords: {
                activationWorkflow: { state: "NEEDS_ATTENTION" }
              }
            })
          ]
        }
      }) as any
    });

    const byDomain = Object.fromEntries(result.domains.map((domain: any) => [domain.domain, domain]));
    assert.equal(byDomain["request-only.example.in"].queueLabel, "Review Required");
    assert.equal(byDomain["approved.example.in"].queueLabel, "Approved");
    assert.equal(byDomain["manual-instructions.example.in"].queueLabel, "DNS Instructions Available");
    assert.equal(byDomain["manual-instructions.example.in"].queueHasCloudflareEvidence, false);
    assert.equal(byDomain["manual-pending.example.in"].queueLabel, "DNS Instructions Pending");
    assert.equal(byDomain["manual-pending.example.in"].queueHasCloudflareEvidence, false);
    assert.equal(byDomain["cf-pending.example.in"].queueLabel, "Cloudflare Pending");
    assert.equal(byDomain["cf-pending.example.in"].queueHasCloudflareEvidence, true);
    assert.equal(byDomain["dns-pending.example.in"].queueLabel, "DNS Validation Pending");
    assert.equal(byDomain["active.example.in"].queueLabel, "Active");
    assert.equal(byDomain["failed.example.in"].queueLabel, "Needs Attention");
  });

  it("normalizes merchant request hostnames, blocks apex by default, and rejects platform canaries", () => {
    assert.deepEqual(normalizeMerchantDomainRequestDomain(" https://www.Brand.IN/path "), {
      domain: "www.brand.in",
      normalizedDomain: "www.brand.in",
      tld: "in",
      isApex: false
    });
    assert.deepEqual(normalizeMerchantDomainRequestDomain("shop.brand.co.in"), {
      domain: "shop.brand.co.in",
      normalizedDomain: "shop.brand.co.in",
      tld: "co.in",
      isApex: false
    });

    assert.throws(() => normalizeMerchantDomainRequestDomain("brand.in"), /APEX_DOMAIN_REQUEST_REQUIRES_ADMIN_REVIEW/);
    assert.throws(() => normalizeMerchantDomainRequestDomain("brand.co.in"), /APEX_DOMAIN_REQUEST_REQUIRES_ADMIN_REVIEW/);
    assert.throws(() => normalizeMerchantDomainRequestDomain("cf-write-test.shipmastr.co.in"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizeMerchantDomainRequestDomain("www.shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
  });

  it("checks availability through a backend provider and returns merchant-safe copy", async () => {
    const result = await searchMerchantDomain({
      userId: "user_1",
      merchantId: "merchant_1",
      domain: "brand.in",
      provider: {
        checkAvailability: async (domain) => ({
          domain,
          available: true,
          provider: "RESELLERCLUB",
          providerStatus: "available",
          safeMessage: `${domain} is available`,
          rawProviderPayload: { providerStatus: "available", apiKey: "must-not-return" },
          raw: { providerStatus: "available", apiKey: "must-not-return" }
        })
      },
      client: makeClient() as any
    });

    assert.ok(result);
    assert.equal(result.domain, "brand.in");
    assert.equal(result.available, true);
    assert.equal(result.message, "brand.in is available");
    assert.equal(JSON.stringify(result).includes("must-not-return"), false);
  });

  it("does not expose raw provider errors to merchants", async () => {
    await assert.rejects(
      () => searchMerchantDomain({
        userId: "user_1",
        merchantId: "merchant_1",
        domain: "brand.in",
        provider: {
          checkAvailability: async () => {
            throw new Error("ResellerClub raw api-key abc123");
          }
        },
        client: makeClient() as any
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.message, "DOMAIN_PROVIDER_TEMPORARILY_UNAVAILABLE");
        assert.equal(JSON.stringify(error).includes("abc123"), false);
        return true;
      }
    );
  });

  it("creates a purchase intent without starting provider registration", async () => {
    const events: any[] = [];
    const updates: any[] = [];
    const client = makeClient({
      merchantDomain: {
        findUnique: async () => null,
        create: async (args: any) => ({
          id: "domain_1",
          merchantId: args.data.merchantId,
          storefrontId: args.data.storefrontId || null,
          domain: args.data.domain,
          normalizedDomain: args.data.normalizedDomain,
          source: args.data.source,
          provider: args.data.provider,
          status: args.data.status,
          isPrimary: false,
          sslStatus: null,
          validationRecords: null,
          expiresAt: null,
          autoRenew: true,
          lastCheckedAt: null,
          createdAt: new Date("2026-05-18T00:00:00.000Z"),
          updatedAt: new Date("2026-05-18T00:00:00.000Z")
        }),
        update: async (args: any) => {
          updates.push(args);
          return args.data;
        }
      },
      domainProvisioningEvent: {
        create: async (args: any) => {
          events.push(args.data);
          return { id: "event_1" };
        },
        upsert: async () => ({ id: "event_1" })
      }
    });

    const result = await createDomainPurchaseIntent({
      userId: "user_1",
      merchantId: "merchant_1",
      domain: "brand.in",
      client: client as any
    });

    assert.equal(result.domain.status, DomainStatus.PAYMENT_REQUIRED);
    assert.equal(events[0].eventType, "PURCHASE_INTENT_CREATED");
    assert.equal(events[0].status, DomainProvisioningStatus.PENDING);
    assert.equal(updates.length, 0);
  });

  it("creates a merchant domain setup request without provider mutations", async () => {
    const events: any[] = [];
    const merchantDomainWrites: any[] = [];
    const storefrontDomainWrites: any[] = [];
    const client = makeClient({
      storefront: {
        findFirst: async (args: any) => (
          args.where?.id === "storefront_1" && args.where?.merchantId === "merchant_1"
            ? { id: "storefront_1", merchantId: "merchant_1", name: "Demo Storefront" }
            : null
        )
      },
      storefrontDomain: {
        findUnique: async () => null,
        create: async (args: any) => {
          storefrontDomainWrites.push(args.data);
          return {
            id: "storefront_domain_1",
            status: args.data.status
          };
        }
      },
      merchantDomain: {
        findUnique: async () => null,
        create: async (args: any) => {
          merchantDomainWrites.push(args.data);
          return {
            id: "domain_request_1",
            merchantId: args.data.merchantId,
            storefrontId: args.data.storefrontId || null,
            domain: args.data.domain,
            normalizedDomain: args.data.normalizedDomain,
            source: args.data.source,
            provider: args.data.provider,
            status: args.data.status,
            isPrimary: false,
            sslStatus: null,
            validationRecords: args.data.validationRecords || null,
            expiresAt: null,
            autoRenew: true,
            lastCheckedAt: null,
            createdAt: new Date("2026-05-24T00:00:00.000Z"),
            updatedAt: new Date("2026-05-24T00:00:00.000Z")
          };
        }
      },
      domainProvisioningEvent: {
        create: async (args: any) => {
          events.push(args.data);
          return { id: "event_request_1" };
        },
        upsert: async () => {
          throw new Error("request flow should not need idempotent provider callback upsert");
        }
      }
    });

    const result = await requestMerchantDomainActivation({
      userId: "user_1",
      merchantId: "merchant_1",
      domain: "www.brand.in",
      storefrontId: "storefront_1",
      intent: "CONNECT_EXISTING_DOMAIN",
      note: "Please connect after review",
      client: client as any
    });

    assert.equal(result.domain.status, DomainStatus.REQUESTED);
    assert.equal(result.domain.merchantStatus, "REQUESTED");
    assert.equal(result.domain.statusView.title, "Domain request received");
    assert.equal(result.request.storefrontDomainStatus, DomainStatus.REQUESTED);
    assert.equal(result.message, "Request received. Shipmastr will guide you through connecting this domain.");
    assert.equal(merchantDomainWrites.length, 1);
    assert.equal(merchantDomainWrites[0].provider, DomainProvider.MANUAL);
    assert.equal(merchantDomainWrites[0].status, DomainStatus.REQUESTED);
    assert.equal(storefrontDomainWrites.length, 1);
    assert.equal(storefrontDomainWrites[0].domain, "www.brand.in");
    assert.equal(storefrontDomainWrites[0].status, DomainStatus.REQUESTED);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "DOMAIN_ACTIVATION_REQUESTED");
    assert.equal(events[0].provider, DomainProvider.MANUAL);
    assert.equal(JSON.stringify(result).includes("Cloudflare"), false);
    assert.equal(JSON.stringify(result).includes("ResellerClub"), false);
  });

  it("requires verified payment and onboarding approval before registration can start", async () => {
    const client = makeClient({
      merchantDomain: {
        findFirst: async () => ({
          id: "domain_1",
          merchantId: "merchant_1",
          status: DomainStatus.PAYMENT_REQUIRED,
          normalizedDomain: "brand.in"
        }),
        update: async () => ({ id: "domain_1", status: DomainStatus.REGISTERING })
      },
      domainProvisioningEvent: {
        create: async () => ({ id: "event_1" }),
        upsert: async () => ({ id: "event_1" })
      }
    });

    await assert.rejects(
      () => startDomainRegistration({
        merchantId: "merchant_1",
        merchantDomainId: "domain_1",
        paymentReferenceId: "pay_1",
        paymentVerified: false,
        onboardingApproved: true,
        client: client as any
      }),
      /DOMAIN_PAYMENT_NOT_VERIFIED/
    );

    await assert.rejects(
      () => startDomainRegistration({
        merchantId: "merchant_1",
        merchantDomainId: "domain_1",
        paymentReferenceId: "pay_1",
        paymentVerified: true,
        onboardingApproved: false,
        client: client as any
      }),
      /DOMAIN_ONBOARDING_NOT_APPROVED/
    );

    const result = await startDomainRegistration({
      merchantId: "merchant_1",
      merchantDomainId: "domain_1",
      paymentReferenceId: "pay_1",
      paymentVerified: true,
      onboardingApproved: true,
      client: client as any
    });
    assert.equal(result.status, DomainStatus.REGISTERING);
  });

  it("blocks merchant access to another merchant domain", async () => {
    await assert.rejects(
      () => connectExistingDomain({
        userId: "user_1",
        merchantId: "merchant_1",
        domain: "brand.in",
        client: makeClient({
          merchantDomain: {
            findUnique: async () => ({ id: "domain_2", merchantId: "merchant_2" })
          }
        }) as any
      }),
      /DOMAIN_ALREADY_CONNECTED/
    );
  });

  it("requires the internal provisioning secret header", () => {
    assert.throws(
      () => requireInternalSecret({ header: () => undefined } as any, {} as any, () => undefined),
      /UNAUTHORIZED_INTERNAL_TASK/
    );
  });

  it("records duplicate provisioning callbacks idempotently and rejects wrong merchant scope", async () => {
    let upsertCount = 0;
    const client = makeClient({
      merchantDomain: {
        findUnique: async () => ({
          id: "domain_1",
          merchantId: "merchant_1",
          normalizedDomain: "brand.in",
          provider: DomainProvider.CLOUDFLARE,
          status: DomainStatus.SSL_PENDING,
          cloudflareCustomHostnameId: "cfh_1",
          sslStatus: "pending_validation"
        }),
        update: async (args: any) => ({
          id: "domain_1",
          merchantId: "merchant_1",
          storefrontId: null,
          domain: "brand.in",
          normalizedDomain: "brand.in",
          source: "EXTERNAL_CONNECTED",
          provider: args.data.provider,
          status: args.data.status,
          isPrimary: false,
          sslStatus: null,
          validationRecords: null,
          expiresAt: null,
          autoRenew: true,
          lastCheckedAt: args.data.lastCheckedAt,
          createdAt: new Date("2026-05-18T00:00:00.000Z"),
          updatedAt: new Date("2026-05-18T00:00:00.000Z")
        })
      },
      domainProvisioningEvent: {
        upsert: async () => {
          upsertCount += 1;
          return { id: "event_1" };
        }
      }
    });

    const payload = {
      merchantId: "merchant_1",
      merchantDomainId: "domain_1",
      provider: DomainProvider.CLOUDFLARE,
      eventType: "SSL_ACTIVE",
      status: DomainStatus.ACTIVE,
      cloudflareCustomHostnameId: "cfh_1",
      sslStatus: "active",
      eventStatus: DomainProvisioningStatus.SUCCEEDED,
      idempotencyKey: "domain-event:domain_1:ssl-active"
    };

    await recordDomainProvisioningEvent({ ...payload, client: client as any });
    await recordDomainProvisioningEvent({ ...payload, client: client as any });
    assert.equal(upsertCount, 2);

    await assert.rejects(
      () => recordDomainProvisioningEvent({ ...payload, merchantId: "merchant_2", client: client as any }),
      /MERCHANT_DOMAIN_SCOPE_MISMATCH/
    );
  });

  it("accepts mock writeback evidence, activates the domain, and keeps merchant responses safe", async () => {
    const events: any[] = [];
    const domainRow: any = {
      id: "domain_1",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      domain: "mock-domain.test",
      normalizedDomain: "mock-domain.test",
      source: "PURCHASED_THROUGH_SHIPMASTR",
      provider: DomainProvider.RESELLERCLUB,
      status: DomainStatus.FAILED,
      isPrimary: false,
      resellerClubEntityId: null,
      resellerClubOrderId: null,
      cloudflareCustomHostnameId: null,
      sslStatus: null,
      validationRecords: null,
      expiresAt: null,
      autoRenew: true,
      lastCheckedAt: null,
      createdAt: new Date("2026-05-18T00:00:00.000Z"),
      updatedAt: new Date("2026-05-18T00:00:00.000Z"),
      merchant: {
        id: "merchant_1",
        name: "Skymax",
        email: "merchant@example.test"
      }
    };

    const client = makeClient({
      merchantDomain: {
        findUnique: async (args: any) => {
          if (args.where?.id === domainRow.id || args.where?.normalizedDomain === domainRow.normalizedDomain) {
            return args.include ? { ...domainRow, events: [...events].reverse() } : domainRow;
          }
          return null;
        },
        findFirst: async (args: any) => {
          if (args.where?.id === domainRow.id && args.where?.merchantId === domainRow.merchantId) return domainRow;
          return null;
        },
        update: async (args: any) => {
          Object.assign(domainRow, args.data, { updatedAt: new Date("2026-05-18T00:00:00.000Z") });
          return domainRow;
        }
      },
      domainProvisioningEvent: {
        upsert: async (args: any) => {
          const existing = events.find((event) => event.idempotencyKey === args.create.idempotencyKey);
          if (existing) return existing;
          const event = {
            id: `event_${events.length + 1}`,
            ...args.create,
            createdAt: new Date("2026-05-18T00:00:00.000Z")
          };
          events.push(event);
          return event;
        },
        create: async (args: any) => {
          const event = {
            id: `event_${events.length + 1}`,
            ...args.data,
            createdAt: new Date("2026-05-18T00:00:00.000Z")
          };
          events.push(event);
          return event;
        }
      }
    });

    const base = {
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      merchantDomainId: "domain_1",
      domain: "mock-domain.test",
      client: client as any
    };
    const mockResellerClub = { entityId: "mock-rc-entity-001", orderId: "mock-rc-order-001" };
    const mockCloudflare = {
      customHostnameId: "mock-cf-hostname-001",
      hostnameStatus: "active",
      sslStatus: "active",
      validationMethod: "http",
      verifiedAt: "2026-05-18T00:00:00.000Z"
    };

    await recordDomainProvisioningEvent({
      ...base,
      provider: DomainProvider.RESELLERCLUB,
      eventType: "MOCK_REGISTERING",
      status: DomainStatus.REGISTERING,
      idempotencyKey: "mock-domain:domain_1:REGISTERING"
    });
    await recordDomainProvisioningEvent({
      ...base,
      provider: DomainProvider.RESELLERCLUB,
      eventType: "MOCK_DOMAIN_REGISTERED",
      status: DomainStatus.REGISTERED,
      resellerClubEntityId: mockResellerClub.entityId,
      resellerClubOrderId: mockResellerClub.orderId,
      responsePayload: { mockResellerClub },
      idempotencyKey: "mock-domain:domain_1:REGISTERED"
    });
    await recordDomainProvisioningEvent({
      ...base,
      provider: DomainProvider.CLOUDFLARE,
      eventType: "MOCK_CUSTOM_HOSTNAME_PENDING",
      status: DomainStatus.CLOUDFLARE_PENDING,
      cloudflareCustomHostnameId: mockCloudflare.customHostnameId,
      responsePayload: { mockCloudflare },
      idempotencyKey: "mock-domain:domain_1:CLOUDFLARE_PENDING"
    });
    await recordDomainProvisioningEvent({
      ...base,
      provider: DomainProvider.CLOUDFLARE,
      eventType: "MOCK_SSL_PENDING",
      status: DomainStatus.SSL_PENDING,
      cloudflareCustomHostnameId: mockCloudflare.customHostnameId,
      sslStatus: "pending_validation",
      responsePayload: { mockCloudflare },
      idempotencyKey: "mock-domain:domain_1:SSL_PENDING"
    });
    const active = await recordDomainProvisioningEvent({
      ...base,
      provider: DomainProvider.CLOUDFLARE,
      eventType: "MOCK_SSL_ACTIVE",
      status: DomainStatus.ACTIVE,
      cloudflareCustomHostnameId: mockCloudflare.customHostnameId,
      sslStatus: "active",
      responsePayload: { mockCloudflare },
      idempotencyKey: "mock-domain:domain_1:ACTIVE"
    });

    assert.equal(active.status, DomainStatus.ACTIVE);
    assert.equal(domainRow.status, DomainStatus.ACTIVE);

    await recordDomainProvisioningEvent({
      ...base,
      provider: DomainProvider.CLOUDFLARE,
      eventType: "MOCK_SSL_ACTIVE",
      status: DomainStatus.ACTIVE,
      cloudflareCustomHostnameId: mockCloudflare.customHostnameId,
      sslStatus: "active",
      responsePayload: { mockCloudflare },
      idempotencyKey: "mock-domain:domain_1:ACTIVE"
    });
    assert.equal(events.length, 5);

    await assert.rejects(
      () => recordDomainProvisioningEvent({
        ...base,
        provider: DomainProvider.RESELLERCLUB,
        eventType: "MOCK_DOMAIN_REGISTERED_BACKWARDS",
        status: DomainStatus.REGISTERED,
        idempotencyKey: "mock-domain:domain_1:BACKWARDS"
      }),
      /DOMAIN_STATUS_REGRESSION_BLOCKED/
    );

    const merchantResponse = await getMerchantDomain({
      userId: "user_1",
      merchantId: "merchant_1",
      id: "domain_1",
      client: client as any
    });
    const merchantJson = JSON.stringify(merchantResponse);
    assert.equal(merchantResponse.domain.status, DomainStatus.ACTIVE);
    assert.equal(merchantResponse.domain.merchantStatus, "LIVE");
    assert.equal(merchantResponse.domain.statusView.title, "Domain live");
    assert.equal(merchantJson.includes("mock-cf-hostname-001"), false);
    assert.equal(merchantJson.includes("mock-rc-order-001"), false);
    assert.equal(merchantJson.includes("mockCloudflare"), false);
    assert.equal(merchantJson.includes("validationRecords"), false);
    assert.equal(merchantJson.includes("sslStatus"), false);

    const diagnostics = await getAdminDomainDiagnostics({ domain: "mock-domain.test", client: client as any });
    const diagnosticsJson = JSON.stringify(diagnostics);
    assert.equal(diagnosticsJson.includes("mock-cf-hostname-001"), true);
    assert.equal(diagnosticsJson.includes("mock-rc-order-001"), true);
    assert.equal(diagnostics.diagnostics.cloudflareCustomHostnameId, mockCloudflare.customHostnameId);
    assert.equal(diagnostics.diagnostics.resellerClubOrderId, mockResellerClub.orderId);
    assert.equal(diagnostics.domain.events.length, 5);
  });

  it("blocks provisioning callbacks that move status backwards or mark active before SSL is verified", async () => {
    const baseClient = makeClient({
      merchantDomain: {
        findUnique: async () => ({
          id: "domain_1",
          merchantId: "merchant_1",
          normalizedDomain: "brand.in",
          provider: DomainProvider.CLOUDFLARE,
          status: DomainStatus.ACTIVE,
          cloudflareCustomHostnameId: "cfh_1",
          sslStatus: "active"
        }),
        update: async () => {
          throw new Error("update should not run for invalid transitions");
        }
      },
      domainProvisioningEvent: {
        upsert: async () => ({ id: "event_1" })
      }
    });

    await assert.rejects(
      () => recordDomainProvisioningEvent({
        merchantId: "merchant_1",
        merchantDomainId: "domain_1",
        provider: DomainProvider.RESELLERCLUB,
        eventType: "DOMAIN_REGISTERED",
        status: DomainStatus.REGISTERED,
        client: baseClient as any
      }),
      /DOMAIN_STATUS_REGRESSION_BLOCKED/
    );

    const pendingClient = makeClient({
      merchantDomain: {
        findUnique: async () => ({
          id: "domain_1",
          merchantId: "merchant_1",
          normalizedDomain: "brand.in",
          provider: DomainProvider.RESELLERCLUB,
          status: DomainStatus.REGISTERED,
          cloudflareCustomHostnameId: null,
          sslStatus: null
        }),
        update: async () => {
          throw new Error("update should not run before SSL verification");
        }
      },
      domainProvisioningEvent: {
        upsert: async () => ({ id: "event_1" })
      }
    });

    await assert.rejects(
      () => recordDomainProvisioningEvent({
        merchantId: "merchant_1",
        merchantDomainId: "domain_1",
        provider: DomainProvider.RESELLERCLUB,
        eventType: "DOMAIN_REGISTERED",
        status: DomainStatus.ACTIVE,
        client: pendingClient as any
      }),
      /DOMAIN_ACTIVE_REQUIRES_SSL_VERIFICATION/
    );
  });

  it("redacts provider credentials and handles duplicate custom hostname copy safely", () => {
    const redacted = resellerClubService.redactConfigForLogs({
      apiKey: "secret",
      token: "another-secret",
      domain: "brand.in",
      nested: {
        password: "hidden"
      }
    });

    assert.deepEqual(redacted, {
      apiKey: "[redacted]",
      token: "[redacted]",
      domain: "brand.in",
      nested: {
        password: "[redacted]"
      }
    });
    assert.match(cloudflareDuplicateHostnameSafeMessage(), /already being connected/i);
  });

  it("omits Cloudflare custom_metadata by default and maps missing metadata entitlement safely", () => {
    const baseInput = {
      domain: "brand.in",
      merchantId: "merchant_1",
      storefrontId: "storefront_1",
      merchantDomainId: "domain_1"
    };

    const defaultBody = buildCloudflareCustomHostnameBody(baseInput);
    const metadataBody = buildCloudflareCustomHostnameBody(baseInput, { customMetadataEnabled: true });

    assert.equal(defaultBody.custom_metadata, undefined);
    assert.deepEqual(metadataBody.custom_metadata, {
      merchant_id: "merchant_1",
      storefront_id: "storefront_1",
      merchant_domain_id: "domain_1",
      source: "shipmastr-domains"
    });
    assert.equal(cloudflareCustomHostnameInternalStatus({ code: 1413 }), "CUSTOM_METADATA_NOT_ENABLED");
    assert.equal(cloudflareCustomHostnameInternalStatus({ code: 9999 }), "CLOUDFLARE_CUSTOM_HOSTNAME_ERROR");
  });

  it("builds mutually exclusive Cloudflare auth headers for token and Global Key modes", () => {
    const globalHeaders = buildCloudflareHeaders({
      CLOUDFLARE_AUTH_MODE: "global_key",
      CLOUDFLARE_AUTH_EMAIL: "admin@example.test",
      CLOUDFLARE_GLOBAL_API_KEY: "temporary-global-api-key"
    });
    const tokenHeaders = buildCloudflareHeaders({
      CLOUDFLARE_AUTH_MODE: "api_token",
      CLOUDFLARE_API_TOKEN: "Bearer token-value"
    });

    assert.equal(globalHeaders.Authorization, undefined);
    assert.equal(globalHeaders["X-Auth-Email"], "admin@example.test");
    assert.equal(globalHeaders["X-Auth-Key"], "temporary-global-api-key");
    assert.equal(globalHeaders["Content-Type"], "application/json");
    assert.equal(tokenHeaders.Authorization, "Bearer token-value");
    assert.equal(tokenHeaders["X-Auth-Email"], undefined);
    assert.equal(tokenHeaders["X-Auth-Key"], undefined);
    assert.equal(tokenHeaders["Content-Type"], "application/json");
  });

  it("defaults provider mode to mock and summarizes env presence without values", () => {
    assert.equal(resolveDomainProviderMode(undefined), "mock");
    const envSource = readFileSync("src/config/env.ts", "utf8");

    const summary = summarizeDomainProviderEnv({
      RESELLERCLUB_BASE_URL: "https://sandbox.example.test",
      RESELLERCLUB_AUTH_USERID: "12345",
      RESELLERCLUB_API_KEY: "secret-api-key",
      CLOUDFLARE_API_TOKEN: "secret-token",
      CLOUDFLARE_ZONE_ID: "zone-id",
      SHIPMASTR_INTERNAL_PROVISIONING_SECRET: "internal-secret",
      SHIPMASTR_DOMAIN_PROVIDER_MODE: "sandbox",
      ALLOW_RESELLERCLUB_AVAILABILITY_CHECK: "true",
      RESELLERCLUB_DEBUG_SAFE: "true",
      ALLOW_RESELLERCLUB_BASE_MATRIX: "false",
      ALLOW_LIVE_DOMAIN_REGISTRATION: "false"
    });

    const serialized = JSON.stringify(summary);
    assert.equal(summary.mode, "sandbox");
    assert.equal(summary.availabilityCheck, "unblocked");
    assert.equal(summary.liveRegistration, "blocked");
    assert.equal(serialized.includes("secret-api-key"), false);
    assert.equal(serialized.includes("secret-token"), false);
    assert.ok(summary.required.every((item) => typeof item.present === "boolean"));
    assert.match(envSource, /ALLOW_LIVE_DOMAIN_REGISTRATION:\s*envBoolean\(false\)/);
    assert.match(envSource, /ALLOW_RESELLERCLUB_AVAILABILITY_CHECK:\s*envBoolean\(false\)/);
  });

  it("blocks live registration unless every explicit guard is satisfied", () => {
    const base = {
      mode: "live",
      allowLiveDomainRegistration: true,
      paymentVerified: true,
      onboardingApproved: true,
      merchantDomainId: "domain_1",
      domain: "brand.in",
      auditEventCreated: true
    };

    assert.doesNotThrow(() => assertLiveDomainRegistrationAllowed(base));
    assert.throws(
      () => assertLiveDomainRegistrationAllowed({ ...base, mode: "mock" }),
      /DOMAIN_LIVE_REGISTRATION_DISABLED/
    );
    assert.throws(
      () => assertLiveDomainRegistrationAllowed({ ...base, allowLiveDomainRegistration: false }),
      /DOMAIN_LIVE_REGISTRATION_NOT_ALLOWED/
    );
    assert.throws(
      () => assertLiveDomainRegistrationAllowed({ ...base, paymentVerified: false }),
      /DOMAIN_PAYMENT_NOT_VERIFIED/
    );
    assert.throws(
      () => assertLiveDomainRegistrationAllowed({ ...base, onboardingApproved: false }),
      /DOMAIN_ONBOARDING_NOT_APPROVED/
    );
    assert.throws(
      () => assertLiveDomainRegistrationAllowed({ ...base, merchantDomainId: "" }),
      /DOMAIN_REGISTRATION_RECORD_REQUIRED/
    );
    assert.throws(
      () => assertLiveDomainRegistrationAllowed({ ...base, auditEventCreated: false }),
      /DOMAIN_REGISTRATION_AUDIT_REQUIRED/
    );
    assert.throws(
      () => assertLiveDomainRegistrationAllowed({ ...base, domain: "shipmastr.com" }),
      /DOMAIN_RESERVED_FOR_SHIPMASTR/
    );
  });

  it("allows ResellerClub availability only behind sandbox availability gate", () => {
    const base = {
      mode: "sandbox",
      allowAvailabilityCheck: true,
      baseUrl: "https://sandbox.example.test",
      authUserid: "12345",
      apiKey: "secret",
      operation: "availability"
    };

    assert.doesNotThrow(() => assertResellerClubAvailabilityAllowed(base));
    assert.throws(
      () => assertResellerClubAvailabilityAllowed({ ...base, mode: "mock" }),
      /DOMAIN_AVAILABILITY_PROVIDER_MODE_REQUIRED/
    );
    assert.throws(
      () => assertResellerClubAvailabilityAllowed({ ...base, mode: "live" }),
      /DOMAIN_AVAILABILITY_PROVIDER_MODE_REQUIRED/
    );
    assert.throws(
      () => assertResellerClubAvailabilityAllowed({ ...base, allowAvailabilityCheck: false }),
      /DOMAIN_AVAILABILITY_CHECK_NOT_ALLOWED/
    );
    assert.throws(
      () => assertResellerClubAvailabilityAllowed({ ...base, operation: "registration" }),
      /DOMAIN_PROVIDER_OPERATION_NOT_ALLOWED/
    );
    assert.throws(
      () => assertResellerClubAvailabilityAllowed({ ...base, apiKey: "" }),
      /DOMAIN_PROVIDER_NOT_CONFIGURED/
    );
  });

  it("blocks registration preflight until customer and contact IDs are present", () => {
    assert.throws(
      () => assertResellerClubRegistrationPayloadReady({
        domain: "brand.in",
        customerId: "",
        contactIds: {
          registrant: "",
          admin: "admin_contact",
          tech: "tech_contact",
          billing: "billing_contact"
        },
        nameserverParamsVerified: true
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 409);
        assert.equal(error.message, "RESELLERCLUB_REGISTRATION_IDS_REQUIRED");
        assert.deepEqual((error.details as any).missingIds, ["customer-id", "reg-contact-id"]);
        return true;
      }
    );
  });

  it("requires .in nameserver parameter verification before registration preflight passes", () => {
    assert.throws(
      () => assertResellerClubRegistrationPayloadReady({
        domain: "brand.in",
        customerId: "customer_1",
        contactIds: {
          registrant: "contact_1",
          admin: "contact_1",
          tech: "contact_1",
          billing: "contact_1"
        },
        nameserverParamsVerified: false
      }),
      /RESELLERCLUB_IN_NAMESERVER_PARAMS_NOT_VERIFIED/
    );
  });

  it("keeps registration preflight from running while live registration is unblocked", () => {
    assert.throws(
      () => assertResellerClubRegistrationPreflightFromEnv("brand.in", {
        RESELLERCLUB_CUSTOMER_ID: "customer_1",
        RESELLERCLUB_REG_CONTACT_ID: "contact_1",
        RESELLERCLUB_ADMIN_CONTACT_ID: "contact_1",
        RESELLERCLUB_TECH_CONTACT_ID: "contact_1",
        RESELLERCLUB_BILLING_CONTACT_ID: "contact_1",
        RESELLERCLUB_IN_NAMESERVER_PARAMS_VERIFIED: "true",
        ALLOW_LIVE_DOMAIN_REGISTRATION: "true"
      }),
      /RESELLERCLUB_LIVE_REGISTRATION_MUST_REMAIN_DISABLED/
    );
  });

  it("keeps registration preflight summaries free of provider ID values", () => {
    const summary = buildResellerClubRegistrationPreflightSummary({
      domain: "brand.in",
      customerId: "customer_secret_value",
      contactIds: {
        registrant: "registrant_secret_value",
        admin: "admin_secret_value",
        tech: "tech_secret_value",
        billing: "billing_secret_value"
      },
      nameserverParamsVerified: true,
      allowLiveDomainRegistration: false
    });
    const serialized = JSON.stringify(summary);

    assert.equal(summary.ready, true);
    assert.equal(serialized.includes("customer_secret_value"), false);
    assert.equal(serialized.includes("registrant_secret_value"), false);
    assert.ok(summary.requiredIds.every((item) => item.present));
  });

  it("builds ResellerClub availability params without sending the TLD in domain-name", () => {
    assert.deepEqual(buildResellerClubAvailabilityLookup("Example.in"), {
      normalizedDomain: "example.in",
      domainName: "example",
      tlds: "in"
    });
    assert.deepEqual(buildResellerClubAvailabilityLookup("https://www.example.co.in/path"), {
      normalizedDomain: "example.co.in",
      domainName: "example",
      tlds: "co.in"
    });
    assert.throws(
      () => buildResellerClubAvailabilityLookup("store.example.in"),
      /DOMAIN_SUBDOMAIN_NOT_SUPPORTED/
    );
  });

  it("redacts ResellerClub auth params from diagnostics", () => {
    const redacted = redactProviderSecrets({
      "auth-userid": "12345",
      "api-key": "secret-api-key",
      "domain-name": "brand",
      tlds: "in"
    });

    assert.deepEqual(redacted, {
      "auth-userid": "[redacted]",
      "api-key": "[redacted]",
      "domain-name": "brand",
      tlds: "in"
    });
  });

  it("keeps provider calls in mock mode from reaching external registration or Cloudflare creation", async () => {
    const availability = await resellerClubService.checkAvailability("brand.in");
    assert.equal(availability.available, true);
    assert.equal(availability.providerStatus, "available");
    assert.equal(availability.safeMessage, "brand.in is available");
    assert.deepEqual(availability.raw, {
      providerMode: "mock",
      status: "available"
    });

    await assert.rejects(
      () => resellerClubService.registerDomain({
        domain: "brand.in",
        merchantDomainId: "domain_1",
        paymentVerified: true,
        onboardingApproved: true,
        auditEventCreated: true,
        years: 1,
        customerId: "customer_1",
        contactIds: {
          registrant: "contact_1",
          admin: "contact_1",
          tech: "contact_1",
          billing: "contact_1"
        }
      }),
      /DOMAIN_LIVE_REGISTRATION_DISABLED/
    );

    assert.throws(
      () => buildCloudflareCustomHostnameSpec({
        domain: "brand.in",
        merchantId: "merchant_1",
        merchantDomainId: "domain_1"
      }),
      /DOMAIN_SSL_PROVIDER_MOCK_MODE/
    );
  });

  it("keeps the mock n8n workflow import free of real provider calls and provider secret names", () => {
    const workflow = readFileSync("../docs/n8n/shipmastr-domains-mock-provisioning.workflow.json", "utf8");
    const parsed = JSON.parse(workflow);

    assert.equal(parsed.name, "Shipmastr Domains — Mock Provisioning");
    assert.equal(workflow.includes("httpapi.com"), false);
    assert.equal(workflow.includes("api.cloudflare.com"), false);
    assert.equal(workflow.includes("RESELLERCLUB_API_KEY"), false);
    assert.equal(workflow.includes("RESELLERCLUB_AUTH_USERID"), false);
    assert.equal(workflow.includes("CLOUDFLARE_API_TOKEN"), false);
    assert.equal(workflow.includes("CLOUDFLARE_ZONE_ID"), false);
    assert.equal(workflow.includes("SHIPMASTR_INTERNAL_PROVISIONING_SECRET"), true);
    assert.equal(workflow.includes("SHIPMASTR_API_BASE_URL"), true);
    assert.ok(parsed.nodes.some((node: any) => node.name === "Require Mock Mode"));
    assert.ok(parsed.nodes.every((node: any) => !node.id));
  });

  it("keeps availability-only scripts guarded and registration-free", () => {
    const availabilityScript = readFileSync("scripts/domains-resellerclub-availability-smoke.mjs", "utf8");
    const outboundScript = readFileSync("scripts/domains-outbound-ip-check.mjs", "utf8");
    const preflightScript = readFileSync("scripts/domains-resellerclub-registration-preflight.mjs", "utf8");
    const customerLookupScript = readFileSync("scripts/domains-resellerclub-customer-lookup.mjs", "utf8");
    const contactLookupScript = readFileSync("scripts/domains-resellerclub-contact-lookup.mjs", "utf8");

    assert.match(availabilityScript, /ALLOW_LIVE_DOMAIN_REGISTRATION/);
    assert.match(availabilityScript, /Availability-only: no registration attempted/);
    assert.equal(availabilityScript.includes("register.json"), false);
    assert.equal(availabilityScript.includes("api.cloudflare.com"), false);
    assert.equal(availabilityScript.includes("console.log(process.env"), false);
    assert.match(outboundScript, /EXPECTED_PROVIDER_OUTBOUND_IP/);
    assert.equal(outboundScript.includes("RESELLERCLUB_API_KEY"), false);
    assert.match(preflightScript, /Preflight only: no registration attempted/);
    assert.equal(preflightScript.includes("register.json"), false);
    assert.match(customerLookupScript, /ALLOW_RESELLERCLUB_READ_ONLY_DISCOVERY/);
    assert.match(contactLookupScript, /ALLOW_RESELLERCLUB_READ_ONLY_DISCOVERY/);
    assert.match(customerLookupScript, /confirm-print-operational-ids/);
    assert.match(contactLookupScript, /confirm-print-operational-ids/);
    assert.equal(customerLookupScript.includes("register.json"), false);
    assert.equal(contactLookupScript.includes("register.json"), false);
  });
});
