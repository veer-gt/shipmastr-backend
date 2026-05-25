import { HttpError } from "../../lib/httpError.js";
import { normalizeDomain } from "./domain.utils.js";

export const DOMAIN_PROVIDER_MODES = ["mock", "sandbox", "live"] as const;
export type DomainProviderMode = (typeof DOMAIN_PROVIDER_MODES)[number];

export const DOMAIN_PROVIDER_ENV_NAMES = [
  "RESELLERCLUB_BASE_URL",
  "RESELLERCLUB_AUTH_USERID",
  "RESELLERCLUB_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "SHIPMASTR_INTERNAL_PROVISIONING_SECRET",
  "SHIPMASTR_DOMAIN_PROVIDER_MODE",
  "ALLOW_RESELLERCLUB_AVAILABILITY_CHECK",
  "RESELLERCLUB_DEBUG_SAFE",
  "ALLOW_RESELLERCLUB_BASE_MATRIX",
  "ALLOW_LIVE_DOMAIN_REGISTRATION"
] as const;

export type DomainProviderEnvName = (typeof DOMAIN_PROVIDER_ENV_NAMES)[number];

type EnvLike = Partial<Record<DomainProviderEnvName | string, string | boolean | number | null | undefined>>;

export function resolveDomainProviderMode(value?: string | null): DomainProviderMode {
  const mode = String(value || "mock").trim().toLowerCase();
  if (mode === "mock" || mode === "sandbox" || mode === "live") return mode;
  throw new HttpError(500, "INVALID_DOMAIN_PROVIDER_MODE");
}

export function parseBooleanFlag(value?: string | boolean | number | null) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function summarizeDomainProviderEnv(source: EnvLike = process.env) {
  const mode = resolveDomainProviderMode(String(source.SHIPMASTR_DOMAIN_PROVIDER_MODE || "mock"));
  const allowAvailability = parseBooleanFlag(source.ALLOW_RESELLERCLUB_AVAILABILITY_CHECK);
  const allowLiveDomainRegistration = parseBooleanFlag(source.ALLOW_LIVE_DOMAIN_REGISTRATION);
  const required = DOMAIN_PROVIDER_ENV_NAMES.map((name) => ({
    name,
    present: source[name] !== undefined && String(source[name] || "").trim().length > 0
  }));

  const availabilityCheck = mode === "sandbox" && allowAvailability ? "unblocked" : "blocked";
  const liveRegistration = mode === "live" && allowLiveDomainRegistration ? "unblocked" : "blocked";
  const reasons: string[] = [];
  if (mode !== "live") reasons.push(`provider mode is ${mode}`);
  if (!allowLiveDomainRegistration) reasons.push("ALLOW_LIVE_DOMAIN_REGISTRATION is not true");
  const availabilityReasons: string[] = [];
  if (mode !== "sandbox") availabilityReasons.push(`provider mode is ${mode}`);
  if (!allowAvailability) availabilityReasons.push("ALLOW_RESELLERCLUB_AVAILABILITY_CHECK is not true");

  return {
    mode,
    required,
    availabilityCheck,
    availabilityReasons,
    liveRegistration,
    reasons
  };
}

export function assertResellerClubAvailabilityAllowed(input: {
  mode?: string | null | undefined;
  allowAvailabilityCheck?: string | boolean | number | null | undefined;
  baseUrl?: string | null | undefined;
  authUserid?: string | null | undefined;
  apiKey?: string | null | undefined;
  operation?: string | null | undefined;
}) {
  const mode = resolveDomainProviderMode(input.mode);
  const allowAvailabilityCheck = parseBooleanFlag(input.allowAvailabilityCheck);

  if (input.operation !== "availability") {
    throw new HttpError(409, "DOMAIN_PROVIDER_OPERATION_NOT_ALLOWED");
  }

  if (mode !== "sandbox") {
    throw new HttpError(409, "DOMAIN_AVAILABILITY_PROVIDER_MODE_REQUIRED");
  }

  if (!allowAvailabilityCheck) {
    throw new HttpError(409, "DOMAIN_AVAILABILITY_CHECK_NOT_ALLOWED");
  }

  if (!input.baseUrl || !input.authUserid || !input.apiKey) {
    throw new HttpError(503, "DOMAIN_PROVIDER_NOT_CONFIGURED");
  }
}

export function assertLiveDomainRegistrationAllowed(input: {
  mode?: string | null | undefined;
  allowLiveDomainRegistration?: string | boolean | number | null | undefined;
  paymentVerified?: boolean | undefined;
  onboardingApproved?: boolean | undefined;
  merchantDomainId?: string | null | undefined;
  domain: string;
  auditEventCreated?: boolean | undefined;
}) {
  const mode = resolveDomainProviderMode(input.mode);
  const allowLiveDomainRegistration = parseBooleanFlag(input.allowLiveDomainRegistration);

  normalizeDomain(input.domain);

  if (mode !== "live") {
    throw new HttpError(409, "DOMAIN_LIVE_REGISTRATION_DISABLED");
  }

  if (!allowLiveDomainRegistration) {
    throw new HttpError(409, "DOMAIN_LIVE_REGISTRATION_NOT_ALLOWED");
  }

  if (!input.paymentVerified) {
    throw new HttpError(409, "DOMAIN_PAYMENT_NOT_VERIFIED");
  }

  if (!input.onboardingApproved) {
    throw new HttpError(409, "DOMAIN_ONBOARDING_NOT_APPROVED");
  }

  if (!input.merchantDomainId) {
    throw new HttpError(409, "DOMAIN_REGISTRATION_RECORD_REQUIRED");
  }

  if (!input.auditEventCreated) {
    throw new HttpError(409, "DOMAIN_REGISTRATION_AUDIT_REQUIRED");
  }
}
