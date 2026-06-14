#!/usr/bin/env node

const DEFAULT_API_BASE_URL = "http://localhost:8080/api/shipping";
const DEFAULT_PROVIDER_KEY = "SHIPROCKET";
const DEFAULT_SHIPMENT_ID = "cmqamlku6000am1qh7amfz3m5";
const DEFAULT_ALTERNATE_PICKUP_LOCATION_ID = "cmq9380sf0002m1akjbwmbkm8";
const LOCAL_API_HINT = "local API unavailable. Start backend with npm run dev and set SHIPMASTR_API_BASE_URL=http://localhost:8080/api/shipping";

function assertToken(token) {
  if (!token) {
    throw new Error("SHIPMASTR_TOKEN is required. The script does not print or store this token.");
  }
  return token;
}

function assertConfirmFlag(value) {
  if (String(value || "").trim() !== "1") {
    throw new Error("PILOT_6H_CONFIRM_ALTERNATE_PICKUP=1 is required. Confirmation is explicit and never automatic.");
  }
}

function assertTrialId(value) {
  const trialId = String(value || "").trim();
  if (!trialId) {
    throw new Error("PILOT_6H_ALTERNATE_PICKUP_TRIAL_ID is required.");
  }
  return trialId;
}

function runtimeFromEnv(env = process.env) {
  assertConfirmFlag(env.PILOT_6H_CONFIRM_ALTERNATE_PICKUP);
  return {
    token: assertToken(env.SHIPMASTR_TOKEN),
    apiBase: (env.SHIPMASTR_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    providerKey: env.PILOT_6H_PROVIDER_KEY || DEFAULT_PROVIDER_KEY,
    shipmentId: env.PILOT_6H_SHIPMENT_ID || DEFAULT_SHIPMENT_ID,
    alternatePickupLocationId: env.PILOT_6H_ALTERNATE_PICKUP_LOCATION_ID || DEFAULT_ALTERNATE_PICKUP_LOCATION_ID,
    alternatePickupTrialId: assertTrialId(env.PILOT_6H_ALTERNATE_PICKUP_TRIAL_ID)
  };
}

function safeLine(value) {
  return String(value ?? "unknown").replace(/[\r\n]+/g, " ").slice(0, 180);
}

function safeList(values) {
  if (!Array.isArray(values) || values.length === 0) return ["none"];
  return values.map((value) => safeLine(value)).filter(Boolean).slice(0, 12);
}

function renderReport(runtime, result) {
  const lines = [
    "Pilot Run 6H alternate pickup confirmation:",
    `  provider: ${safeLine(result?.provider_key || runtime.providerKey)}`,
    `  shipment id: ${safeLine(result?.shipment_id || runtime.shipmentId)}`,
    `  previous pickup id: ${safeLine(result?.previous_pickup_location_id)}`,
    `  confirmed pickup id: ${safeLine(result?.confirmed_pickup_location_id || runtime.alternatePickupLocationId)}`,
    `  confirmed pickup pincode: ${safeLine(result?.confirmed_pickup_pincode)}`,
    `  status: ${safeLine(result?.status)}`,
    `  requires rate refresh: ${result?.requires_rate_refresh === true ? "yes" : "no"}`,
    `  success: ${result?.success === true ? "yes" : "no"}`,
    "  blockers:"
  ];
  for (const blocker of safeList(result?.blockers)) lines.push(`    - ${blocker}`);
  lines.push("  next actions:");
  for (const action of safeList(result?.admin_next_actions || result?.next_actions)) lines.push(`    - ${action}`);
  lines.push("  final recommendation: Refresh confirmed-pickup rates before any AWB, label, tracking, or Ship Now action.");
  return lines.join("\n");
}

function endpointPath(runtime) {
  return `/courier-pickup-trials/providers/${encodeURIComponent(runtime.providerKey)}/shipments/${encodeURIComponent(runtime.shipmentId)}/confirm`;
}

function requestBody(runtime) {
  return {
    pickup_location_id: runtime.alternatePickupLocationId,
    trial_id: runtime.alternatePickupTrialId,
    operator_note: "Pilot Run 6H alternate pickup confirmation"
  };
}

async function run(env = process.env) {
  const runtime = runtimeFromEnv(env);
  const response = await fetch(`${runtime.apiBase}${endpointPath(runtime)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody(runtime))
  }).catch((error) => {
    throw new Error(`${LOCAL_API_HINT}. ${error.message}`);
  });

  if (!response.ok && response.status !== 409) {
    throw new Error(`local API returned ${response.status} for alternate pickup confirmation`);
  }

  const body = await response.json();
  const data = body?.data ?? body;
  console.log(renderReport(runtime, data));
  if (!data?.success) process.exitCode = 2;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Pilot Run 6H alternate pickup confirmation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_API_BASE_URL,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_SHIPMENT_ID,
  DEFAULT_ALTERNATE_PICKUP_LOCATION_ID,
  assertToken,
  assertConfirmFlag,
  assertTrialId,
  runtimeFromEnv,
  endpointPath,
  requestBody,
  renderReport,
  run
};
