#!/usr/bin/env node

const DEFAULT_API_BASE_URL = "http://localhost:8080/api/shipping";
const DEFAULT_PROVIDER_KEY = "SHIPROCKET";
const DEFAULT_SHIPMENT_ID = "cmqamlku6000am1qh7amfz3m5";
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
    pickupLocationId: env.PILOT_6H_PICKUP_LOCATION_ID || ""
  };
}

function safeLine(value) {
  return String(value ?? "unknown").replace(/[\r\n]+/g, " ").slice(0, 180);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function boolText(value) {
  return value === true ? "yes" : "no";
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim()) search.set(key, String(value));
  }
  return search.toString();
}

async function request(runtime, path, options = {}) {
  const response = await fetch(`${runtime.apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  }).catch((error) => {
    throw new Error(`${LOCAL_API_HINT}. ${error.message}`);
  });

  if (!response.ok) {
    throw new Error(`local API returned ${response.status} for ${path}`);
  }
  const body = await response.json();
  return body?.data ?? body;
}

function readinessRequestPlan(runtime) {
  const scoped = query({
    pickup_location_id: runtime.pickupLocationId,
    requested_capability: "AWB"
  });
  const shipmentScoped = scoped ? `?${scoped}` : "";
  return {
    certificationSummary: `/courier-certification/summary${query({ shipment_id: runtime.shipmentId, pickup_location_id: runtime.pickupLocationId }) ? `?${query({ shipment_id: runtime.shipmentId, pickup_location_id: runtime.pickupLocationId })}` : ""}`,
    providerCertification: `/courier-certification/providers/${encodeURIComponent(runtime.providerKey)}${query({ shipment_id: runtime.shipmentId, pickup_location_id: runtime.pickupLocationId, include_pickup_probe: true }) ? `?${query({ shipment_id: runtime.shipmentId, pickup_location_id: runtime.pickupLocationId, include_pickup_probe: true })}` : ""}`,
    pickupServiceability: `/courier-pickup-serviceability/providers/${encodeURIComponent(runtime.providerKey)}/shipments/${encodeURIComponent(runtime.shipmentId)}${shipmentScoped}`,
    awbDryRun: `/awb-certification/providers/${encodeURIComponent(runtime.providerKey)}/shipments/${encodeURIComponent(runtime.shipmentId)}/dry-run`,
    labelDryRun: `/label-certification/providers/${encodeURIComponent(runtime.providerKey)}/shipments/${encodeURIComponent(runtime.shipmentId)}/dry-run`,
    trackingDryRun: `/tracking-certification/providers/${encodeURIComponent(runtime.providerKey)}/shipments/${encodeURIComponent(runtime.shipmentId)}/dry-run`,
    readinessAutopilot: `/provider-readiness-autopilot/shipments/${encodeURIComponent(runtime.shipmentId)}/providers/${encodeURIComponent(runtime.providerKey)}${query({ pickup_location_id: runtime.pickupLocationId, requested_capability: "AWB", include_arbitration: true }) ? `?${query({ pickup_location_id: runtime.pickupLocationId, requested_capability: "AWB", include_arbitration: true })}` : ""}`,
    certifiedRouting: `/certified-provider-routing/shipments/${encodeURIComponent(runtime.shipmentId)}${query({ pickup_location_id: runtime.pickupLocationId, requested_capability: "AWB", requested_outcome: "DEFAULT_SMART" }) ? `?${query({ pickup_location_id: runtime.pickupLocationId, requested_capability: "AWB", requested_outcome: "DEFAULT_SMART" })}` : ""}`
  };
}

function collectBlockers(input) {
  return unique([
    ...(input.providerCertification?.provider?.blockers ?? input.providerCertification?.blockers ?? []),
    ...(input.pickupServiceability?.blockers ?? []),
    ...(input.awbDryRun?.blockers ?? []),
    ...(input.labelDryRun?.blockers ?? []),
    ...(input.trackingDryRun?.blockers ?? []),
    ...(input.readinessAutopilot?.blockers ?? []),
    ...(input.certifiedRouting?.blockers ?? [])
  ]);
}

function computeGate(input) {
  const ratesReady = input.certifiedRouting?.readiness?.rates_ready === true
    || input.readinessAutopilot?.capabilities?.rates === "READY";
  const pickupAvailable = input.pickupServiceability?.status !== "PICKUP_UNAVAILABLE"
    && input.certifiedRouting?.readiness?.pickup_available === true;
  const awbDryRunReady = input.awbDryRun?.dry_run_ready === true;
  const awbLiveOneShotReady = input.awbDryRun?.live_one_shot_ready === true;
  const labelDryRunReady = input.labelDryRun?.dry_run_ready === true;
  const trackingDryRunReady = input.trackingDryRun?.dry_run_ready === true;
  const certifiedRoutingDecision = input.certifiedRouting?.decision ?? "unknown";
  const blockers = collectBlockers(input);
  if (!ratesReady) blockers.push("ONE_SHOT_GATE_RATES_NOT_READY");
  if (!pickupAvailable) blockers.push("ONE_SHOT_GATE_PICKUP_UNAVAILABLE");
  if (!awbDryRunReady) blockers.push("ONE_SHOT_GATE_AWB_DRY_RUN_NOT_READY");
  if (!awbLiveOneShotReady) blockers.push("ONE_SHOT_GATE_AWB_ONE_SHOT_NOT_READY");
  if (!labelDryRunReady) blockers.push("ONE_SHOT_GATE_LABEL_DRY_RUN_NOT_READY");
  if (!trackingDryRunReady) blockers.push("ONE_SHOT_GATE_TRACKING_DRY_RUN_NOT_READY");
  const ready = ratesReady
    && pickupAvailable
    && awbDryRunReady
    && awbLiveOneShotReady
    && labelDryRunReady
    && trackingDryRunReady
    && ["AWB_READY", "ROUTE_READY"].includes(certifiedRoutingDecision);
  if (!["AWB_READY", "ROUTE_READY"].includes(certifiedRoutingDecision)) {
    blockers.push("ONE_SHOT_GATE_CERTIFIED_ROUTING_NOT_READY");
  }
  return {
    ratesReady,
    pickupAvailable,
    awbDryRunReady,
    awbLiveOneShotReady,
    labelDryRunReady,
    trackingDryRunReady,
    certifiedRoutingDecision,
    ready,
    blockers: unique(blockers)
  };
}

function commandTemplate(runtime) {
  return [
    `SHIPMASTR_API_BASE_URL="${runtime.apiBase}" \\`,
    `SHIPMASTR_TOKEN="<SHIPMASTR_ADMIN_TOKEN>" \\`,
    `ONE_SHOT_TOKEN="<ONE_SHOT_TOKEN>" \\`,
    "curl -sS \\",
    `  -X POST "${runtime.apiBase}/awb-certification/providers/${encodeURIComponent(runtime.providerKey)}/shipments/${encodeURIComponent(runtime.shipmentId)}/live-one-shot" \\`,
    "  -H \"Authorization: Bearer <SHIPMASTR_ADMIN_TOKEN>\" \\",
    "  -H \"x-shipmastr-live-awb-approval: <ONE_SHOT_TOKEN>\" \\",
    "  -H \"Content-Type: application/json\" \\",
    `  -d '{"pickup_location_id":"${runtime.pickupLocationId}","requested_tier":"smart"}'`
  ].join("\n");
}

function renderReport(runtime, gate) {
  const lines = [
    "Pilot Run 6H one-shot readiness gate:",
    `  shipment id: ${safeLine(runtime.shipmentId)}`,
    `  pickup id: ${safeLine(runtime.pickupLocationId || "current shipment pickup")}`,
    `  provider: ${safeLine(runtime.providerKey)}`,
    `  rates ready: ${boolText(gate.ratesReady)}`,
    `  pickup available: ${boolText(gate.pickupAvailable)}`,
    `  awb dry-run ready: ${boolText(gate.awbDryRunReady)}`,
    `  awb live one-shot ready: ${boolText(gate.awbLiveOneShotReady)}`,
    `  label dry-run ready: ${boolText(gate.labelDryRunReady)}`,
    `  tracking dry-run ready: ${boolText(gate.trackingDryRunReady)}`,
    `  certified routing decision: ${safeLine(gate.certifiedRoutingDecision)}`,
    "  final gate:",
    `    READY_FOR_AWB_ONE_SHOT: ${gate.ready ? "yes" : "no"}`,
    "  blockers:"
  ];
  for (const blocker of gate.blockers.length ? gate.blockers : ["none"]) lines.push(`    - ${safeLine(blocker)}`);
  lines.push("  required env:");
  lines.push("    - SHIPMASTR_TOKEN=<SHIPMASTR_ADMIN_TOKEN>");
  lines.push("    - ONE_SHOT_TOKEN=<ONE_SHOT_TOKEN>");
  lines.push("  required header:");
  lines.push("    - x-shipmastr-live-awb-approval: <ONE_SHOT_TOKEN>");
  if (gate.ready) {
    lines.push("  command template:");
    lines.push(commandTemplate(runtime).split("\n").map((line) => `    ${line}`).join("\n"));
  } else {
    lines.push("  command template: not printed because the gate is not ready");
    lines.push("  next safe action: resolve blockers, rerun dry-run checks, and do not run live one-shot yet.");
  }
  return lines.join("\n");
}

async function run(env = process.env) {
  let runtime = runtimeFromEnv(env);
  const shipment = await request(runtime, `/shipments/${encodeURIComponent(runtime.shipmentId)}`);
  const detectedPickupLocationId = shipment?.pickup_location_id ?? shipment?.pickupLocationId ?? "";
  if (!runtime.pickupLocationId && detectedPickupLocationId) {
    runtime = { ...runtime, pickupLocationId: detectedPickupLocationId };
  }
  const plan = readinessRequestPlan(runtime);
  const [
    certificationSummary,
    providerCertification,
    pickupServiceability,
    awbDryRun,
    labelDryRun,
    trackingDryRun,
    readinessAutopilot,
    certifiedRouting
  ] = await Promise.all([
    request(runtime, plan.certificationSummary),
    request(runtime, plan.providerCertification),
    request(runtime, plan.pickupServiceability),
    request(runtime, plan.awbDryRun, {
      method: "POST",
      body: {
        ...(runtime.pickupLocationId ? { pickup_location_id: runtime.pickupLocationId } : {}),
        requested_tier: "smart"
      }
    }),
    request(runtime, plan.labelDryRun, {
      method: "POST",
      body: {
        ...(runtime.pickupLocationId ? { pickup_location_id: runtime.pickupLocationId } : {})
      }
    }),
    request(runtime, plan.trackingDryRun, {
      method: "POST",
      body: {
        ...(runtime.pickupLocationId ? { pickup_location_id: runtime.pickupLocationId } : {})
      }
    }),
    request(runtime, plan.readinessAutopilot),
    request(runtime, plan.certifiedRouting)
  ]);
  const gate = computeGate({
    certificationSummary,
    providerCertification,
    pickupServiceability,
    awbDryRun,
    labelDryRun,
    trackingDryRun,
    readinessAutopilot,
    certifiedRouting
  });
  console.log(renderReport(runtime, gate));
  if (!gate.ready) process.exitCode = 2;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Pilot Run 6H one-shot readiness gate failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_API_BASE_URL,
  DEFAULT_PROVIDER_KEY,
  DEFAULT_SHIPMENT_ID,
  LOCAL_API_HINT,
  assertToken,
  runtimeFromEnv,
  readinessRequestPlan,
  computeGate,
  commandTemplate,
  renderReport,
  run
};
