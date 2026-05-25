import { DomainProvider, DomainStatus, MerchantDomainSource, Prisma } from "@prisma/client";

export const MERCHANT_DOMAIN_LIFECYCLE_STATUSES = [
  "REQUESTED",
  "REVIEW_REQUIRED",
  "ADMIN_APPROVED",
  "PROVIDER_SETUP_READY",
  "PROVIDER_SETUP_STARTED",
  "DNS_INSTRUCTIONS_AVAILABLE",
  "SEARCHED",
  "AVAILABLE",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "REGISTRATION_STARTED",
  "REGISTERED",
  "CUSTOM_HOSTNAME_PENDING",
  "VERIFICATION_REQUIRED",
  "EKYC_PENDING",
  "TXT_VALIDATION_PENDING",
  "CNAME_PENDING",
  "WORKER_ROUTE_PENDING",
  "DNS_VALIDATION_PENDING",
  "DNS_VALIDATED",
  "SSL_ISSUING",
  "STOREFRONT_MAPPING_PENDING",
  "CONNECTED",
  "LIVE",
  "FAILED_NEEDS_SUPPORT",
  "NEEDS_ATTENTION"
] as const;

export type MerchantDomainLifecycleStatus = (typeof MERCHANT_DOMAIN_LIFECYCLE_STATUSES)[number];

export type MerchantDomainStatusView = {
  domain: string;
  status: MerchantDomainLifecycleStatus;
  title: string;
  message: string;
  nextActionLabel: string;
  nextActionDescription: string;
  canRetry: boolean;
  estimatedTimeText: string;
  updatedAt: Date | string | null;
  dnsInstructions?: {
    available: boolean;
    summary?: string | null;
    records?: Array<{
      type?: string | null;
      name?: string | null;
      value?: string | null;
      ttl?: string | number | null;
      purpose?: string | null;
    }>;
  };
  progressSteps: Array<{
    key: string;
    label: string;
    state: "complete" | "current" | "upcoming";
  }>;
};

type MerchantDomainStatusInput = {
  domain: string;
  status: DomainStatus | MerchantDomainLifecycleStatus | string;
  updatedAt?: Date | string | null | undefined;
  lastCheckedAt?: Date | string | null | undefined;
  validationRecords?: Prisma.JsonValue | null | undefined;
  sslStatus?: string | null | undefined;
};

type AdminDomainDiagnosticsInput = MerchantDomainStatusInput & {
  provider?: DomainProvider | string | null | undefined;
  source?: MerchantDomainSource | string | null | undefined;
  resellerClubOrderId?: string | null | undefined;
  resellerClubEntityId?: string | null | undefined;
  cloudflareCustomHostnameId?: string | null | undefined;
  events?: Array<{
    eventType?: string | null | undefined;
    status?: string | null | undefined;
    provider?: DomainProvider | string | null | undefined;
    providerReferenceId?: string | null | undefined;
    createdAt?: Date | string | null | undefined;
  }> | undefined;
};

