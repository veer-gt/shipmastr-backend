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

function runtimeFromEnv(env = process.env) {
  return {
    token: assertToken(env.SHIPMASTR_TOKEN),
    apiBase: (env.SHIPMASTR_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    providerKey: env.PILOT_6H_PROVIDER_KEY || DEFAULT_PROVIDER_KEY,
    shipmentId: env.PILOT_6H_SHIPMENT_ID || DEFAULT_SHIPMENT_ID,
    alternatePickupLocationId: env.PILOT_6H_ALTERNATE_PICKUP_LOCATION_ID || DEFAULT_ALTERNATE_PICKUP_LOCATION_ID
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
    return "Review safe public options, then explicitly refresh rates and rerun certification before any shipping action.";
  }
  if (result?.status === "DRY_RUN_ONLY") {
    return "Run a controlled alternate pickup rate refresh. Keep the shipment blocked until eligibility is proven.";
  }
  if (result?.status === "PICKUP_UNAVAILABLE") {
    return "Alternate pickup is not serviceable from available safe evidence. Try another pickup or fix pickup availability.";
  }
  return "Keep shipment in safe review. Do not Ship Now, create AWB, generate labels, or run tracking.";
}

function renderReport(runtime, result) {
  const context = result?.rate_context || result?.rateContext || {};
  const options = Array.isArray(result?.public_rate_options)
    ? result.public_rate_options
    : Array.isArray(result?.publicRateOptions)
      ? result.publicRateOptions
      : [];
  const lines = [
    "Pilot Run 6H alternate pickup trial:",
    `  provider: ${safeLine(runtime.providerKey)}`,
    `  shipment id: ${safeLine(runtime.shipmentId)}`,
    `  alternate pickup id: ${safeLine(runtime.alternatePickupLocationId)}`,
    `  status: ${safeLine(result?.status)}`,
    `  candidate count: ${context.candidate_count ?? context.candidateCount ?? 0}`,
    `  eligible count: ${context.eligible_count ?? context.eligibleCount ?? 0}`,
    `  pickup available count: ${context.pickup_available_count ?? context.pickupAvailableCount ?? 0}`,
    `  delivery available count: ${context.delivery_available_count ?? context.deliveryAvailableCount ?? 0}`,
    `  numeric courier id count: ${context.numeric_courier_id_count ?? context.numericCourierIdCount ?? 0}`,
    "  public rate options:"
  ];
  const publicOptions = options.map(rateLabel);
  for (const option of publicOptions.length ? publicOptions : ["none"]) lines.push(`    - ${option}`);
  lines.push("  blockers:");
  for (const blocker of safeList(result?.blockers)) lines.push(`    - ${blocker}`);
  lines.push("  next actions:");
  for (const action of safeList(result?.admin_next_actions || result?.next_actions || result?.adminNextActions || result?.nextActions)) {
    lines.push(`    - ${action}`);
  }
  lines.push(`  final recommendation: ${finalRecommendation(result)}`);
  return lines.join("\n");
}

async function run(env = process.env) {
  const runtime = runtimeFromEnv(env);
  const path = `/courier-pickup-trials/providers/${encodeURIComponent(runtime.providerKey)}/shipments/${encodeURIComponent(runtime.shipmentId)}`;
  const response = await fetch(`${runtime.apiBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      pickup_location_id: runtime.alternatePickupLocationId,
      mode: "DRY_RUN"
    })
  }).catch((error) => {
    throw new Error(`${LOCAL_API_HINT}. ${error.message}`);
  });

  if (!response.ok) {
    throw new Error(`local API returned ${response.status} for alternate pickup trial`);
  }

  const body = await response.json();
  const data = body?.data ?? body;
  console.log(renderReport(runtime, data));
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Pilot Run 6H alternate pickup trial failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_API_BASE_URL,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_SHIPMENT_ID,
  DEFAULT_ALTERNATE_PICKUP_LOCATION_ID,
  assertToken,
  runtimeFromEnv,
  finalRecommendation,
  renderReport,
  run
};
