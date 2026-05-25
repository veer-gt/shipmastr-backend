import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainProvider, DomainStatus } from "@prisma/client";
import {
  deriveMerchantStatusFromPoll,
  getMerchantDomainPollingStatus,
  normalizePollingDomain,
  pollAndPersistAdminDomainStatus,
  runDomainStatusPoll
} from "./domain-status-polling.service.js";
import type {
  DomainPollingCloudflareState,
  DomainPollingNameserverState,
  DomainPollingProviderState,
  DomainPollingStorefrontState,
  DomainPollingTxtState,
  DomainStatusPollingAdapters
} from "./domain-status-polling.types.js";

const baseProvider: DomainPollingProviderState = {
  checked: true,
  status: "Active",
  raaEmailVerified: true,
  domainVerificationComplete: true,
  ekycVerified: true,
  nameservers: ["dns3.parkpage.foundationapi.com", "dns4.parkpage.foundationapi.com"]
};

const baseNameservers: DomainPollingNameserverState = {
  authoritative: ["dns3.parkpage.foundationapi.com", "dns4.parkpage.foundationapi.com"],
  publicResolverOne: ["dns3.parkpage.foundationapi.com", "dns4.parkpage.foundationapi.com"],
  publicResolverGoogle: ["dns3.parkpage.foundationapi.com", "dns4.parkpage.foundationapi.com"],
  soa: "dns3.parkpage.foundationapi.com admin.foundationapi.com",
  registryHoldDetected: false
};

const baseTxt: DomainPollingTxtState = {
  expectedName: "_cf-custom-hostname.shipmastr.co.in",
  expectedValue: "public-validation-value",
  present: true,
  checked: true
};

const baseCloudflare: DomainPollingCloudflareState = {
  checked: true,
  customHostnameId: "3ea696-cloudflare-d58f",
  status: "active",
  sslStatus: "active",
  validationMethod: "http",
  validationRecordPresence: true
};

const baseStorefront: DomainPollingStorefrontState = {
  checked: true,
  reachable: true,
  status: 200,
  googleFrontend404: false,
  hostingerDetected: false,
  apiDetected: false,
  expectedRendererResponse: true
};

function adapters(overrides: {
  provider?: DomainPollingProviderState;
  nameservers?: DomainPollingNameserverState;
  txt?: DomainPollingTxtState;
  cloudflare?: DomainPollingCloudflareState;
  storefront?: DomainPollingStorefrontState;
} = {}): DomainStatusPollingAdapters {
  return {
    provider: {
      getDomainStatus: async () => overrides.provider || baseProvider
    },
    dns: {
      getNameserverState: async () => overrides.nameservers || baseNameservers,
      checkTxtRecord: async () => overrides.txt || baseTxt
    },
    cloudflare: {
      getCustomHostnameStatus: async () => overrides.cloudflare || baseCloudflare
    },
    storefront: {
      checkStorefront: async () => overrides.storefront || baseStorefront
    }
  };
}

