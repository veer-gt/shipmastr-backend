#!/usr/bin/env node

const DEFAULT_API_BASE_URL = "http://localhost:8080/api/shipping";
const DEFAULT_PROVIDER_KEY = "SHIPROCKET";
const DEFAULT_SHIPMENT_ID = "cmqamlku6000am1qh7amfz3m5";
const DEFAULT_CONFIRMED_PICKUP_LOCATION_ID = "cmq9380sf0002m1akjbwmbkm8";
const LOCAL_API_HINT = "local API unavailable. Start backend with npm run dev and set SHIPMASTR_API_BASE_URL=http://localhost:8080/api/shipping";

function assertToken(token) {
  if (!token) {
    throw new Error("SHIPMASTR_TOKEN is required. The script does not print or store this token.");
  }
  return token;
}

function assertRefreshFlag(value) {
  if (String(value || "").trim() !== "1") {
    throw new Error("PILOT_6H_RUN_CONFIRMED_PICKUP_RATE_REFRESH=1 is required. Confirmed pickup refresh is explicit and never automatic.");
  }
}

function runtimeFromEnv(env = process.env) {
  assertRefreshFlag(env.PILOT_6H_RUN_CONFIRMED_PICKUP_RATE_REFRESH);
  return {
    token: assertToken(env.SHIPMASTR_TOKEN),
    apiBase: (env.SHIPMASTR_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    providerKey: env.PILOT_6H_PROVIDER_KEY || DEFAULT_PROVIDER_KEY,
    shipmentId: env.PILOT_6H_SHIPMENT_ID || DEFAULT_SHIPMENT_ID,
    confirmedPickupLocationId: env.PILOT_6H_CONFIRMED_PICKUP_LOCATION_ID || DEFAULT_CONFIRMED_PICKUP_LOCATION_ID
  };
}

function safeLine(value) {
  return String(value ?? "unknown").replace(/[\r\n]+/g, " ").slice(0, 180);
}

function safeList(values) {
  if (!Array.isArray(values) || values.length === 0) return ["none"];
  return values.map((value) => safeLine(value)).filter(Boolean).slice(0, 12);
}

function rateLabel(option) {
  const name = option?.public_service_name || option?.publicServiceName || "Shipmastr Smart";
  const amount = option?.amount_paise ?? option?.amountPaise ?? null;
  const eta = option?.estimated_delivery_days ?? option?.estimatedDeliveryDays ?? null;
  const amountText = Number.isFinite(Number(amount)) ? `INR ${(Number(amount) / 100).toFixed(2)}` : "amount pending";
  const etaText = Number.isFinite(Number(eta)) ? `${Number(eta)} day${Number(eta) === 1 ? "" : "s"}` : "ETA pending";
  return `${safeLine(name)} (${amountText}, ${etaText})`;
}

function finalRecommendation(result) {
  if (result?.status === "ELIGIBLE_RATES_FOUND") {
    return "Rerun certification readiness and AWB dry-run. Do not run one-shot AWB until the final gate says ready.";
  }
  return "Keep the shipment in safe review. Try another pickup/provider or fix serviceability before any AWB consideration.";
}

function renderReport(runtime, result) {
  const context = result?.rate_context || {};
  const options = Array.isArray(result?.public_rate_options) ? result.public_rate_options : [];
  const lines = [
    "Pilot Run 6H confirmed pickup rate refresh:",
    `  shipment id: ${safeLine(result?.shipment_id || runtime.shipmentId)}`,
    `  confirmed pickup id: ${safeLine(result?.trial_pickup_location_id || runtime.confirmedPickupLocationId)}`,
    `  refresh status: ${safeLine(result?.status)}`,
    `  candidate count: ${context.candidate_count ?? 0}`,
    `  eligible count: ${context.eligible_count ?? 0}`,
    `  pickup available count: ${context.pickup_available_count ?? 0}`,
    `  delivery available count: ${context.delivery_available_count ?? 0}`,
    `  numeric courier id count: ${context.numeric_courier_id_count ?? 0}`,
    "  public rate options:"
  ];
  const publicOptions = options.map(rateLabel);
  for (const option of publicOptions.length ? publicOptions : ["none"]) lines.push(`    - ${option}`);
  lines.push("  blockers:");
  for (const blocker of safeList(result?.blockers)) lines.push(`    - ${blocker}`);
  lines.push("  next actions:");
  for (const action of safeList(result?.admin_next_actions || result?.next_actions)) lines.push(`    - ${action}`);
  lines.push(`  final recommendation: ${finalRecommendation(result)}`);
  return lines.join("\n");
}

function endpointPath(runtime) {
  return `/courier-pickup-trials/providers/${encodeURIComponent(runtime.providerKey)}/shipments/${encodeURIComponent(runtime.shipmentId)}/confirmed-pickup-rate-refresh`;
}

function requestBody(runtime) {
  return {
    pickup_location_id: runtime.confirmedPickupLocationId,
    mode: "CONFIRMED_PICKUP_REFRESH"
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

  if (!response.ok) {
    throw new Error(`local API returned ${response.status} for confirmed pickup rate refresh`);
  }

  const body = await response.json();
  const data = body?.data ?? body;
  console.log(renderReport(runtime, data));
  if (data?.status !== "ELIGIBLE_RATES_FOUND") process.exitCode = 2;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Pilot Run 6H confirmed pickup rate refresh failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_API_BASE_URL,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_SHIPMENT_ID,
  DEFAULT_CONFIRMED_PICKUP_LOCATION_ID,
  assertToken,
  assertRefreshFlag,
  runtimeFromEnv,
  endpointPath,
  requestBody,
  finalRecommendation,
  renderReport,
  run
};