const MERCHANT_COPY: Record<MerchantDomainLifecycleStatus, Omit<MerchantDomainStatusView, "domain" | "status" | "updatedAt" | "progressSteps">> = {
  REQUESTED: {
    title: "Domain request received",
    message: "Shipmastr will guide you through connecting this domain.",
    nextActionLabel: "No action needed",
    nextActionDescription: "Our team will review the request and start setup when it is approved.",
    canRetry: false,
    estimatedTimeText: "Admin review required"
  },
  REVIEW_REQUIRED: {
    title: "Review required",
    message: "Your domain request is waiting for Shipmastr review.",
    nextActionLabel: "Admin review",
    nextActionDescription: "Shipmastr will review the domain and guide you through the next step.",
    canRetry: false,
    estimatedTimeText: "Admin review required"
  },
  ADMIN_APPROVED: {
    title: "Domain request approved",
    message: "Shipmastr has approved this domain for setup.",
    nextActionLabel: "Wait for setup",
    nextActionDescription: "Shipmastr will start the setup step after the internal approval checks are complete.",
    canRetry: false,
    estimatedTimeText: "Setup has not started yet"
  },
  PROVIDER_SETUP_READY: {
    title: "Setup ready",
    message: "Your domain is approved and ready for Shipmastr setup.",
    nextActionLabel: "No action needed",
    nextActionDescription: "Shipmastr will start the setup step. Connection instructions will appear only when they are ready.",
    canRetry: false,
    estimatedTimeText: "Waiting for setup to start"
  },
  PROVIDER_SETUP_STARTED: {
    title: "Domain setup started",
    message: "Shipmastr has started setting up your domain.",
    nextActionLabel: "Wait for instructions",
    nextActionDescription: "We will show the next connection step when it is ready.",
    canRetry: false,
    estimatedTimeText: "Usually a few minutes"
  },
  DNS_INSTRUCTIONS_AVAILABLE: {
    title: "Connection instructions ready",
    message: "Your domain connection instructions are ready.",
    nextActionLabel: "Add connection record",
    nextActionDescription: "Add the record shown by Shipmastr, then return here to check status.",
    canRetry: true,
    estimatedTimeText: "Usually within 15 to 60 minutes after records are added"
  },
  SEARCHED: {
    title: "Search complete",
    message: "Your domain search is ready to continue.",
    nextActionLabel: "Review domain",
    nextActionDescription: "Choose whether to buy this domain or connect one you already own.",
    canRetry: true,
    estimatedTimeText: "Instant"
  },
  AVAILABLE: {
    title: "Domain available",
    message: "This domain is available for your store.",
    nextActionLabel: "Continue to payment",
    nextActionDescription: "Complete payment to reserve the domain for your Shipmastr store.",
    canRetry: true,
    estimatedTimeText: "Instant"
  },
  PAYMENT_PENDING: {
    title: "Payment pending",
    message: "Your domain order is waiting for payment.",
    nextActionLabel: "Complete payment",
    nextActionDescription: "Finish payment so Shipmastr can start domain setup.",
    canRetry: true,
    estimatedTimeText: "Setup starts after payment"
  },
  PAYMENT_RECEIVED: {
    title: "Payment received",
    message: "Your domain payment is confirmed and setup will begin shortly.",
    nextActionLabel: "No action needed",
    nextActionDescription: "Shipmastr will continue the setup flow from here.",
    canRetry: false,
    estimatedTimeText: "Usually starts within a few minutes"
  },
  REGISTRATION_STARTED: {
    title: "Domain setup started",
    message: "Shipmastr is setting up your domain.",
    nextActionLabel: "Wait for setup",
    nextActionDescription: "We will move your domain through verification and connection checks.",
    canRetry: false,
    estimatedTimeText: "Usually a few minutes"
  },
  REGISTERED: {
    title: "Domain registered",
    message: "Your domain is registered and connection setup is next.",
    nextActionLabel: "Watch for verification",
    nextActionDescription: "You may receive a verification email from our domain verification partner. Please complete it to activate your domain.",
    canRetry: false,
    estimatedTimeText: "Verification timing depends on the registry"
  },
  CUSTOM_HOSTNAME_PENDING: {
    title: "Domain setup in progress",
    message: "Shipmastr is preparing your domain connection.",
    nextActionLabel: "No action needed",
    nextActionDescription: "We will continue setup and let you know if verification is needed.",
    canRetry: false,
    estimatedTimeText: "Usually a few minutes"
  },
  VERIFICATION_REQUIRED: {
    title: "Verification required",
    message: "Your domain needs verification before setup can continue.",
    nextActionLabel: "Check verification email",
    nextActionDescription: "You may receive a verification email from our domain verification partner. Please complete it to activate your domain.",
    canRetry: false,
    estimatedTimeText: "Updates after verification is complete"
  },
  EKYC_PENDING: {
    title: "Registry verification in progress",
    message: "We’re waiting for domain registry verification to clear before setup can continue.",
    nextActionLabel: "Watch for verification",
    nextActionDescription: "Please complete any requested registry verification email. If you already completed it, Shipmastr will keep checking.",
    canRetry: false,
    estimatedTimeText: "Often clears within 24 to 48 hours"
  },
  TXT_VALIDATION_PENDING: {
    title: "Verification pending",
    message: "We’re verifying your domain connection.",
    nextActionLabel: "Follow Shipmastr guidance",
    nextActionDescription: "If a DNS verification step is needed, Shipmastr support will share the next action.",
    canRetry: true,
    estimatedTimeText: "Usually within 15 to 60 minutes"
  },
  CNAME_PENDING: {
    title: "Connection record pending",
    message: "Your domain connection record is pending.",
    nextActionLabel: "Follow Shipmastr guidance",
    nextActionDescription: "Shipmastr will guide you through the safe connection record when it is time.",
    canRetry: true,
    estimatedTimeText: "Usually within 15 to 60 minutes after DNS is added"
  },
  WORKER_ROUTE_PENDING: {
    title: "Final routing pending",
    message: "Shipmastr is preparing final storefront routing.",
    nextActionLabel: "No action needed",
    nextActionDescription: "Our team is completing the internal routing step.",
    canRetry: false,
    estimatedTimeText: "Usually a few minutes"
  },
  DNS_VALIDATION_PENDING: {
    title: "Verifying domain connection",
    message: "We’re verifying your domain connection.",
    nextActionLabel: "No action needed",
    nextActionDescription: "Shipmastr will keep checking the connection. You do not need to change anything unless support asks.",
    canRetry: true,
    estimatedTimeText: "Usually within 15 to 60 minutes"
  },
  DNS_VALIDATED: {
    title: "Connection verified",
    message: "Your domain connection record has been verified.",
    nextActionLabel: "Wait for secure certificate",
    nextActionDescription: "Shipmastr is completing the secure connection for your storefront.",
    canRetry: false,
    estimatedTimeText: "Usually a few minutes"
  },
  SSL_ISSUING: {
    title: "Issuing secure certificate",
    message: "Your secure certificate is being issued.",
    nextActionLabel: "No action needed",
    nextActionDescription: "Your storefront will become secure as soon as certificate issuance is complete.",
    canRetry: true,
    estimatedTimeText: "Usually within 15 to 60 minutes"
  },
  STOREFRONT_MAPPING_PENDING: {
    title: "Storefront mapping pending",
    message: "Your domain is being linked to your storefront.",
    nextActionLabel: "No action needed",
    nextActionDescription: "Shipmastr is completing the final storefront mapping.",
    canRetry: false,
    estimatedTimeText: "Usually a few minutes"
  },
  CONNECTED: {
    title: "Domain connected",
    message: "Your domain connection is ready and final storefront checks are running.",
    nextActionLabel: "No action needed",
    nextActionDescription: "Shipmastr is completing the final checks before your domain goes live.",
    canRetry: false,
    estimatedTimeText: "Usually a few minutes"
  },
  LIVE: {
    title: "Domain live",
    message: "Your domain is live.",
    nextActionLabel: "Open storefront",
    nextActionDescription: "Your customers can now visit your storefront on this domain.",
    canRetry: false,
    estimatedTimeText: "Live now"
  },
  FAILED_NEEDS_SUPPORT: {
    title: "Setup needs support",
    message: "We could not complete domain setup automatically.",
    nextActionLabel: "Contact support",
    nextActionDescription: "Our team can review the domain setup and help you finish the connection.",
    canRetry: true,
    estimatedTimeText: "Shipmastr support review required"
  },
  NEEDS_ATTENTION: {
    title: "Needs attention",
    message: "Shipmastr needs to review this domain request before setup can continue.",
    nextActionLabel: "Contact support",
    nextActionDescription: "Our team can review the request and help with the next safe step.",
    canRetry: true,
    estimatedTimeText: "Shipmastr support review required"
  }
};

