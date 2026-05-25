import type { MerchantDomainLifecycleStatus } from "./domain-status.presenter.js";

export const DOMAIN_AUTOMATION_AUDIT_EVENTS = [
  "DOMAIN_REGISTERED",
  "REGISTRY_HOLD_DETECTED",
  "TXT_VALIDATION_ADDED",
  "TXT_PROPAGATED",
  "CLOUDFLARE_SSL_PENDING",
  "DOMAIN_LIVE",
  "DOMAIN_STATUS_POLLED"
] as const;

export type DomainAutomationAuditEvent = (typeof DOMAIN_AUTOMATION_AUDIT_EVENTS)[number];

export type DomainRetryPlan = {
  phase: "REGISTRY_HOLD" | "TXT_PROPAGATION" | "SSL_ISSUANCE" | "STOREFRONT_CHECK" | "LIVE" | "SUPPORT_REVIEW";
  nextPollAfterMinutes: number | null;
  maxWindowText: string;
  escalationText: string;
};

function sslReady(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["active", "issued", "valid", "verified"].includes(normalized);
}

export function domainStatusRetryPlan(
  status: MerchantDomainLifecycleStatus,
  options: { dnsPropagationStatus?: string | null | undefined; sslStatus?: string | null | undefined } = {}
): DomainRetryPlan {
  if (status === "EKYC_PENDING" || options.dnsPropagationStatus === "REGISTRY_HOLD") {
    return {
      phase: "REGISTRY_HOLD",
      nextPollAfterMinutes: 360,
      maxWindowText: "24 to 48 hours",
      escalationText: "Escalate to support if the registry hold is still visible after 48 hours."
    };
  }

  if (status === "DNS_VALIDATION_PENDING") {
    return {
      phase: "TXT_PROPAGATION",
      nextPollAfterMinutes: 15,
      maxWindowText: "15 minutes to 24 hours",
      escalationText: "Escalate if the expected validation record is still missing after 24 hours."
    };
  }

  if (status === "SSL_ISSUING" || (options.sslStatus && !sslReady(options.sslStatus))) {
    return {
      phase: "SSL_ISSUANCE",
      nextPollAfterMinutes: 15,
      maxWindowText: "15 minutes to 4 hours",
      escalationText: "Escalate if the certificate is still pending after 4 hours with DNS validation visible."
    };
  }

  if (status === "CONNECTED") {
    return {
      phase: "STOREFRONT_CHECK",
      nextPollAfterMinutes: 5,
      maxWindowText: "Usually a few minutes",
      escalationText: "Escalate if HTTPS is ready but storefront rendering does not pass within 30 minutes."
    };
  }

  if (status === "LIVE") {
    return {
      phase: "LIVE",
      nextPollAfterMinutes: null,
      maxWindowText: "Complete",
      escalationText: "No automatic escalation needed."
    };
  }

  if (status === "FAILED_NEEDS_SUPPORT") {
    return {
      phase: "SUPPORT_REVIEW",
      nextPollAfterMinutes: null,
      maxWindowText: "Manual review",
      escalationText: "Support should review provider diagnostics and retry only after the blocker is understood."
    };
  }

  return {
    phase: "STOREFRONT_CHECK",
    nextPollAfterMinutes: 15,
    maxWindowText: "Depends on the current setup step",
    escalationText: "Keep polling read-only until the next lifecycle state is clear."
  };
}

export function selectDomainPollAuditEvent(input: {
  merchantStatus: MerchantDomainLifecycleStatus;
  dnsPropagationStatus?: string | null | undefined;
  txtPresent?: boolean | null | undefined;
  cloudflareChecked?: boolean | null | undefined;
  sslStatus?: string | null | undefined;
  providerStatus?: string | null | undefined;
}): DomainAutomationAuditEvent {
  if (input.merchantStatus === "LIVE") return "DOMAIN_LIVE";
  if (input.dnsPropagationStatus === "REGISTRY_HOLD") return "REGISTRY_HOLD_DETECTED";
  if (input.txtPresent === true) return "TXT_PROPAGATED";
  if (input.cloudflareChecked && !sslReady(input.sslStatus)) return "CLOUDFLARE_SSL_PENDING";
  if (/active|registered/i.test(String(input.providerStatus || ""))) return "DOMAIN_REGISTERED";
  return "DOMAIN_STATUS_POLLED";
}
