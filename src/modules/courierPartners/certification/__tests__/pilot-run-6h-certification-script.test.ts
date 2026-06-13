import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const scriptHelpers = require("../../../../../scripts/pilot-run-6h-certification-check.cjs");

describe("Pilot Run 6H certification check script", () => {
  it("calls local readiness endpoints only and does not invoke Ship Now or providers", () => {
    const script = readFileSync("scripts/pilot-run-6h-certification-check.cjs", "utf8");
    assert.match(script, /SHIPMASTR_TOKEN/);
    assert.match(script, /http:\/\/localhost:8080\/api\/shipping/);
    assert.match(script, /courier-certification\/summary/);
    assert.match(script, /courier-certification\/providers\/SHIPROCKET/);
    assert.match(script, /courier-live-readiness\/providers\/SHIPROCKET\/pickups/);
    assert.match(script, /courier-pickup-serviceability\/providers\/SHIPROCKET\/shipments/);
    assert.match(script, /pickup-learning\/providers\/SHIPROCKET\/shipments/);
    assert.match(script, /courier-arbitration\/shipments/);
    assert.match(script, /awb-certification\/providers\/SHIPROCKET\/shipments/);
    assert.match(script, /label-certification\/providers\/SHIPROCKET\/shipments/);
    assert.match(script, /courier-pickup-trials\/providers\/SHIPROCKET\/shipments/);
    assert.match(script, /live-ship-readiness/);
    assert.doesNotMatch(script, /ship-now|manifestOrder|createLabel|getLabel|createDraftOrder|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
    assert.doesNotMatch(script, /console\.log\([^)]*token/i);
  });

  it("defaults to the local 8080 shipping API base URL", () => {
    assert.equal(scriptHelpers.DEFAULT_API_BASE_URL, "http://localhost:8080/api/shipping");
    const runtime = scriptHelpers.runtimeFromEnv({ SHIPMASTR_TOKEN: "test-token" });
    assert.equal(runtime.apiBase, "http://localhost:8080/api/shipping");
    assert.equal(runtime.trialPickupLocationId, "");
  });

  it("fails closed when SHIPMASTR_TOKEN is missing", () => {
    assert.throws(
      () => scriptHelpers.runtimeFromEnv({}),
      /SHIPMASTR_TOKEN is required/
    );
  });

  it("filters blockers to the selected Shiprocket provider and shipment readiness", () => {
    const blockers = scriptHelpers.providerScopedBlockers({
      summary: {
        blockers: ["PROVIDER_CREDENTIALS_MISSING", "UNRELATED_GLOBAL_BLOCKER"]
      },
      provider: {
        blockers: ["PROVIDER_RATES_NOT_LIVE"]
      },
      pickup: {
        blockers: ["SHIPROCKET_LIVE_PICKUP_UNAVAILABLE"]
      },
      pickupServiceability: {
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"]
      },
      liveShipReadiness: {
        blockers: ["LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED"]
      }
    });
    assert.deepEqual(blockers, [
      "PROVIDER_RATES_NOT_LIVE",
      "SHIPROCKET_LIVE_PICKUP_UNAVAILABLE",
      "PROVIDER_PICKUP_UNAVAILABLE",
      "LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED"
    ]);
  });

  it("prints rate context action when pickup is aligned but selected live rate pickup is unavailable", () => {
    const action = scriptHelpers.rateContextAction({
      provider: {
        dimensions: [{ key: "PICKUPS", status: "PASS" }]
      },
      pickup: {
        provider_pickup_pincode_match: true
      },
      liveShipReadiness: {
        selected_rate: { pickup_available: false }
      }
    });
    assert.equal(action, "Re-fetch live rates for this shipment after pickup alignment, then rerun this check.");
  });

  it("prints no-eligible rate context action when latest refresh has no eligible rates", () => {
    const action = scriptHelpers.rateContextAction({
      provider: {
        dimensions: [{ key: "PICKUPS", status: "PASS" }]
      },
      pickup: {
        provider_pickup_pincode_match: true
      },
      liveShipReadiness: {
        latest_rate_refresh: {
          status: "NO_ELIGIBLE_SHIPPING_RATES",
          eligible_rate_count: 0,
          rejected_rate_reasons: [{ safe_reason: "PICKUP_UNAVAILABLE", count: 3 }]
        },
        selected_rate: {
          latest_refresh_status: "NO_ELIGIBLE_SHIPPING_RATES",
          stale_selected_rate_ignored: true
        }
      }
    });
    assert.equal(
      action,
      "No eligible Shipmastr shipping option is available for this pickup right now. Fix pickup/serviceability or try another pickup, then refresh rates again."
    );
  });

  it("renders provider-scoped output without secrets, auth headers, global blockers, or provider dashboard calls", () => {
    const report = scriptHelpers.renderReport({
      runtime: {
        apiBase: "http://localhost:8080/api/shipping",
        shipmentId: "shipment_1",
        pickupLocationId: "pickup_201301",
        trialPickupLocationId: "pickup_122001"
      },
      summary: {
        counts: { total: 3, live_ready: 0, pilot_ready: 1, dry_run_ready: 2, blocked: 1 },
        blockers: ["PROVIDER_CREDENTIALS_MISSING"]
      },
      provider: {
        public_network_name: "Shipmastr Courier Network",
        blockers: ["PROVIDER_RATES_NOT_LIVE"],
        next_actions: ["Fetch pilot live rates for this shipment."],
        dimensions: [
          { key: "CREDENTIALS", status: "PASS" },
          { key: "PICKUPS", status: "PASS" },
          { key: "SERVICEABILITY", status: "PASS" },
          { key: "RATES", status: "FAIL" },
          { key: "COURIER_ID_MAPPING", status: "FAIL" },
          { key: "AWB", status: "WARN" },
          { key: "LABEL", status: "WARN" },
          { key: "TRACKING", status: "NOT_RUN" }
        ]
      },
      pickup: {
        selected_context: "explicit_pickup",
        selected_shipmastr_pickup: { pickup_location_id: "pickup_201301", pincode: "201301" },
        provider_pickup_pincode_match: true,
        pickups: [{ pincode: "201301", active: true }],
        blockers: []
      },
      pickupServiceability: {
        status: "PICKUP_UNAVAILABLE",
        latest_rate_context: {
          pickup_available_count: 0,
          delivery_available_count: 3,
          numeric_courier_id_count: 3
        },
        recommended_action: "TRY_ALTERNATE_PICKUP",
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"],
        next_actions: ["Run a controlled rate refresh with another active pickup location."]
      },
      pickupLearning: {
        status: "UNAVAILABLE",
        availability_score: 0,
        observation_count: 3,
        recommendation: "TRY_ALTERNATE_PICKUP"
      },
      arbitration: {
        requested_capability: "AWB",
        decision: "RUN_PICKUP_TRIAL",
        selected_option: { pickup_location_id: "pickup_122001" },
        evaluated_options: [{ status: "BLOCKED" }, { status: "TRIAL_REQUIRED" }],
        admin_next_actions: ["Run a controlled alternate pickup trial. Do not Ship Now until the trial and certification pass."]
      },
      awbSandbox: {
        dry_run_ready: false,
        live_one_shot_ready: false,
        status: "BLOCKED",
        blockers: ["AWB_CERTIFICATION_PICKUP_UNAVAILABLE", "AWB_CERTIFICATION_ONE_SHOT_APPROVAL_REQUIRED"],
        admin_next_actions: ["Try another pickup location before attempting AWB certification."]
      },
      labelSandbox: {
        dry_run_ready: false,
        live_one_shot_ready: false,
        status: "MISSING_AWB",
        blockers: ["LABEL_CERTIFICATION_AWB_MISSING"],
        admin_next_actions: ["Complete AWB certification before attempting label certification."]
      },
      pickupTrial: {
        status: "DRY_RUN_ONLY",
        rate_context: {
          eligible_count: 0,
          pickup_available_count: 0
        }
      },
      liveShipReadiness: {
        ready: false,
        runtime: { enabled: true, mode: "LIVE" },
        live_awb_one_shot: { allowed_shipment_matched: true, approval_present: false },
        selected_rate: {
          live_ready: false,
          pickup_available: false,
          stale_selected_rate_ignored: true,
          latest_refresh_status: "NO_ELIGIBLE_SHIPPING_RATES"
        },
        latest_rate_refresh: {
          status: "NO_ELIGIBLE_SHIPPING_RATES",
          eligible_rate_count: 0,
          rejected_rate_reasons: [{ safe_reason: "PICKUP_UNAVAILABLE", count: 3 }],
          provider_pickup_available_any: false,
          stale_selected_rate_ignored: true
        },
        blockers: ["PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES", "LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED"]
      }
    });
    assert.match(report, /Provider-scoped blockers:/);
    assert.match(report, /Rates:/);
    assert.match(report, /Pickup serviceability:/);
    assert.match(report, /Pickup learning:/);
    assert.match(report, /Arbitration:/);
    assert.match(report, /AWB certification sandbox:/);
    assert.match(report, /Label certification sandbox:/);
    assert.match(report, /Alternate pickup trial:/);
    assert.match(report, /latest refresh: NO_ELIGIBLE_SHIPPING_RATES/);
    assert.match(report, /eligible rate count: 0/);
    assert.match(report, /stale selected rate ignored: true/);
    assert.match(report, /status: PICKUP_UNAVAILABLE/);
    assert.match(report, /status: DRY_RUN_ONLY/);
    assert.match(report, /pickup available candidates: 0/);
    assert.match(report, /recommended action: TRY_ALTERNATE_PICKUP/);
    assert.match(report, /availability score: 0/);
    assert.match(report, /recommendation: TRY_ALTERNATE_PICKUP/);
    assert.match(report, /Pickup learning recommends: TRY_ALTERNATE_PICKUP/);
    assert.match(report, /decision: RUN_PICKUP_TRIAL/);
    assert.match(report, /dry-run ready: false/);
    assert.match(report, /live one-shot ready: false/);
    assert.match(report, /AWB_CERTIFICATION_PICKUP_UNAVAILABLE/);
    assert.match(report, /LABEL_CERTIFICATION_AWB_MISSING/);
    assert.match(report, /next action: Run a controlled alternate pickup trial/);
    assert.match(report, /POST http:\/\/localhost:8080\/api\/shipping\/courier-pickup-trials\/providers\/SHIPROCKET\/shipments\/shipment_1/);
    assert.match(report, /PROVIDER_RATES_NOT_LIVE/);
    assert.match(report, /PROVIDER_LATEST_RATE_REFRESH_NO_ELIGIBLE_RATES/);
    assert.match(report, /PROVIDER_PICKUP_UNAVAILABLE/);
    assert.match(report, /LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED/);
    assert.match(report, /Rate context action:/);
    assert.match(report, /No eligible Shipmastr shipping option is available for this pickup right now/);
    assert.doesNotMatch(report, /provider pickup\/serviceability/i);
    assert.doesNotMatch(report, /PROVIDER_CREDENTIALS_MISSING|UNRELATED_GLOBAL_BLOCKER/);
    assert.doesNotMatch(report, /test-token|password|secret|Authorization|Bearer|app\.shiprocket\.in|ship-now/i);
  });

  it("keeps local API outage guidance actionable", () => {
    assert.match(scriptHelpers.LOCAL_API_HINT, /Start backend with npm run dev/);
    assert.match(scriptHelpers.LOCAL_API_HINT, /SHIPMASTR_API_BASE_URL=http:\/\/localhost:8080\/api\/shipping/);
  });
});