const PROGRESS_ORDER: MerchantDomainLifecycleStatus[] = [
  "REQUESTED",
  "REVIEW_REQUIRED",
  "ADMIN_APPROVED",
  "PROVIDER_SETUP_READY",
  "PROVIDER_SETUP_STARTED",
  "DNS_INSTRUCTIONS_AVAILABLE",
  "PAYMENT_RECEIVED",
  "REGISTRATION_STARTED",
  "REGISTERED",
  "CUSTOM_HOSTNAME_PENDING",
  "VERIFICATION_REQUIRED",
  "CNAME_PENDING",
  "WORKER_ROUTE_PENDING",
  "DNS_VALIDATION_PENDING",
  "DNS_VALIDATED",
  "SSL_ISSUING",
  "STOREFRONT_MAPPING_PENDING",
  "LIVE"
];

const PROGRESS_LABELS: Record<MerchantDomainLifecycleStatus, string> = {
  REQUESTED: "Requested",
  REVIEW_REQUIRED: "Review",
  ADMIN_APPROVED: "Approved",
  PROVIDER_SETUP_READY: "Setup ready",
  PROVIDER_SETUP_STARTED: "Setup started",
  DNS_INSTRUCTIONS_AVAILABLE: "Instructions",
  SEARCHED: "Search",
  AVAILABLE: "Available",
  PAYMENT_PENDING: "Payment",
  PAYMENT_RECEIVED: "Order received",
  REGISTRATION_STARTED: "Setup started",
  REGISTERED: "Registered",
  CUSTOM_HOSTNAME_PENDING: "Setup",
  VERIFICATION_REQUIRED: "Verification",
  EKYC_PENDING: "Verification",
  TXT_VALIDATION_PENDING: "Verification",
  CNAME_PENDING: "Connection record",
  WORKER_ROUTE_PENDING: "Routing",
  DNS_VALIDATION_PENDING: "Connection check",
  DNS_VALIDATED: "Connection verified",
  SSL_ISSUING: "Secure certificate",
  STOREFRONT_MAPPING_PENDING: "Storefront mapping",
  CONNECTED: "Connected",
  LIVE: "Live",
  FAILED_NEEDS_SUPPORT: "Support",
  NEEDS_ATTENTION: "Needs attention"
};