describe("domain status polling", () => {
  it("normalizes polling domains while keeping core platform domains reserved", () => {
    assert.equal(normalizePollingDomain("https://www.shipmastr.co.in/path"), "shipmastr.co.in");
    assert.throws(() => normalizePollingDomain("shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizePollingDomain("api.shipmastr.com"), /DOMAIN_RESERVED_FOR_SHIPMASTR/);
    assert.throws(() => normalizePollingDomain("bad domain"), /INVALID_DOMAIN/);
  });

  it("maps registry hold to eKYC pending merchant status", async () => {
    const result = await runDomainStatusPoll({
      domain: "shipmastr.co.in",
      validationRecords: {
        txtName: "_cf-custom-hostname.shipmastr.co.in",
        txtValue: "public-validation-value"
      }
    }, adapters({
      nameservers: {
        ...baseNameservers,
        authoritative: ["ns1.verification-hold.suspended-domain.com"],
        soa: "ns1.verification-hold.suspended-domain.com admin.suspended-domain.com",
        registryHoldDetected: true
      }
    }));

    assert.equal(result.merchantStatus, "EKYC_PENDING");
    assert.equal(result.dns.propagationStatus, "REGISTRY_HOLD");
    assert.equal(result.adminDiagnostics.suggestedAuditEvent, "REGISTRY_HOLD_DETECTED");
    assert.equal(result.adminDiagnostics.retryPlan.phase, "REGISTRY_HOLD");
    assert.equal(result.adminDiagnostics.retryPlan.nextPollAfterMinutes, 360);
    assert.equal(JSON.stringify(result.statusView).includes("Cloudflare"), false);
    assert.equal(JSON.stringify(result.statusView).includes("ResellerClub"), false);
  });

  it("maps missing TXT validation to DNS validation pending", () => {
    const status = deriveMerchantStatusFromPoll({
      provider: baseProvider,
      nameservers: baseNameservers,
      txt: { ...baseTxt, present: false },
      cloudflare: { ...baseCloudflare, status: "pending", sslStatus: "initializing" },
      storefront: { ...baseStorefront, checked: false, reachable: null, expectedRendererResponse: false }
    });
    assert.equal(status, "DNS_VALIDATION_PENDING");
  });

  it("keeps requested review-only domains out of DNS validation after an admin poll", async () => {
    const calls: string[] = [];
    const client = {
      merchantDomain: {
        findUnique: async () => ({
          id: "domain_requested",
          merchantId: "merchant_1",
          storefrontId: "storefront_1",
          domain: "merchant-smoke-test.example.in",
          normalizedDomain: "merchant-smoke-test.example.in",
          provider: DomainProvider.MANUAL,
          status: DomainStatus.REQUESTED,
          resellerClubOrderId: null,
          cloudflareCustomHostnameId: null,
          sslStatus: null,
          validationRecords: {
            requestStatus: "PENDING_REVIEW",
            intent: "CONNECT_EXISTING_DOMAIN"
          }
        }),
        update: async (args: any) => {
          calls.push("merchantDomain.update");
          assert.equal(args.data.status, DomainStatus.REQUESTED);
          assert.equal(args.data.validationRecords.polling.merchantStatus, "REVIEW_REQUIRED");
          assert.notEqual(args.data.validationRecords.polling.merchantStatus, "DNS_VALIDATION_PENDING");
          return { id: "domain_requested" };
        }
      },
      domainProvisioningEvent: {
        create: async (args: any) => {
          calls.push("domainProvisioningEvent.create");
          assert.equal(args.data.requestPayload.readOnly, true);
          assert.equal(args.data.responsePayload.txtChecked, false);
          return { id: "event_1" };
        }
      }
    };

    const result = await pollAndPersistAdminDomainStatus({
      domain: "merchant-smoke-test.example.in",
      client: client as any,
      adapters: adapters({
        txt: { expectedName: null, expectedValue: null, present: null, checked: false },
        cloudflare: { checked: false, customHostnameId: null, status: null, sslStatus: null, validationMethod: null, validationRecordPresence: null },
        storefront: { ...baseStorefront, checked: false, reachable: null, expectedRendererResponse: false }
      })
    });

    assert.deepEqual(calls, ["domainProvisioningEvent.create", "merchantDomain.update"]);
    assert.equal(result.statusView.status, "REVIEW_REQUIRED");
    assert.equal(result.statusView.title, "Review required");
    assert.equal(result.statusView.nextActionLabel, "Admin review");
  });

  it("repairs prematurely advanced review-only domains back to requested", async () => {
    const client = {
      merchantDomain: {
        findUnique: async () => ({
          id: "domain_premature",
          merchantId: "merchant_1",
          storefrontId: "storefront_1",
          domain: "merchant-smoke-test.example.in",
          normalizedDomain: "merchant-smoke-test.example.in",
          provider: DomainProvider.MANUAL,
          status: DomainStatus.CLOUDFLARE_PENDING,
          resellerClubOrderId: null,
          cloudflareCustomHostnameId: null,
          sslStatus: null,
          validationRecords: {
            requestStatus: "PENDING_REVIEW",
            intent: "CONNECT_EXISTING_DOMAIN",
            polling: {
              merchantStatus: "DNS_VALIDATION_PENDING"
            }
          }
        }),
        update: async (args: any) => {
          assert.equal(args.data.status, DomainStatus.REQUESTED);
          assert.equal(args.data.validationRecords.polling.merchantStatus, "REVIEW_REQUIRED");
          return { id: "domain_premature" };
        }
      },
      domainProvisioningEvent: {
        create: async () => ({ id: "event_1" })
      }
    };

    const result = await pollAndPersistAdminDomainStatus({
      domain: "merchant-smoke-test.example.in",
      client: client as any,
      adapters: adapters({
        txt: { expectedName: null, expectedValue: null, present: null, checked: false },
        cloudflare: { checked: false, customHostnameId: null, status: null, sslStatus: null, validationMethod: null, validationRecordPresence: null },
        storefront: { ...baseStorefront, checked: false, reachable: null, expectedRendererResponse: false }
      })
    });

    assert.equal(result.statusView.status, "REVIEW_REQUIRED");
    assert.equal(result.diagnostics.dnsValidationStatus, "NOT_CHECKED");
  });

  it("allows provider-started domains with Custom Hostname IDs to show DNS validation pending", async () => {
    const client = {
      merchantDomain: {
        findUnique: async () => ({
          id: "domain_started",
          merchantId: "merchant_1",
          storefrontId: "storefront_1",
          domain: "cf-started.example.in",
          normalizedDomain: "cf-started.example.in",
          provider: DomainProvider.CLOUDFLARE,
          status: DomainStatus.REQUESTED,
          resellerClubOrderId: null,
          cloudflareCustomHostnameId: "cf_custom_hostname_1",
          sslStatus: "pending_validation",
          validationRecords: {
            requestStatus: "PENDING_REVIEW",
            txtName: "_cf-custom-hostname.cf-started.example.in",
            txtValue: "public-validation-value"
          }
        }),
        update: async (args: any) => {
          assert.equal(args.data.status, DomainStatus.CLOUDFLARE_PENDING);
          assert.equal(args.data.validationRecords.polling.merchantStatus, "DNS_VALIDATION_PENDING");
          return { id: "domain_started" };
        }
      },
      domainProvisioningEvent: {
        create: async () => ({ id: "event_1" })
      }
    };

    const result = await pollAndPersistAdminDomainStatus({
      domain: "cf-started.example.in",
      client: client as any,
      adapters: adapters({
        txt: {
          expectedName: "_cf-custom-hostname.cf-started.example.in",
          expectedValue: "public-validation-value",
          present: false,
          checked: true
        },
        cloudflare: {
          checked: true,
          customHostnameId: "cf_custom_hostname_1",
          status: "pending",
          sslStatus: "pending_validation",
          validationMethod: "txt",
          validationRecordPresence: true
        },
        storefront: { ...baseStorefront, checked: false, reachable: null, expectedRendererResponse: false }
      })
    });

    assert.equal(result.statusView.status, "DNS_VALIDATION_PENDING");
  });

  it("maps pending SSL to SSL issuing", () => {
    const status = deriveMerchantStatusFromPoll({
      provider: baseProvider,
      nameservers: baseNameservers,
      txt: baseTxt,
      cloudflare: { ...baseCloudflare, status: "pending", sslStatus: "initializing" },
      storefront: { ...baseStorefront, checked: false, reachable: null, expectedRendererResponse: false }
    });
    assert.equal(status, "SSL_ISSUING");
  });

  it("maps live only when Cloudflare, SSL, and storefront are ready", async () => {
    const result = await runDomainStatusPoll({ domain: "shipmastr.co.in" }, adapters());
    assert.equal(result.merchantStatus, "LIVE");

    const notLive = await runDomainStatusPoll({ domain: "shipmastr.co.in" }, adapters({
      storefront: { ...baseStorefront, expectedRendererResponse: false }
    }));
    assert.notEqual(notLive.merchantStatus, "LIVE");
  });

  it("keeps the production canary-style hostnames live when checks are healthy", async () => {
    const cfWriteTest = await runDomainStatusPoll({ domain: "cf-write-test.shipmastr.co.in" }, adapters());
    const www = await runDomainStatusPoll({ domain: "www.shipmastr.co.in" }, adapters());

    assert.equal(cfWriteTest.merchantStatus, "LIVE");
    assert.equal(www.merchantStatus, "LIVE");
  });

  it("keeps merchant status route response provider-safe and ID-free", async () => {
    const client = {
      merchantDomain: {
        findFirst: async () => ({
          id: "domain_1",
          merchantId: "merchant_1",
          domain: "shipmastr.co.in",
          normalizedDomain: "shipmastr.co.in",
          status: DomainStatus.CLOUDFLARE_PENDING,
          lastCheckedAt: new Date("2026-05-22T00:00:00.000Z"),
          updatedAt: new Date("2026-05-22T00:00:00.000Z"),
          validationRecords: {
            polling: {
              merchantStatus: "DNS_VALIDATION_PENDING",
              cloudflareStatus: "pending",
              sslStatus: "initializing",
              customHostnameId: "3ea696-cloudflare-d58f",
              txtValue: "public-validation-value"
            }
          }
        })
      }
    };

    const result = await getMerchantDomainPollingStatus({
      userId: "user_1",
      merchantId: "merchant_1",
      domain: "shipmastr.co.in",
      client: client as any
    });
    const json = JSON.stringify(result);
    assert.equal(result.statusView.status, "DNS_VALIDATION_PENDING");
    assert.equal(json.includes("Cloudflare"), false);
    assert.equal(json.includes("customHostnameId"), false);
    assert.equal(json.includes("public-validation-value"), false);
  });

  it("admin check-now persists only poll audit/status and includes diagnostics separately", async () => {
    const calls: string[] = [];
    const client = {
      merchantDomain: {
        findUnique: async () => ({
          id: "domain_1",
          merchantId: "merchant_1",
          storefrontId: "storefront_1",
          domain: "shipmastr.co.in",
          normalizedDomain: "shipmastr.co.in",
          provider: DomainProvider.CLOUDFLARE,
          status: DomainStatus.CLOUDFLARE_PENDING,
          resellerClubOrderId: "125620061",
          cloudflareCustomHostnameId: "3ea696-cloudflare-d58f",
          sslStatus: "initializing",
          validationRecords: {
            txtName: "_cf-custom-hostname.shipmastr.co.in",
            txtValue: "public-validation-value"
          }
        }),
        update: async (args: any) => {
          calls.push("merchantDomain.update");
          assert.equal(args.data.status, DomainStatus.ACTIVE);
          assert.equal(args.data.validationRecords.polling.merchantStatus, "LIVE");
          return { id: "domain_1" };
        }
      },
      domainProvisioningEvent: {
        create: async (args: any) => {
          calls.push("domainProvisioningEvent.create");
          assert.equal(args.data.eventType, "DOMAIN_LIVE");
          assert.equal(args.data.requestPayload.readOnly, true);
          assert.equal(args.data.responsePayload.nextPollAfterMinutes, null);
          return { id: "event_1" };
        }
      }
    };

    const result = await pollAndPersistAdminDomainStatus({
      domain: "shipmastr.co.in",
      client: client as any,
      adapters: adapters()
    });

    assert.deepEqual(calls, ["domainProvisioningEvent.create", "merchantDomain.update"]);
    assert.equal(result.statusView.status, "LIVE");
    assert.equal(result.diagnostics.suggestedAuditEvent, "DOMAIN_LIVE");
    assert.equal(result.diagnostics.retryPlan.phase, "LIVE");
    assert.equal(result.diagnostics.cloudflareCustomHostnameId, "3ea696-cloudflare-d58f");
  });

  it("does not call mutation hooks while running the pure polling check", async () => {
    let mutations = 0;
    const result = await runDomainStatusPoll({ domain: "shipmastr.co.in" }, {
      ...adapters(),
      provider: {
        getDomainStatus: async () => {
          mutations += 0;
          return baseProvider;
        }
      }
    });
    assert.equal(result.merchantStatus, "LIVE");
    assert.equal(mutations, 0);
  });
});
