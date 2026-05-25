import dotenv from "dotenv";

dotenv.config();

const ECHO_ENDPOINTS = [
  "https://api.ipify.org?format=json",
  "https://ifconfig.me/all.json"
];

function runtimeNote() {
  const runtime = (process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || process.env.GAE_SERVICE)
    ? "cloud-runtime"
    : "local-or-unknown-runtime";

  return runtime === "cloud-runtime"
    ? "Run this from the same Cloud Run/n8n runtime that will call the provider."
    : "This appears to be local or unknown runtime; this is not production Cloud Run outbound IP evidence.";
}

async function detectOutboundIp() {
  let lastError = null;
  for (const endpoint of ECHO_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, { headers: { "Accept": "application/json,text/plain" } });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      try {
        const json = JSON.parse(text);
        return String(json.ip || json.ip_addr || json.remote_addr || "").trim();
      } catch {
        return text.trim();
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Unable to detect outbound IP");
}

async function main() {
  const detectedOutboundIp = await detectOutboundIp();
  const expected = String(process.env.EXPECTED_PROVIDER_OUTBOUND_IP || "").trim();
  const matchesExpected = expected ? detectedOutboundIp === expected : null;

  console.log(JSON.stringify({
    detectedOutboundIp,
    expectedProviderOutboundIpConfigured: Boolean(expected),
    matchesExpected,
    runtimeNote: runtimeNote(),
    reminder: "Whitelist exactly this single IP in WebPro Panel API Settings before provider calls. Do not use IP ranges or netblocks."
  }, null, 2));

  if (expected && !matchesExpected) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: "OUTBOUND_IP_CHECK_FAILED",
    message: error instanceof Error ? error.message : String(error),
    reminder: "This script only verifies runtime egress IP. It does not configure Cloud NAT or provider whitelist."
  }, null, 2));
  process.exitCode = 1;
});