const STATUS_RANK: Record<MerchantDomainLifecycleStatus, number> = MERCHANT_DOMAIN_LIFECYCLE_STATUSES.reduce(
  (memo, status, index) => ({ ...memo, [status]: index }),
  {} as Record<MerchantDomainLifecycleStatus, number>
);

function hasJsonSignal(value: Prisma.JsonValue | null | undefined, patterns: RegExp[]) {
  if (!value) return false;
  const text = JSON.stringify(value).toLowerCase();
  return patterns.some((pattern) => pattern.test(text));
}

function statusRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function workflowStateFromRecords(value: Prisma.JsonValue | null | undefined) {
  const record = statusRecord(value);
  const workflow = nestedRecord(record.activationWorkflow);
  const state = String(workflow.state || record.workflowState || record.requestStatus || "").toUpperCase();
  return state;
}

function dnsInstructionsFromRecords(value: Prisma.JsonValue | null | undefined) {
  const record = statusRecord(value);
  const instructions = nestedRecord(record.dnsInstructions);
  const records = Array.isArray(instructions.records)
    ? instructions.records
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
        .map((item) => ({
          type: typeof item.type === "string" ? item.type : null,
          name: typeof item.name === "string" ? item.name : null,
          value: typeof item.value === "string" ? item.value : null,
          ttl: typeof item.ttl === "string" || typeof item.ttl === "number" ? item.ttl : null,
          purpose: typeof item.purpose === "string" ? item.purpose : null
        }))
    : [];
  const available = instructions.available === true || records.length > 0;
  return {
    available,
    summary: typeof instructions.summary === "string" ? instructions.summary : null,
    records
  };
}

function workflowIndicatesProviderSetupStarted(state: string) {
  return [
    "PROVIDER_SETUP_STARTED",
    "DNS_INSTRUCTIONS_AVAILABLE",
    "DNS_VALIDATED",
    "SSL_PENDING",
    "ACTIVE",
    "CONNECTED",
    "LIVE"
  ].includes(state);
}

