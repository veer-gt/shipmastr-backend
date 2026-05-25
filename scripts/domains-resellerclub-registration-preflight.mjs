import dotenv from "dotenv";
import {
  assertResellerClubRegistrationPreflightFromEnv,
  buildResellerClubRegistrationPreflightSummary
} from "../dist/modules/domains/resellerclub-registration-preflight.js";

dotenv.config({ quiet: true });

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const domain = argValue("--domain");

if (!domain) {
  console.error(JSON.stringify({
    error: "RESELLERCLUB_REGISTRATION_PREFLIGHT_USAGE",
    message: "Usage: npm run domains:resellerclub-registration-preflight -- --domain shipmastr-test-origin-001.in",
    note: "Preflight only: no registration attempted"
  }, null, 2));
  process.exit(1);
}

try {
  const summary = assertResellerClubRegistrationPreflightFromEnv(domain);
  console.log(JSON.stringify({
    ...summary,
    note: "Preflight only: no registration attempted"
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  let summary;
  try {
    summary = buildResellerClubRegistrationPreflightSummary({
      domain,
      customerId: process.env.RESELLERCLUB_CUSTOMER_ID,
      contactIds: {
        registrant: process.env.RESELLERCLUB_REG_CONTACT_ID,
        admin: process.env.RESELLERCLUB_ADMIN_CONTACT_ID,
        tech: process.env.RESELLERCLUB_TECH_CONTACT_ID,
        billing: process.env.RESELLERCLUB_BILLING_CONTACT_ID
      },
      nameserverParamsVerified: process.env.RESELLERCLUB_IN_NAMESERVER_PARAMS_VERIFIED,
      allowLiveDomainRegistration: process.env.ALLOW_LIVE_DOMAIN_REGISTRATION
    });
  } catch {
    summary = undefined;
  }

  console.error(JSON.stringify({
    error: "RESELLERCLUB_REGISTRATION_PREFLIGHT_BLOCKED",
    message,
    summary,
    note: "Preflight only: no registration attempted"
  }, null, 2));
  process.exitCode = 1;
}
