#!/usr/bin/env node

const DEFAULT_API_BASE_URL = "http://localhost:8080/api/shipping";
const LOCAL_API_HINT = "local API unavailable. Start backend with npm run dev and set SHIPMASTR_API_BASE_URL=http://localhost:8080/api/shipping";

function fail(message) {
  console.error(`Pilot Run 6H certification check failed: ${message}`);
  process.exit(1);
}

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
    shipmentId: env.PILOT_6H_SHIPMENT_ID || "",
    pickupLocationId: env.PILOT_6H_PICKUP_LOCATION_ID || ""
  };
}

function params(runtime, extra = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && String(value).trim()) query.set(key, String(value));
  }
  if (runtime.shipmentId) query.set("shipment_id", runtime.shipmentId);
  if (runtime.pickupLocationId) query.set("pickup_location_id", runtime.pickupLocationId);
  return query.toString();
}

async function request(runtime, path) {
  const response = await fetch(`${runtime.apiBase}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      Accept: "application/json"
    }
  }).catch((error) => {
    throw new Error(`${LOCAL_API_HINT}. ${error.message}`);
  });

  if (!response.ok) {
    throw new Error(`local API returned ${response.status} for ${path}`);
  }
  const body = await response.json();
  return body?.data ?? body;
}

function dimension(provider, key) {
  return provider?.dimensions?.find((item) => item.key === key) ?? null;
}

function status(provider, key) {
  return dimension(provider, key)?.status ?? "NOT_RUN";
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function providerScopedBlockers(input) {
  return unique([
    ...(input.provider?.blockers ?? []),
    ...(input.pickup?.blockers ?? []),
    ...(input.liveShipReadiness?.blockers ?? [])
  ]);
}

function providerScopedNextActions(input) {
  return unique([
    ...(input.provider?.next_actions ?? []),
    ...(input.provider?.nextActions ?? []),
    ...(input.liveShipReadiness?.certification_decision?.seller_safe_message
      ? [input.liveShipReadiness.certification_decision.seller_safe_message]
      : []),
    ...(rateContextAction(input) ? [rateContextAction(input)] : [])
  ]);
}

function rateContextAction(input) {
  const latestRefresh = input.liveShipReadiness?.latest_rate_refresh;
  const noEligible = latestRefresh?.status === "NO_ELIGIBLE_SHIPPING_RATES"
    || latestRefresh?.status === "PROVIDER_SERVICEABILITY_NO_CANDIDATES"
    || input.liveShipReadiness?.selected_rate?.latest_refresh_status === "NO_ELIGIBLE_SHIPPING_RATES"
    || input.liveShipReadiness?.selected_rate?.latest_refresh_status === "PROVIDER_SERVICEABILITY_NO_CANDIDATES";
  if (noEligible) {
    return "No eligible Shipmastr shipping option is available for this pickup right now. Fix provider pickup/serviceability or try another pickup, then refresh rates again.";
  }
  const pickupAligned = input.pickup?.provider_pickup_pincode_match === true
    || dimension(input.provider, "PICKUPS")?.status === "PASS";
  const ratePickupUnavailable = input.liveShipReadiness?.selected_rate?.pickup_available === false;
  if (pickupAligned && ratePickupUnavailable) {
    return "Re-fetch live rates for this shipment after pickup alignment, then rerun this check.";
  }
  return null;
}

function boolText(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "unknown";
}

function yesNoText(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function countRejectedReason(latestRefresh, reason) {
  const rows = Array.isArray(latestRefresh?.rejected_rate_reasons) ? latestRefresh.rejected_rate_reasons : [];
  return rows
    .filter((row) => row?.safe_reason === reason)
    .reduce((sum, row) => sum + (Number.isFinite(Number(row.count)) ? Number(row.count) : 0), 0);
}

function safeLine(value) {
  return String(value ?? "unknown").replace(/[\r\n]+/g, " ").slice(0, 180);
}

function renderSafeList(title, values) {
  const lines = [`${title}:`];
  if (!values.length) {
    lines.push("  none");
    return lines;
  }
  for (const value of values) lines.push(`  - ${safeLine(value)}`);
  return lines;
}

function renderReport(input) {
  const provider = input.provider;
  const pickup = input.pickup;
  const liveShipReadiness = input.liveShipReadiness;
  const latestRefresh = liveShipReadiness?.latest_rate_refresh;
  const ratesDimension = dimension(provider, "RATES");
  const pickupUnavailableCount = countRejectedReason(latestRefresh, "PICKUP_UNAVAILABLE");
  const readyForLiveShipNow = Boolean(liveShipReadiness?.ready);
  const blockers = providerScopedBlockers(input);
  const nextActions = providerScopedNextActions(input);
  const rateAction = rateContextAction(input);

  const lines = [
    "Certification summary:",
    `  total providers: ${input.summary?.counts?.total ?? "unknown"}`,
    `  live ready: ${input.summary?.counts?.live_ready ?? "unknown"}`,
    `  pilot ready: ${input.summary?.counts?.pilot_ready ?? "unknown"}`,
    `  dry-run ready: ${input.summary?.counts?.dry_run_ready ?? "unknown"}`,
    `  blocked: ${input.summary?.counts?.blocked ?? "unknown"}`,
    "",
    "Selected provider:",
    "  provider: SHIPROCKET",
    `  public network: ${provider?.public_network_name ?? "Shipmastr Courier Network"}`,
    "",
    "Selected shipment:",
    `  shipment id: ${input.runtime.shipmentId || "not provided"}`,
    `  pickup location id: ${input.runtime.pickupLocationId || pickup?.selected_shipmastr_pickup?.pickup_location_id || "not provided"}`,
    "",
    "Shiprocket:",
    `  credentials: ${status(provider, "CREDENTIALS")}`,
    `  pickup: ${status(provider, "PICKUPS")}`,
    `  serviceability: ${status(provider, "SERVICEABILITY")}`,
    `  rates: ${status(provider, "RATES")}`,
    `  courier id mapping: ${status(provider, "COURIER_ID_MAPPING")}`,
    `  awb: ${status(provider, "AWB")}`,
    `  label: ${status(provider, "LABEL")}`,
    `  tracking: ${status(provider, "TRACKING")}`,
    "",
    "Rates:",
    `  status: ${status(provider, "RATES")}`,
    `  latest refresh: ${latestRefresh?.status ?? ratesDimension?.safe_summary?.latest_refresh_status ?? "unknown"}`,
    `  eligible rate count: ${latestRefresh?.eligible_rate_count ?? ratesDimension?.safe_summary?.eligible_rate_count ?? "unknown"}`,
    `  pickup unavailable candidates: ${pickupUnavailableCount || yesNoText(latestRefresh?.provider_pickup_available_any === false ? true : null)}`,
    `  stale selected rate ignored: ${boolText(liveShipReadiness?.selected_rate?.stale_selected_rate_ignored ?? latestRefresh?.stale_selected_rate_ignored)}`,
    "",
    "Pickup context:",
    `  selected context: ${pickup?.selected_context ?? "unknown"}`,
    `  selected pickup pincode: ${pickup?.selected_shipmastr_pickup?.pincode ?? "unknown"}`,
    `  provider pickup pincode match: ${boolText(pickup?.provider_pickup_pincode_match)}`,
    `  provider pickup active: ${boolText((pickup?.pickups ?? []).find((item) => item.pincode === pickup?.selected_shipmastr_pickup?.pincode)?.active)}`,
    "",
    "Live Ship Now gate:",
    `  enabled: ${boolText(liveShipReadiness?.runtime?.enabled)}`,
    `  mode: ${liveShipReadiness?.runtime?.mode ?? "unknown"}`,
    `  allowed shipment matched: ${boolText(liveShipReadiness?.live_awb_one_shot?.allowed_shipment_matched)}`,
    `  approval present: ${boolText(liveShipReadiness?.live_awb_one_shot?.approval_present)}`,
    `  selected rate live ready: ${boolText(liveShipReadiness?.selected_rate?.live_ready)}`,
    `  selected rate pickup available: ${boolText(liveShipReadiness?.selected_rate?.pickup_available)}`,
    "",
    "Final decision:",
    `  READY_FOR_LIVE_SHIP_NOW: ${readyForLiveShipNow ? "yes" : "no"}`,
    "",
    ...renderSafeList("Provider-scoped blockers", blockers),
    "",
    ...renderSafeList("Provider-scoped next actions", nextActions)
  ];

  if (rateAction) {
    lines.push("", "Rate context action:", `  ${rateAction}`);
  }

  return lines.join("\n");
}

async function run(env = process.env) {
  const runtime = runtimeFromEnv(env);
  const contextQuery = params(runtime, { include_pickup_probe: true });
  const summaryQuery = params(runtime);
  const readinessPath = runtime.shipmentId ? `/shipments/${encodeURIComponent(runtime.shipmentId)}/live-ship-readiness` : null;

  const [summary, shiprocket, pickup, liveShipReadiness] = await Promise.all([
    request(runtime, `/courier-certification/summary${summaryQuery ? `?${summaryQuery}` : ""}`),
    request(runtime, `/courier-certification/providers/SHIPROCKET?${contextQuery}`),
    request(runtime, `/courier-live-readiness/providers/SHIPROCKET/pickups?${params(runtime)}`),
    readinessPath ? request(runtime, readinessPath) : Promise.resolve(null)
  ]);

  const report = renderReport({
    runtime,
    summary,
    provider: shiprocket.provider ?? shiprocket,
    pickup,
    liveShipReadiness
  });
  console.log(report);
  if (!liveShipReadiness?.ready) process.exitCode = 2;
}

if (require.main === module) {
  run().catch((error) => {
    fail(error.message);
  });
}

module.exports = {
  DEFAULT_API_BASE_URL,
  LOCAL_API_HINT,
  assertToken,
  runtimeFromEnv,
  providerScopedBlockers,
  providerScopedNextActions,
  rateContextAction,
  renderReport,
  run
};