export function mapMerchantDomainLifecycleStatus(input: MerchantDomainStatusInput): MerchantDomainLifecycleStatus {
  const rawStatus = String(input.status || "").toUpperCase();
  const workflowState = workflowStateFromRecords(input.validationRecords);
  const dnsInstructions = dnsInstructionsFromRecords(input.validationRecords);
  const providerSetupStarted = workflowIndicatesProviderSetupStarted(workflowState);

  const directLifecycleStatuses = new Set<string>([
    "REQUESTED",
    "REVIEW_REQUIRED",
    "ADMIN_APPROVED",
    "PROVIDER_SETUP_READY",
    "PROVIDER_SETUP_STARTED",
    "DNS_INSTRUCTIONS_AVAILABLE",
    "PAYMENT_PENDING",
    "PAYMENT_RECEIVED",
    "REGISTRATION_STARTED",
    "CUSTOM_HOSTNAME_PENDING",
    "VERIFICATION_REQUIRED",
    "EKYC_PENDING",
    "TXT_VALIDATION_PENDING",
    "CNAME_PENDING",
    "WORKER_ROUTE_PENDING",
    "DNS_VALIDATION_PENDING",
    "DNS_VALIDATED",
    "SSL_ISSUING",
    "STOREFRONT_MAPPING_PENDING",
    "CONNECTED",
    "LIVE",
    "FAILED_NEEDS_SUPPORT",
    "NEEDS_ATTENTION"
  ]);

  if (directLifecycleStatuses.has(rawStatus)) {
    return rawStatus as MerchantDomainLifecycleStatus;
  }

  if (workflowState === "REJECTED" || workflowState === "NEEDS_ATTENTION") return "NEEDS_ATTENTION";
  if (workflowState === "DNS_VALIDATED") return "DNS_VALIDATED";
  if (dnsInstructions.available && providerSetupStarted) return "DNS_INSTRUCTIONS_AVAILABLE";
  if (workflowState === "DNS_INSTRUCTIONS_AVAILABLE") return "PROVIDER_SETUP_STARTED";
  if (workflowState === "PROVIDER_SETUP_STARTED") return "PROVIDER_SETUP_STARTED";
  if (workflowState === "PROVIDER_SETUP_READY") return "PROVIDER_SETUP_READY";
  if (workflowState === "ADMIN_APPROVED" || workflowState === "APPROVED") return "ADMIN_APPROVED";
  if (workflowState === "ADMIN_REVIEW_REQUIRED" || workflowState === "IN_REVIEW") return "REVIEW_REQUIRED";

  if (rawStatus === DomainStatus.ACTIVE) return "LIVE";

  if (hasJsonSignal(input.validationRecords, [/ekyc/, /kyc.{0,32}pending/, /verification[-_ ]?hold/])) {
    return "EKYC_PENDING";
  }

  if (hasJsonSignal(input.validationRecords, [/verification.{0,32}required/, /raa.{0,32}pending/, /registrant.{0,32}(verification|email).{0,32}pending/])) {
    return "VERIFICATION_REQUIRED";
  }

  const sslStatus = String(input.sslStatus || "").toLowerCase();
  const secureReady = ["active", "issued", "valid", "verified"].includes(sslStatus.trim());

  switch (rawStatus) {
    case DomainStatus.REQUESTED:
      return "REQUESTED";
    case DomainStatus.SEARCHED:
      return "SEARCHED";
    case DomainStatus.AVAILABLE:
      return "AVAILABLE";
    case DomainStatus.PAYMENT_REQUIRED:
    case DomainStatus.RENEWAL_DUE:
      return "PAYMENT_PENDING";
    case DomainStatus.APPROVAL_REQUIRED:
      return "PAYMENT_RECEIVED";
    case DomainStatus.REGISTERING:
      return "REGISTRATION_STARTED";
    case DomainStatus.REGISTERED:
      return "REGISTERED";
    case DomainStatus.DNS_PENDING:
    case DomainStatus.CLOUDFLARE_PENDING:
      return secureReady ? "CONNECTED" : "DNS_VALIDATION_PENDING";
    case DomainStatus.SSL_PENDING:
      return secureReady ? "CONNECTED" : "SSL_ISSUING";
    case DomainStatus.FAILED:
    case DomainStatus.SUSPENDED:
    case DomainStatus.EXPIRED:
    case DomainStatus.UNAVAILABLE:
      return "FAILED_NEEDS_SUPPORT";
    default:
      return "REGISTRATION_STARTED";
  }
}

