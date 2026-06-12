#!/usr/bin/env node

const token = process.env.SHIPMASTR_TOKEN;
const apiBase = (process.env.SHIPMASTR_API_BASE_URL || "http://localhost:4000/api/shipping").replace(/\/+$/, "");
const shipmentId = process.env.PILOT_6H_SHIPMENT_ID || "";
const pickupLocationId = process.env.PILOT_6H_PICKUP_LOCATION_ID || "";

function fail(message) {
  console.error(`Pilot Run 6H certification check failed: ${message}`);
  process.exit(1);
}

if (!token) {
  fail("SHIPMASTR_TOKEN is required. The script does not print or store this token.");
}

function params(extra = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && String(value).trim()) query.set(key, String(value));
  }
  if (shipmentId) query.set("shipment_id", shipmentId);
  if (pickupLocationId) query.set("pickup_location_id", pickupLocationId);
  return query.toString();
}

async function request(path) {
  const response = await fetch(`${apiBase}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  }).catch((error) => {
    throw new Error(`local API unavailable: ${error.message}`);
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

function collectBlockers(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : []))];
}

function printProvider(provider) {
  console.log("Shiprocket:");
  console.log(`  credentials: ${status(provider, "CREDENTIALS")}`);
  console.log(`  pickup: ${status(provider, "PICKUPS")}`);
  console.log(`  rates: ${status(provider, "RATES")}`);
  console.log(`  awb: ${status(provider, "AWB")}`);
  console.log(`  label: ${status(provider, "LABEL")}`);
  console.log(`  tracking: ${status(provider, "TRACKING")}`);
}

function printSafeList(title, values) {
  console.log(`${title}:`);
  if (!values.length) {
    console.log("  none");
    return;
  }
  for (const value of values) console.log(`  - ${String(value).slice(0, 160)}`);
}

(async () => {
  const contextQuery = params({ include_pickup_probe: true });
  const summaryQuery = params();
  const readinessPath = shipmentId ? `/shipments/${encodeURIComponent(shipmentId)}/live-ship-readiness` : null;

  const [summary, shiprocket, pickupDiagnostics, liveShipReadiness] = await Promise.all([
    request(`/courier-certification/summary${summaryQuery ? `?${summaryQuery}` : ""}`),
    request(`/courier-certification/providers/SHIPROCKET?${contextQuery}`),
    request(`/courier-live-readiness/providers/SHIPROCKET/pickups?${params()}`),
    readinessPath ? request(readinessPath) : Promise.resolve(null)
  ]);

  const provider = shiprocket.provider ?? shiprocket;
  const pickup = pickupDiagnostics.pickup_diagnostics ?? pickupDiagnostics;
  const blockers = collectBlockers(
    summary.blockers,
    provider.blockers,
    pickup.blockers,
    liveShipReadiness?.blockers
  );
  const nextActions = collectBlockers(
    summary.next_actions,
    provider.next_actions,
    liveShipReadiness?.certification_decision?.seller_safe_message
      ? [liveShipReadiness.certification_decision.seller_safe_message]
      : []
  );
  const readyForLiveShipNow = Boolean(liveShipReadiness?.ready);

  console.log("Certification summary:");
  console.log(`  total providers: ${summary.counts?.total ?? "unknown"}`);
  console.log(`  live ready: ${summary.counts?.live_ready ?? "unknown"}`);
  console.log(`  pilot ready: ${summary.counts?.pilot_ready ?? "unknown"}`);
  console.log(`  dry-run ready: ${summary.counts?.dry_run_ready ?? "unknown"}`);
  console.log(`  blocked: ${summary.counts?.blocked ?? "unknown"}`);
  printProvider(provider);
  console.log("Pickup context:");
  console.log(`  selected context: ${pickup.selected_context ?? "unknown"}`);
  console.log(`  pincode match: ${pickup.provider_pickup_pincode_match ?? "unknown"}`);
  console.log("Final decision:");
  console.log(`  READY_FOR_LIVE_SHIP_NOW: ${readyForLiveShipNow ? "yes" : "no"}`);
  printSafeList("Blockers", blockers);
  printSafeList("Next actions", nextActions);

  if (!readyForLiveShipNow) process.exitCode = 2;
})().catch((error) => {
  fail(error.message);
});
