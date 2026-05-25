import dotenv from "dotenv";
import { env } from "../dist/config/env.js";
import { assertResellerClubAvailabilityAllowed } from "../dist/modules/domains/domain-provider-mode.js";
import { normalizeDomain } from "../dist/modules/domains/domain.utils.js";
import { resellerClubService } from "../dist/modules/domains/providers/resellerclub.service.js";

dotenv.config();

const BASE_MATRIX = [
  "https://httpapi.com",
  "https://domaincheck.httpapi.com",
  "https://test.httpapi.com"
];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function baseHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "invalid_base_url";
  }
}

async function main() {
  const inputDomain = argValue("--domain");
  if (!inputDomain) {
    throw new Error("Usage: npm run domains:resellerclub-availability-smoke -- --domain example-test-domain.in");
  }

  const normalized = normalizeDomain(inputDomain);

  assertResellerClubAvailabilityAllowed({
    mode: env.SHIPMASTR_DOMAIN_PROVIDER_MODE,
    allowAvailabilityCheck: env.ALLOW_RESELLERCLUB_AVAILABILITY_CHECK,
    baseUrl: env.RESELLERCLUB_BASE_URL,
    authUserid: env.RESELLERCLUB_AUTH_USERID,
    apiKey: env.RESELLERCLUB_API_KEY,
    operation: "availability"
  });

  if (env.ALLOW_LIVE_DOMAIN_REGISTRATION) {
    throw new Error("Refusing availability smoke while live domain registration is unblocked");
  }

  const runMatrix = hasArg("--base-matrix");
  if (runMatrix && !env.ALLOW_RESELLERCLUB_BASE_MATRIX) {
    throw new Error("Refusing base matrix smoke unless ALLOW_RESELLERCLUB_BASE_MATRIX is true");
  }

  const bases = runMatrix ? BASE_MATRIX : [env.RESELLERCLUB_BASE_URL].filter(Boolean);
  const results = [];

  for (const baseUrl of bases) {
    const result = await resellerClubService.checkAvailability(normalized.normalizedDomain, { baseUrl });
    results.push({
      baseHost: baseHost(baseUrl),
      domain: result.domain,
      available: result.available,
      provider: result.provider,
      providerStatus: result.providerStatus,
      safeMessage: result.safeMessage,
      note: "Availability-only: no registration attempted"
    });
  }

  console.log(JSON.stringify({
    results,
    note: "Availability-only: no registration attempted"
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    error: "RESELLERCLUB_AVAILABILITY_SMOKE_BLOCKED",
    message,
    note: "Availability-only: no registration attempted"
  }, null, 2));
  process.exitCode = 1;
});
