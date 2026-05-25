import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainProvider, DomainStatus, MerchantDomainSource } from "@prisma/client";
import {
  MERCHANT_DOMAIN_LIFECYCLE_STATUSES,
  buildAdminDomainDiagnosticsView,
  buildMerchantDomainStatusView,
  mapMerchantDomainLifecycleStatus
} from "./domain-status.presenter.js";

const MERCHANT_FORBIDDEN_TERMS = [
  "ResellerClub",
  "Cloudflare",
  "customHostnameId",
  "contact-id",
  "contactIds",
  "api-key",
  "auth-userid",
  "TXT",
  "_cf-custom-hostname",
  "provider payload",
  "order ID",
  "contact ID"
];

describe("domain status presenter", () => {
  it("maps internal domain states to merchant-safe lifecycle states", () => {
    assert.equal(mapMerchantDomainLifecycleStatus({ domain: "brand.in", status: DomainStatus.PAYMENT_REQUIRED }), "PAYMENT_PENDING");
    assert.equal(mapMerchantDomainLifecycleStatus({ domain: "brand.in", status: DomainStatus.APPROVAL_REQUIRED }), "PAYMENT_RECEIVED");
    assert.equal(mapMerchantDomainLifecycleStatus({ domain: "brand.in", status: DomainStatus.REGISTERING }), "REGISTRATION_STARTED");
    assert.equal(mapMerchantDomainLifecycleStatus({ domain: "brand.in", status: DomainStatus.CLOUDFLARE_PENDING }), "DNS_VALIDATION_PENDING");
    assert.equal(mapMerchantDomainLifecycleStatus({ domain: "brand.in", status: DomainStatus.SSL_PENDING }), "SSL_ISSUING");
    assert.equal(mapMerchantDomainLifecycleStatus({ domain: "brand.in", status: DomainStatus.ACTIVE }), "LIVE");
    assert.equal(mapMerchantDomainLifecycleStatus({ domain: "brand.in", status: DomainStatus.FAILED }), "FAILED_NEEDS_SUPPORT");
  });

  it("maps first-merchant workflow states without implying DNS setup too early", () => {
    assert.equal(mapMerchantDomainLifecycleStatus({
      domain: "brand.in",
      status: DomainStatus.APPROVAL_REQUIRED,
      validationRecords: {
        requestStatus: "APPROVED",
        activationWorkflow: { state: "ADMIN_APPROVED" }
      }
    }), "ADMIN_APPROVED");

    assert.equal(mapMerchantDomainLifecycleStatus({
      domain: "brand.in",
      status: DomainStatus.CLOUDFLARE_PENDING,
      validationRecords: {
        requestStatus: "PROVIDER_SETUP_STARTED",
        activationWorkflow: { state: "PROVIDER_SETUP_STARTED", providerSetupStarted: true }
      }
    }), "PROVIDER_SETUP_STARTED");

    const withInstructions = buildMerchantDomainStatusView({
      domain: "brand.in",
      status: DomainStatus.CLOUDFLARE_PENDING,
      validationRecords: {
        requestStatus: "PROVIDER_SETUP_STARTED",
        activationWorkflow: { state: "DNS_INSTRUCTIONS_AVAILABLE", providerSetupStarted: true },
        dnsInstructions: {
          available: true,
          summary: "Add the connection record shown by Shipmastr.",
          records: [{ type: "CNAME", name: "www", value: "storefront-origin.shipmastr.com", ttl: "default" }]
        }
      }
    });

    assert.equal(withInstructions.status, "DNS_INSTRUCTIONS_AVAILABLE");
    assert.equal(withInstructions.dnsInstructions?.available, true);
    assert.equal(withInstructions.dnsInstructions?.records?.[0]?.type, "CNAME");
  });

  it("has friendly copy and next action for every merchant lifecycle status", () => {
    for (const status of MERCHANT_DOMAIN_LIFECYCLE_STATUSES) {
      const view = buildMerchantDomainStatusView({ domain: "brand.in", status });
      assert.equal(view.domain, "brand.in");
      assert.equal(view.status, status);
      assert.ok(view.title.length > 3);
      assert.ok(view.message.length > 8);
      assert.ok(view.nextActionLabel.length > 3);
      assert.ok(view.nextActionDescription.length > 8);
      assert.ok(view.estimatedTimeText.length > 3);
      assert.ok(view.progressSteps.length >= 1);
    }
  });

  it("keeps merchant DTO free of provider names, raw IDs, API terms, and TXT values", () => {
    const view = buildMerchantDomainStatusView({
      domain: "shipmastr.co.in",
      status: DomainStatus.CLOUDFLARE_PENDING,
      validationRecords: {
        customHostnameId: "cfh_secretish",
        contactIds: { registrant: "134129993" },
        txtName: "_cf-custom-hostname.shipmastr.co.in",
        txtValue: "public-validation-value",
        providerPayload: "ResellerClub and Cloudflare should stay admin-only",
        "auth-userid": "33502710",
        "api-key": "never"
      },
      sslStatus: "initializing"
    });

    const json = JSON.stringify(view);
    for (const term of MERCHANT_FORBIDDEN_TERMS) {
      assert.equal(json.includes(term), false, `${term} leaked into merchant status view`);
    }
  });

  it("uses verification and eKYC language without provider branding", () => {
    const verification = buildMerchantDomainStatusView({
      domain: "brand.in",
      status: DomainStatus.REGISTERED,
      validationRecords: { registrantVerification: "required" }
    });
    const ekyc = buildMerchantDomainStatusView({
      domain: "brand.in",
      status: DomainStatus.REGISTERED,
      validationRecords: { eKycStatus: "pending" }
    });

    assert.equal(verification.status, "VERIFICATION_REQUIRED");
    assert.match(verification.nextActionDescription, /domain verification partner/i);
    assert.equal(JSON.stringify(verification).includes("ResellerClub"), false);
    assert.equal(ekyc.status, "EKYC_PENDING");
    assert.match(ekyc.message, /registry verification/i);
    assert.match(ekyc.estimatedTimeText, /24 to 48 hours/i);
  });

  it("failed merchant state directs to support", () => {
    const view = buildMerchantDomainStatusView({ domain: "brand.in", status: DomainStatus.FAILED });
    assert.equal(view.status, "FAILED_NEEDS_SUPPORT");
    assert.equal(view.nextActionLabel, "Contact support");
    assert.equal(view.canRetry, true);
  });

  it("keeps admin diagnostics separate and includes provider-level details only for admin use", () => {
    const diagnostics = buildAdminDomainDiagnosticsView({
      domain: "shipmastr.co.in",
      status: DomainStatus.ACTIVE,
      provider: DomainProvider.CLOUDFLARE,
      source: MerchantDomainSource.PURCHASED_THROUGH_SHIPMASTR,
      resellerClubOrderId: "125620061",
      resellerClubEntityId: "entity_1",
      cloudflareCustomHostnameId: "3ea696-cloudflare-d58f",
      sslStatus: "active",
      validationRecords: {
        customerId: "33502710",
        contactIds: {
          registrant: "134129993",
          admin: "134129993",
          tech: "134129993",
          billing: "134129993"
        },
        dnsValidationStatus: "pending"
      },
      events: [
        {
          eventType: "CUSTOM_HOSTNAME_CREATED",
          status: "SUCCEEDED",
          provider: DomainProvider.CLOUDFLARE,
          providerReferenceId: "3ea696-cloudflare-d58f",
          createdAt: new Date("2026-05-22T00:00:00.000Z")
        }
      ]
    });

    assert.equal(diagnostics.resellerClubOrderId, "125620061");
    assert.equal(diagnostics.customerId, "33502710");
    assert.equal(diagnostics.contactIds.registrant, "134129993");
    assert.equal(diagnostics.cloudflareCustomHostnameId, "3ea696-cloudflare-d58f");
    assert.equal(diagnostics.providerDiagnostics.provider, DomainProvider.CLOUDFLARE);
    assert.equal(diagnostics.merchantStatus.status, "LIVE");
  });
});
