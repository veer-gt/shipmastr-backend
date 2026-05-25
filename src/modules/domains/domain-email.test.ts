import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DOMAIN_EMAIL_TEMPLATE_KEYS,
  buildDomainAdminDiagnosticsTemplate,
  buildDomainEmailTemplate,
  buildDomainOrderSubject,
  getDomainEmailSenderConfig
} from "./domain-email.js";

const merchantUnsafeTerms = [
  "ResellerClub",
  "Cloudflare",
  "customHostnameId",
  "contact-id",
  "API",
  "TXT",
  "auth-userid",
  "api-key"
];

const dynamicMerchantName = "Nila Wellness";

describe("domain merchant email communication", () => {
  it("uses Shipmastr noreply sender config for domain emails", () => {
    const sender = getDomainEmailSenderConfig({
      DOMAIN_EMAIL_FROM_NAME: "Shipmastr",
      DOMAIN_EMAIL_FROM_ADDRESS: "noreply@shipmastr.com"
    });

    assert.equal(sender.fromName, "Shipmastr");
    assert.equal(sender.fromAddress, "noreply@shipmastr.com");
    assert.equal(sender.from, "Shipmastr <noreply@shipmastr.com>");
  });

  it("builds the approved singular domain order subject", () => {
    assert.equal(
      buildDomainOrderSubject("shipmastr.co.in", 1, "Registration"),
      "New Domain Order - Registration/Renewal of shipmastr.co.in for 1 year"
    );
  });

  it("builds the approved plural domain order subject", () => {
    assert.equal(
      buildDomainOrderSubject("example.in", 2, "Renewal"),
      "New Domain Order - Registration/Renewal of example.in for 2 years"
    );
  });

  it("keeps merchant/store names dynamic and free of hardcoded sample names", () => {
    const source = readFileSync("src/modules/domains/domain-email.ts", "utf8");
    const template = buildDomainEmailTemplate("DOMAIN_PAYMENT_RECEIVED", {
      domain: "example.in",
      years: 1,
      actionType: "Registration",
      merchantName: dynamicMerchantName
    });

    assert.equal(template.text.includes(dynamicMerchantName), true);
    assert.equal(source.includes(dynamicMerchantName), false);
    assert.equal(source.includes("Celvya Wellness"), false);
  });

  it("keeps all merchant-facing domain templates white-labeled, provider-safe, and action-oriented", () => {
    for (const templateKey of DOMAIN_EMAIL_TEMPLATE_KEYS) {
      const template = buildDomainEmailTemplate(
        templateKey,
        {
          domain: "shipmastr.co.in",
          years: 1,
          actionType: "Registration",
          merchantName: dynamicMerchantName
        },
        {
          DOMAIN_EMAIL_FROM_NAME: "Shipmastr",
          DOMAIN_EMAIL_FROM_ADDRESS: "noreply@shipmastr.com"
        }
      );
      const merchantFacing = [
        template.from,
        template.subject,
        template.text,
        template.html
      ].join("\n");

      assert.equal(template.fromName, "Shipmastr");
      assert.equal(template.fromAddress, "noreply@shipmastr.com");
      assert.equal(template.from, "Shipmastr <noreply@shipmastr.com>");
      assert.equal(template.subject, "New Domain Order - Registration/Renewal of shipmastr.co.in for 1 year");
      assert.equal(template.nextAction.startsWith("Next:"), true);
      assert.equal(template.text.includes(template.nextAction), true);
      assert.match(template.html, /^<p>[\s\S]+<\/p>$/);
      for (const unsafeTerm of merchantUnsafeTerms) {
        assert.equal(
          merchantFacing.includes(unsafeTerm),
          false,
          `${templateKey} exposed merchant-unsafe term ${unsafeTerm}`
        );
      }
    }
  });

  it("uses compliance exception copy for verification states without provider branding", () => {
    for (const templateKey of ["DOMAIN_REGISTRATION_STARTED", "DOMAIN_REGISTERED", "DOMAIN_EKYC_PENDING", "DOMAIN_VERIFICATION_REQUIRED"] as const) {
      const template = buildDomainEmailTemplate(templateKey, {
        domain: "shipmastr.co.in",
        years: 1,
        actionType: "Registration"
      });

      assert.equal(
        template.text.includes("You may receive a verification email from our domain verification partner. Please complete it to activate your domain."),
        true
      );
      assert.equal(template.text.includes("ResellerClub"), false);
      assert.equal(template.text.includes("Cloudflare"), false);
    }
  });

  it("prepares merchant-safe request workflow email templates without sending them", () => {
    const request = buildDomainEmailTemplate("DOMAIN_REQUEST_RECEIVED", {
      domain: "example.in",
      years: 1,
      actionType: "Registration",
      merchantName: dynamicMerchantName
    });
    const started = buildDomainEmailTemplate("DOMAIN_SETUP_STARTED", {
      domain: "example.in",
      years: 1,
      actionType: "Registration",
      merchantName: dynamicMerchantName
    });
    const support = buildDomainEmailTemplate("DOMAIN_SETUP_NEEDS_SUPPORT", {
      domain: "example.in",
      years: 1,
      actionType: "Registration",
      merchantName: dynamicMerchantName
    });

    assert.equal(request.from, "Shipmastr <noreply@shipmastr.com>");
    assert.match(request.text, /We received your domain setup request/);
    assert.match(started.text, /started domain setup/);
    assert.match(support.text, /needs support/);
    for (const template of [request, started, support]) {
      for (const unsafeTerm of merchantUnsafeTerms) {
        assert.equal(template.text.includes(unsafeTerm), false);
      }
    }
  });

  it("allows provider diagnostics only in admin-only templates", () => {
    const adminTemplate = buildDomainAdminDiagnosticsTemplate({
      domain: "shipmastr.co.in",
      providerName: "Cloudflare",
      providerStatus: "pending_validation",
      internalSummary: "Custom Hostname waiting for registry hold clearance."
    });

    assert.equal(adminTemplate.audience, "admin");
    assert.equal(adminTemplate.text.includes("Cloudflare"), true);
    assert.equal(adminTemplate.subject, "Internal domain diagnostics - shipmastr.co.in");

    for (const templateKey of DOMAIN_EMAIL_TEMPLATE_KEYS) {
      const merchantTemplate = buildDomainEmailTemplate(templateKey, {
        domain: "shipmastr.co.in",
        years: 1,
        actionType: "Registration"
      });
      assert.equal(merchantTemplate.text.includes("Cloudflare"), false);
    }
  });

  it("builds previews only and does not send real email in tests", () => {
    const template = buildDomainEmailTemplate("DOMAIN_LIVE", {
      domain: "example.in",
      years: 2,
      actionType: "Registration"
    });

    assert.equal(template.templateKey, "DOMAIN_LIVE");
    assert.equal(typeof template.text, "string");
    assert.equal(typeof template.html, "string");
  });
});
