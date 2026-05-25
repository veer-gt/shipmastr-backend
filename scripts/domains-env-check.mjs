import dotenv from "dotenv";

dotenv.config();

const PROVIDER_ENV_NAMES = [
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
];

function providerMode(value) {
  const mode = String(value || "mock").trim().toLowerCase();
  if (["mock", "sandbox", "live"].includes(mode)) return mode;
  return "invalid";
}

function booleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

const mode = providerMode(process.env.SHIPMASTR_DOMAIN_PROVIDER_MODE);
const allowAvailability = booleanFlag(process.env.ALLOW_RESELLERCLUB_AVAILABILITY_CHECK);
const allowLive = booleanFlag(process.env.ALLOW_LIVE_DOMAIN_REGISTRATION);
const summary = {
  mode,
  availabilityCheck: mode === "sandbox" && allowAvailability ? "unblocked" : "blocked",
  liveRegistration: mode === "live" && allowLive ? "unblocked" : "blocked",
  required: PROVIDER_ENV_NAMES.map((name) => ({
    name,
    present: Boolean(String(process.env[name] || "").trim())
  }))
};

if (mode !== "live") {
  summary.reason = `provider mode is ${mode}`;
} else if (!allowLive) {
  summary.reason = "ALLOW_LIVE_DOMAIN_REGISTRATION is not true";
}

if (mode !== "sandbox") {
  summary.availabilityReason = `provider mode is ${mode}`;
} else if (!allowAvailability) {
  summary.availabilityReason = "ALLOW_RESELLERCLUB_AVAILABILITY_CHECK is not true";
}

console.log(JSON.stringify(summary, null, 2));

if (mode === "invalid") {
  process.exitCode = 1;
}
