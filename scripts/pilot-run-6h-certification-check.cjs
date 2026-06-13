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
    pickupLocationId: env.PILOT_6H_PICKUP_LOCATION_ID || "",
    trialPickupLocationId: env.PILOT_6H_TRIAL_PICKUP_LOCATION_ID || ""
  };
}

function params(runtime, extra = {}, options = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && String(value).trim()) query.set(key, String(value));
  }
  if (options.includeShipmentId !== false && runtime.shipmentId) query.set("shipment_id", runtime.shipmentId);
  if (runtime.pickupLocationId) query.set("pickup_location_id", runtime.pickupLocationId);
  return query.toString();
}

function shipmentScopedParams(runtime, extra = {}) {
  return params(runtime, extra, { includeShipmentId: false });
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
    ...(input.pickupServiceability?.blockers ?? []),
    ...(input.readinessAutopilot?.blockers ?? []),
    ...(input.certifiedRouting?.blockers ?? []),
    ...(input.liveShipReadiness?.blockers ?? [])
  ]);
}

function providerScopedNextActions(input) {
  return unique([
    ...(input.provider?.next_actions ?? []),
    ...(input.provider?.nextActions ?? []),
    ...(input.pickupServiceability?.next_actions ?? []),
    ...(input.pickupLearning?.recommendation ? [`Pickup learning recommends: ${input.pickupLearning.recommendation}`] : []),
    ...(input.arbitration?.admin_next_actions ?? []),
    ...(input.arbitration?.next_actions ?? []),
    ...(input.awbSandbox?.admin_next_actions ?? []),
    ...(input.awbSandbox?.next_actions ?? []),
    ...(input.labelSandbox?.admin_next_actions ?? []),
    ...(input.labelSandbox?.next_actions ?? []),
    ...(input.trackingCertification?.admin_next_actions ?? []),
    ...(input.trackingCertification?.next_actions ?? []),
    ...(input.readinessAutopilot?.admin_next_actions ?? []),
    ...(input.certifiedRouting?.admin_next_actions ?? []),
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
    return "No eligible Shipmastr shipping option is available for this pickup right now. Fix pickup/serviceability or try another pickup, then refresh rates again.";
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
  const pickupServiceability = input.pickupServiceability;
  const pickupLearning = input.pickupLearning;
  const arbitration = input.arbitration;
  const awbSandbox = input.awbSandbox;
  const labelSandbox = input.labelSandbox;
  const trackingCertification = input.trackingCertification;
  const readinessAutopilot = input.readinessAutopilot;
  const certifiedRouting = input.certifiedRouting;
  const pickupTrial = input.pickupTrial;
  const liveShipReadiness = input.liveShipReadiness;
  const latestRefresh = liveShipReadiness?.latest_rate_refresh;
  const ratesDimension = dimension(provider, "RATES");
  const labelDimension = dimension(provider, "LABEL");
  const trackingDimension = dimension(provider, "TRACKING");
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
    "Pickup serviceability:",
    `  status: ${pickupServiceability?.status ?? "unknown"}`,
    `  pickup available candidates: ${pickupServiceability?.latest_rate_context?.pickup_available_count ?? "unknown"}`,
    `  delivery available candidates: ${pickupServiceability?.latest_rate_context?.delivery_available_count ?? "unknown"}`,
    `  numeric courier id candidates: ${pickupServiceability?.latest_rate_context?.numeric_courier_id_count ?? "unknown"}`,
    `  recommended action: ${pickupServiceability?.recommended_action ?? "unknown"}`,
    "",
    "Pickup learning:",
    `  status: ${pickupLearning?.status ?? pickupServiceability?.pickup_learning?.status ?? "unknown"}`,
    `  availability score: ${pickupLearning?.availability_score ?? pickupServiceability?.pickup_learning?.availability_score ?? "unknown"}`,
    `  observations: ${pickupLearning?.observation_count ?? pickupServiceability?.pickup_learning?.observation_count ?? "unknown"}`,
    `  recommendation: ${pickupLearning?.recommendation ?? pickupServiceability?.pickup_learning?.recommendation ?? "unknown"}`,
    "",
    "Arbitration:",
    `  requested capability: ${arbitration?.requested_capability ?? "AWB"}`,
    `  decision: ${arbitration?.decision ?? "unknown"}`,
    `  selected option: ${arbitration?.selected_option?.pickup_location_id ?? "none"}`,
    `  evaluated options: ${(arbitration?.evaluated_options ?? []).length}`,
    `  next action: ${(arbitration?.admin_next_actions ?? arbitration?.next_actions ?? [])[0] ?? "unknown"}`,
    "",
    "AWB certification sandbox:",
    `  dry-run ready: ${boolText(awbSandbox?.dry_run_ready)}`,
    `  live one-shot ready: ${boolText(awbSandbox?.live_one_shot_ready)}`,
    `  payload readiness: ${awbSandbox?.status ?? "unknown"}`,
    `  blockers: ${(awbSandbox?.blockers ?? []).length ? awbSandbox.blockers.map(safeLine).join(", ") : "none"}`,
    `  next action: ${(awbSandbox?.admin_next_actions ?? awbSandbox?.next_actions ?? [])[0] ?? "unknown"}`,
    "",
    "Label certification:",
    `  dry-run ready: ${boolText(labelSandbox?.dry_run_ready)}`,
    `  live one-shot ready: ${boolText(labelSandbox?.live_one_shot_ready)}`,
    `  certified: ${boolText(labelDimension?.safe_summary?.live_label_certified === true)}`,
    `  label ready: ${boolText(labelDimension?.status === "PASS")}`,
    `  blockers: ${(labelSandbox?.blockers ?? []).length ? labelSandbox.blockers.map(safeLine).join(", ") : "none"}`,
    `  next action: ${(labelSandbox?.admin_next_actions ?? labelSandbox?.next_actions ?? [])[0] ?? "unknown"}`,
    "",
    "Tracking certification:",
    `  dry-run ready: ${boolText(trackingCertification?.dry_run_ready)}`,
    `  live read ready: ${boolText(trackingCertification?.live_read_ready)}`,
    `  certified: ${boolText(trackingDimension?.safe_summary?.live_tracking_certified === true)}`,
    `  tracking ready: ${boolText(trackingDimension?.status === "PASS")}`,
    `  latest public status: ${trackingDimension?.safe_summary?.latest_public_status ?? "unknown"}`,
    `  blockers: ${(trackingCertification?.blockers ?? []).length ? trackingCertification.blockers.map(safeLine).join(", ") : "none"}`,
    `  next action: ${(trackingCertification?.admin_next_actions ?? trackingCertification?.next_actions ?? [])[0] ?? "unknown"}`,
    "",
    "Provider readiness autopilot:",
    `  lifecycle state: ${readinessAutopilot?.lifecycle_state ?? "unknown"}`,
    `  rates capability: ${readinessAutopilot?.capabilities?.rates ?? "unknown"}`,
    `  awb capability: ${readinessAutopilot?.capabilities?.awb ?? "unknown"}`,
    `  label capability: ${readinessAutopilot?.capabilities?.label ?? "unknown"}`,
    `  tracking capability: ${readinessAutopilot?.capabilities?.tracking ?? "unknown"}`,
    `  next safe action: ${readinessAutopilot?.next_safe_action ?? "unknown"}`,
    `  seller-safe message: ${readinessAutopilot?.seller_safe_message ?? "unknown"}`,
    "",
    "Certified provider routing:",
    `  decision: ${certifiedRouting?.decision ?? "unknown"}`,
    `  selected public tier: ${certifiedRouting?.selected_public_tier ?? "none"}`,
    `  selected pickup: ${certifiedRouting?.selected_pickup_location_id ?? "none"}`,
    `  internal provider selected: ${certifiedRouting?.internal_selection?.provider_key_internal ?? "none"}`,
    `  rates ready: ${boolText(certifiedRouting?.readiness?.rates_ready)}`,
    `  awb ready: ${boolText(certifiedRouting?.readiness?.awb_ready)}`,
    `  label ready: ${boolText(certifiedRouting?.readiness?.label_ready)}`,
    `  tracking ready: ${boolText(certifiedRouting?.readiness?.tracking_ready)}`,
    `  seller-safe message: ${certifiedRouting?.seller_safe_message ?? "unknown"}`,
    `  next action: ${(certifiedRouting?.admin_next_actions ?? [])[0] ?? "unknown"}`,
    "",
    "Alternate pickup trial:",
    `  trial pickup id: ${input.runtime.trialPickupLocationId || "not provided"}`,
    `  status: ${pickupTrial?.status ?? "not run"}`,
    `  eligible rate count: ${pickupTrial?.rate_context?.eligible_count ?? "unknown"}`,
    `  pickup available candidates: ${pickupTrial?.rate_context?.pickup_available_count ?? "unknown"}`,
    `  command: ${input.runtime.trialPickupLocationId
      ? `POST ${input.runtime.apiBase}/courier-pickup-trials/providers/SHIPROCKET/shipments/${input.runtime.shipmentId}`
      : "Set PILOT_6H_TRIAL_PICKUP_LOCATION_ID and run the controlled pickup trial."}`,
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
  const pickupServiceabilityPath = runtime.shipmentId
    ? `/courier-pickup-serviceability/providers/SHIPROCKET/shipments/${encodeURIComponent(runtime.shipmentId)}${shipmentScopedParams(runtime) ? `?${shipmentScopedParams(runtime)}` : ""}`
    : null;
  const pickupLearningPath = runtime.shipmentId
    ? `/pickup-learning/providers/SHIPROCKET/shipments/${encodeURIComponent(runtime.shipmentId)}`
    : null;
  const arbitrationPath = runtime.shipmentId
    ? `/courier-arbitration/shipments/${encodeURIComponent(runtime.shipmentId)}?${shipmentScopedParams(runtime, { provider_key: "SHIPROCKET", requested_capability: "AWB" })}`
    : null;
  const awbSandboxPath = runtime.shipmentId
    ? `/awb-certification/providers/SHIPROCKET/shipments/${encodeURIComponent(runtime.shipmentId)}/dry-run`
    : null;
  const labelSandboxPath = runtime.shipmentId
    ? `/label-certification/providers/SHIPROCKET/shipments/${encodeURIComponent(runtime.shipmentId)}/dry-run`
    : null;
  const trackingCertificationPath = runtime.shipmentId
    ? `/tracking-certification/providers/SHIPROCKET/shipments/${encodeURIComponent(runtime.shipmentId)}/dry-run`
    : null;
  const readinessAutopilotPath = runtime.shipmentId
    ? `/provider-readiness-autopilot/shipments/${encodeURIComponent(runtime.shipmentId)}/providers/SHIPROCKET?${shipmentScopedParams(runtime, {
      requested_capability: "AWB",
      include_arbitration: true
    })}`
    : null;
  const certifiedRoutingPath = runtime.shipmentId
    ? `/certified-provider-routing/shipments/${encodeURIComponent(runtime.shipmentId)}?${shipmentScopedParams(runtime, {
      requested_capability: "AWB",
      requested_outcome: "DEFAULT_SMART"
    })}`
    : null;
  const pickupTrialPath = runtime.shipmentId && runtime.trialPickupLocationId
    ? `/courier-pickup-trials/providers/SHIPROCKET/shipments/${encodeURIComponent(runtime.shipmentId)}`
    : null;

  const [summary, shiprocket, pickup, liveShipReadiness, pickupServiceability, pickupLearning, arbitration, awbSandbox, labelSandbox, trackingCertification, readinessAutopilot, certifiedRouting, pickupTrial] = await Promise.all([
    request(runtime, `/courier-certification/summary${summaryQuery ? `?${summaryQuery}` : ""}`),
    request(runtime, `/courier-certification/providers/SHIPROCKET?${contextQuery}`),
    request(runtime, `/courier-live-readiness/providers/SHIPROCKET/pickups?${params(runtime)}`),
    readinessPath ? request(runtime, readinessPath) : Promise.resolve(null),
    pickupServiceabilityPath ? request(runtime, pickupServiceabilityPath) : Promise.resolve(null),
    pickupLearningPath ? request(runtime, pickupLearningPath) : Promise.resolve(null),
    arbitrationPath ? request(runtime, arbitrationPath) : Promise.resolve(null),
    awbSandboxPath
      ? request(runtime, awbSandboxPath, {
        method: "POST",
        body: {
          ...(runtime.pickupLocationId ? { pickup_location_id: runtime.pickupLocationId } : {}),
          requested_tier: "smart"
        }
      })
      : Promise.resolve(null),
    labelSandboxPath
      ? request(runtime, labelSandboxPath, {
        method: "POST",
        body: {
          ...(runtime.pickupLocationId ? { pickup_location_id: runtime.pickupLocationId } : {})
        }
      })
      : Promise.resolve(null),
    trackingCertificationPath
      ? request(runtime, trackingCertificationPath, {
        method: "POST",
        body: {
          ...(runtime.pickupLocationId ? { pickup_location_id: runtime.pickupLocationId } : {})
        }
      })
      : Promise.resolve(null),
    readinessAutopilotPath ? request(runtime, readinessAutopilotPath) : Promise.resolve(null),
    certifiedRoutingPath ? request(runtime, certifiedRoutingPath) : Promise.resolve(null),
    pickupTrialPath
      ? request(runtime, pickupTrialPath, {
        method: "POST",
        body: {
          pickup_location_id: runtime.trialPickupLocationId,
          mode: "DRY_RUN"
        }
      })
      : Promise.resolve(null)
  ]);

  const report = renderReport({
    runtime,
    summary,
    provider: shiprocket.provider ?? shiprocket,
    pickup,
    pickupServiceability,
    pickupLearning,
    arbitration,
    awbSandbox,
    labelSandbox,
    trackingCertification,
    readinessAutopilot,
    certifiedRouting,
    pickupTrial,
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
  params,
  shipmentScopedParams,
  providerScopedBlockers,
  providerScopedNextActions,
  rateContextAction,
  renderReport,
  run
};
