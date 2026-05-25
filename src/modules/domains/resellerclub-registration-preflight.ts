import { HttpError } from "../../lib/httpError.js";
import { parseBooleanFlag } from "./domain-provider-mode.js";
import { normalizeDomain } from "./domain.utils.js";

export const RESELLERCLUB_REGISTRATION_ID_ENV_NAMES = [
  "RESELLERCLUB_CUSTOMER_ID",
  "RESELLERCLUB_REG_CONTACT_ID",
  "RESELLERCLUB_ADMIN_CONTACT_ID",
  "RESELLERCLUB_TECH_CONTACT_ID",
  "RESELLERCLUB_BILLING_CONTACT_ID"
] as const;

export type ResellerClubRegistrationContactIds = {
  registrant?: string | null;
  admin?: string | null;
  tech?: string | null;
  billing?: string | null;
};

export type ResellerClubRegistrationPreflightInput = {
  domain: string;
  customerId?: string | null;
  contactIds?: ResellerClubRegistrationContactIds | null;
  nameserverParamsVerified?: string | boolean | number | null | undefined;
  allowLiveDomainRegistration?: string | boolean | number | null | undefined;
};

export type ResellerClubRegistrationPreflightSummary = {
  domain: string;
  requiredIds: Array<{ name: string; present: boolean }>;
  missingIds: string[];
  requiresNameserverParamVerification: boolean;
  nameserverParamsVerified: boolean;
  liveRegistrationDefaultBlocked: boolean;
  ready: boolean;
};

const REQUIRED_ID_FIELDS = [
  { name: "customer-id", key: "customerId" },
  { name: "reg-contact-id", key: "registrant" },
  { name: "admin-contact-id", key: "admin" },
  { name: "tech-contact-id", key: "tech" },
  { name: "billing-contact-id", key: "billing" }
] as const;

type EnvSource = Partial<Record<string, string | boolean | number | null | undefined>>;

function isPresent(value?: string | null) {
  return String(value || "").trim().length > 0;
}

function inputFromEnv(domain: string, source: EnvSource): ResellerClubRegistrationPreflightInput {
  return {
    domain,
    customerId: String(source.RESELLERCLUB_CUSTOMER_ID || ""),
    contactIds: {
      registrant: String(source.RESELLERCLUB_REG_CONTACT_ID || ""),
      admin: String(source.RESELLERCLUB_ADMIN_CONTACT_ID || ""),
      tech: String(source.RESELLERCLUB_TECH_CONTACT_ID || ""),
      billing: String(source.RESELLERCLUB_BILLING_CONTACT_ID || "")
    },
    nameserverParamsVerified: source.RESELLERCLUB_IN_NAMESERVER_PARAMS_VERIFIED,
    allowLiveDomainRegistration: source.ALLOW_LIVE_DOMAIN_REGISTRATION
  };
}

export function buildResellerClubRegistrationPreflightSummary(
  input: ResellerClubRegistrationPreflightInput
): ResellerClubRegistrationPreflightSummary {
  const normalized = normalizeDomain(input.domain);
  const contactIds = input.contactIds || {};
  const values = {
    customerId: input.customerId,
    registrant: contactIds.registrant,
    admin: contactIds.admin,
    tech: contactIds.tech,
    billing: contactIds.billing
  };
  const requiredIds = REQUIRED_ID_FIELDS.map((field) => ({
    name: field.name,
    present: isPresent(values[field.key])
  }));
  const missingIds = requiredIds.filter((field) => !field.present).map((field) => field.name);
  const requiresNameserverParamVerification = normalized.tld === "in" || normalized.tld.endsWith(".in");
  const nameserverParamsVerified = parseBooleanFlag(input.nameserverParamsVerified);
  const liveRegistrationDefaultBlocked = !parseBooleanFlag(input.allowLiveDomainRegistration);

  return {
    domain: normalized.normalizedDomain,
    requiredIds,
    missingIds,
    requiresNameserverParamVerification,
    nameserverParamsVerified,
    liveRegistrationDefaultBlocked,
    ready:
      missingIds.length === 0 &&
      (!requiresNameserverParamVerification || nameserverParamsVerified) &&
      liveRegistrationDefaultBlocked
  };
}

export function assertResellerClubRegistrationPayloadReady(input: ResellerClubRegistrationPreflightInput) {
  const summary = buildResellerClubRegistrationPreflightSummary({
    ...input,
    allowLiveDomainRegistration: false
  });

  if (summary.missingIds.length > 0) {
    throw new HttpError(409, "RESELLERCLUB_REGISTRATION_IDS_REQUIRED", {
      missingIds: summary.missingIds
    });
  }

  if (summary.requiresNameserverParamVerification && !summary.nameserverParamsVerified) {
    throw new HttpError(409, "RESELLERCLUB_IN_NAMESERVER_PARAMS_NOT_VERIFIED");
  }

  return summary;
}

export function assertResellerClubRegistrationPreflightFromEnv(domain: string, source: EnvSource = process.env) {
  const summary = buildResellerClubRegistrationPreflightSummary(inputFromEnv(domain, source));

  if (!summary.liveRegistrationDefaultBlocked) {
    throw new HttpError(409, "RESELLERCLUB_LIVE_REGISTRATION_MUST_REMAIN_DISABLED", {
      liveRegistrationDefaultBlocked: false
    });
  }

  if (summary.missingIds.length > 0) {
    throw new HttpError(409, "RESELLERCLUB_REGISTRATION_IDS_REQUIRED", {
      missingIds: summary.missingIds
    });
  }

  if (summary.requiresNameserverParamVerification && !summary.nameserverParamsVerified) {
    throw new HttpError(409, "RESELLERCLUB_IN_NAMESERVER_PARAMS_NOT_VERIFIED");
  }

  return summary;
}
