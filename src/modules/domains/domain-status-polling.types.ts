import { Prisma } from "@prisma/client";
import type { MerchantDomainLifecycleStatus, MerchantDomainStatusView } from "./domain-status.presenter.js";
import type { DomainAutomationAuditEvent, DomainRetryPlan } from "./domain-lifecycle-policy.js";

export type DomainPollingNameserverState = {
  authoritative: string[];
  publicResolverOne?: string[];
  publicResolverGoogle?: string[];
  soa?: string | null;
  registryHoldDetected: boolean;
};

export type DomainPollingTxtState = {
  expectedName?: string | null;
  expectedValue?: string | null;
  present: boolean | null;
  checked: boolean;
};

export type DomainPollingProviderState = {
  checked: boolean;
  status?: string | null;
  raaEmailVerified?: boolean | null;
  domainVerificationComplete?: boolean | null;
  ekycVerified?: boolean | null;
  nameservers?: string[];
};

export type DomainPollingCloudflareState = {
  checked: boolean;
  customHostnameId?: string | null;
  status?: string | null;
  sslStatus?: string | null;
  validationMethod?: string | null;
  validationRecordPresence?: boolean | null;
};

export type DomainPollingStorefrontState = {
  checked: boolean;
  reachable: boolean | null;
  status?: number | null;
  googleFrontend404: boolean;
  hostingerDetected: boolean;
  apiDetected: boolean;
  expectedRendererResponse: boolean;
};

export type DomainStatusPollResult = {
  domain: string;
  merchantStatus: MerchantDomainLifecycleStatus;
  statusView: MerchantDomainStatusView;
  provider: DomainPollingProviderState;
  dns: {
    nameservers: DomainPollingNameserverState;
    txt: DomainPollingTxtState;
    propagationStatus: "NOT_CHECKED" | "PENDING" | "PROPAGATED" | "REGISTRY_HOLD" | "ERROR";
  };
  cloudflare: DomainPollingCloudflareState;
  storefront: DomainPollingStorefrontState;
  adminDiagnostics: {
    domain: string;
    merchantStatus: MerchantDomainStatusView;
    providerDiagnostics: {
      providerStatus?: string | null;
      raaEmailVerified?: boolean | null;
      domainVerificationComplete?: boolean | null;
      ekycVerified?: boolean | null;
      registryHoldDetected: boolean;
      nameservers: string[];
    };
    cloudflareCustomHostnameId?: string | null;
    dnsValidationStatus: string;
    sslStatus?: string | null;
    suggestedAuditEvent: DomainAutomationAuditEvent;
    retryPlan: DomainRetryPlan;
    rawStatusSummary: Record<string, unknown>;
  };
  checkedAt: Date;
};

export type DomainStatusPollContext = {
  domain: string;
  currentStatus?: string | null;
  merchantDomainId?: string | null;
  resellerClubOrderId?: string | null;
  cloudflareCustomHostnameId?: string | null;
  validationRecords?: Prisma.JsonValue | null;
  storefrontUrl?: string | null;
};

export type DomainStatusPollingAdapters = {
  provider?: {
    getDomainStatus(context: DomainStatusPollContext): Promise<DomainPollingProviderState>;
  };
  dns?: {
    getNameserverState(domain: string): Promise<DomainPollingNameserverState>;
    checkTxtRecord(expectedName?: string | null, expectedValue?: string | null): Promise<DomainPollingTxtState>;
  };
  cloudflare?: {
    getCustomHostnameStatus(context: DomainStatusPollContext): Promise<DomainPollingCloudflareState>;
  };
  storefront?: {
    checkStorefront(domain: string): Promise<DomainPollingStorefrontState>;
  };
};
