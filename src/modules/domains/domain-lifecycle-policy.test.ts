import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DOMAIN_AUTOMATION_AUDIT_EVENTS,
  domainStatusRetryPlan,
  selectDomainPollAuditEvent
} from "./domain-lifecycle-policy.js";

describe("domain lifecycle policy", () => {
  it("defines the approved internal domain automation audit events", () => {
    assert.deepEqual(DOMAIN_AUTOMATION_AUDIT_EVENTS, [
      "DOMAIN_REGISTERED",
      "REGISTRY_HOLD_DETECTED",
      "TXT_VALIDATION_ADDED",
      "TXT_PROPAGATED",
      "CLOUDFLARE_SSL_PENDING",
      "DOMAIN_LIVE",
      "DOMAIN_STATUS_POLLED"
    ]);
  });

  it("returns conservative retry windows for registry hold, DNS, SSL, storefront, and live states", () => {
    assert.deepEqual(domainStatusRetryPlan("EKYC_PENDING", { dnsPropagationStatus: "REGISTRY_HOLD" }), {
      phase: "REGISTRY_HOLD",
      nextPollAfterMinutes: 360,
      maxWindowText: "24 to 48 hours",
      escalationText: "Escalate to support if the registry hold is still visible after 48 hours."
    });
    assert.equal(domainStatusRetryPlan("DNS_VALIDATION_PENDING").phase, "TXT_PROPAGATION");
    assert.equal(domainStatusRetryPlan("SSL_ISSUING").phase, "SSL_ISSUANCE");
    assert.equal(domainStatusRetryPlan("CONNECTED").nextPollAfterMinutes, 5);
    assert.equal(domainStatusRetryPlan("LIVE").nextPollAfterMinutes, null);
  });

  it("selects safe poll audit events without implying provider mutations", () => {
    assert.equal(selectDomainPollAuditEvent({
      merchantStatus: "EKYC_PENDING",
      dnsPropagationStatus: "REGISTRY_HOLD"
    }), "REGISTRY_HOLD_DETECTED");
    assert.equal(selectDomainPollAuditEvent({
      merchantStatus: "DNS_VALIDATION_PENDING",
      txtPresent: true
    }), "TXT_PROPAGATED");
    assert.equal(selectDomainPollAuditEvent({
      merchantStatus: "SSL_ISSUING",
      cloudflareChecked: true,
      sslStatus: "pending_validation"
    }), "CLOUDFLARE_SSL_PENDING");
    assert.equal(selectDomainPollAuditEvent({
      merchantStatus: "LIVE"
    }), "DOMAIN_LIVE");
  });
});