function buildProgressSteps(status: MerchantDomainLifecycleStatus) {
  if (status === "SEARCHED" || status === "AVAILABLE" || status === "PAYMENT_PENDING") {
    const earlySteps: MerchantDomainLifecycleStatus[] = ["SEARCHED", "AVAILABLE", "PAYMENT_PENDING"];
    const currentRank = STATUS_RANK[status];
    return earlySteps.map((step) => ({
      key: step,
      label: PROGRESS_LABELS[step],
      state: STATUS_RANK[step] < currentRank ? "complete" as const : STATUS_RANK[step] === currentRank ? "current" as const : "upcoming" as const
    }));
  }

  if (status === "FAILED_NEEDS_SUPPORT" || status === "NEEDS_ATTENTION") {
    return [
      { key: status, label: PROGRESS_LABELS[status], state: "current" as const }
    ];
  }

  const normalizedStatus =
    status === "EKYC_PENDING" || status === "TXT_VALIDATION_PENDING"
      ? "VERIFICATION_REQUIRED"
      : status === "CONNECTED"
        ? "SSL_ISSUING"
        : status;
  const currentIndex = PROGRESS_ORDER.indexOf(normalizedStatus);
  return PROGRESS_ORDER.map((step, index) => ({
    key: step,
    label: PROGRESS_LABELS[step],
    state: index < currentIndex || status === "LIVE" ? "complete" as const : index === currentIndex ? "current" as const : "upcoming" as const
  }));
}

export function buildMerchantDomainStatusView(input: MerchantDomainStatusInput): MerchantDomainStatusView {
  const status = mapMerchantDomainLifecycleStatus(input);
  const copy = MERCHANT_COPY[status];
  const dnsInstructions = dnsInstructionsFromRecords(input.validationRecords);
  const workflowState = workflowStateFromRecords(input.validationRecords);
  const showDnsInstructions = dnsInstructions.available && workflowIndicatesProviderSetupStarted(workflowState);
  return {
    domain: input.domain,
    status,
    ...copy,
    updatedAt: input.updatedAt || input.lastCheckedAt || null,
    ...(showDnsInstructions ? { dnsInstructions } : {}),
    progressSteps: buildProgressSteps(status)
  };
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function pickContactIds(record: Record<string, unknown>) {
  const nested = jsonObject(record.contactIds as Prisma.JsonValue | null | undefined);
  return {
    registrant: pickString(nested, ["registrant", "regContactId", "reg-contact-id"]) || pickString(record, ["registrantContactId", "regContactId", "reg-contact-id"]),
    admin: pickString(nested, ["admin", "adminContactId", "admin-contact-id"]) || pickString(record, ["adminContactId", "admin-contact-id"]),
    tech: pickString(nested, ["tech", "techContactId", "tech-contact-id"]) || pickString(record, ["techContactId", "tech-contact-id"]),
    billing: pickString(nested, ["billing", "billingContactId", "billing-contact-id"]) || pickString(record, ["billingContactId", "billing-contact-id"])
  };
}

export function buildAdminDomainDiagnosticsView(input: AdminDomainDiagnosticsInput) {
  const record = jsonObject(input.validationRecords);
  const latestEvent = input.events?.[0] || null;

  return {
    domain: input.domain,
    merchantStatus: buildMerchantDomainStatusView(input),
    providerDiagnostics: {
      provider: input.provider || null,
      source: input.source || null,
      internalStatus: input.status,
      resellerClubEntityId: input.resellerClubEntityId || null,
      eventCount: input.events?.length || 0,
      latestEvent: latestEvent
        ? {
            eventType: latestEvent.eventType || null,
            status: latestEvent.status || null,
            provider: latestEvent.provider || null,
            providerReferenceId: latestEvent.providerReferenceId || null,
            createdAt: latestEvent.createdAt || null
          }
        : null
    },
    resellerClubOrderId: input.resellerClubOrderId || null,
    customerId: pickString(record, ["customerId", "customer-id", "resellerClubCustomerId"]),
    contactIds: pickContactIds(record),
    cloudflareCustomHostnameId: input.cloudflareCustomHostnameId || null,
    dnsValidationStatus: pickString(record, ["dnsValidationStatus", "validationStatus", "status"]),
    sslStatus: input.sslStatus || pickString(record, ["sslStatus"]),
    rawStatusSummary: {
      status: input.status,
      sslStatus: input.sslStatus || null,
      updatedAt: input.updatedAt || null,
      lastCheckedAt: input.lastCheckedAt || null,
      latestEventType: latestEvent?.eventType || null
    }
  };
}
