import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const trialScript = require("../../../../../scripts/pilot-run-6h-alternate-pickup-trial.cjs");

function scriptSource() {
  return readFileSync("scripts/pilot-run-6h-alternate-pickup-trial.cjs", "utf8");
}

describe("Pilot Run 6H alternate pickup trial script", () => {
  it("defaults to the fixed local Pilot Run 6H context and fails closed without a token", () => {
    assert.equal(trialScript.DEFAULT_API_BASE_URL, "http://localhost:8080/api/shipping");
    assert.equal(trialScript.DEFAULT_PROVIDER_KEY, "SHIPROCKET");
    assert.equal(trialScript.DEFAULT_SHIPMENT_ID, "cmqamlku6000am1qh7amfz3m5");
    assert.equal(trialScript.DEFAULT_ALTERNATE_PICKUP_LOCATION_ID, "cmq9380sf0002m1akjbwmbkm8");
    assert.throws(() => trialScript.runtimeFromEnv({}), /SHIPMASTR_TOKEN is required/);

    const runtime = trialScript.runtimeFromEnv({ SHIPMASTR_TOKEN: "test-token" });
    assert.equal(runtime.apiBase, "http://localhost:8080/api/shipping");
    assert.equal(runtime.providerKey, "SHIPROCKET");
    assert.equal(runtime.shipmentId, "cmqamlku6000am1qh7amfz3m5");
    assert.equal(runtime.alternatePickupLocationId, "cmq9380sf0002m1akjbwmbkm8");
  });

  it("uses only the controlled alternate pickup dry-run endpoint", () => {
    const source = scriptSource();
    assert.match(source, /courier-pickup-trials\/providers/);
    assert.match(source, /mode:\s*"DRY_RUN"/);
    assert.doesNotMatch(source, /\/live-one-shot|\/ship-now|x-shipmastr-live-awb-approval|x-shipmastr-live-label-approval|x-shipmastr-live-tracking-approval/i);
    assert.doesNotMatch(source, /awb-certification|label-certification|tracking-certification|shipNowShipment|manifestOrder|createLabel|getLabel|liveTrackingRead|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });

  it("does not print tokens or secrets in the safe report", () => {
    const report = trialScript.renderReport({
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      alternatePickupLocationId: "pickup_122001"
    }, {
      status: "DRY_RUN_ONLY",
      rate_context: {
        candidate_count: 0,
        eligible_count: 0,
        pickup_available_count: 0,
        delivery_available_count: 0,
        numeric_courier_id_count: 0
      },
      public_rate_options: [],
      blockers: ["CONTROLLED_TRIAL_REQUIRES_RATE_REFRESH"],
      admin_next_actions: ["Run a controlled alternate pickup rate refresh for this pickup. Do not Ship Now until rates are refreshed."]
    });

    assert.match(report, /Pilot Run 6H alternate pickup trial:/);
    assert.match(report, /status: DRY_RUN_ONLY/);
    assert.match(report, /public rate options:/);
    assert.match(report, /final recommendation:/);
    assert.doesNotMatch(report, /test-token|SHIPMASTR_TOKEN|Authorization|Bearer|secret|password|credential|rawPayload|rawHeaders|rawResponse|Bigship|Shipmozo/i);
  });

  it("prints safe public options only when an alternate pickup has eligible evidence", () => {
    const report = trialScript.renderReport({
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      alternatePickupLocationId: "pickup_122001"
    }, {
      status: "ELIGIBLE_RATES_FOUND",
      rate_context: {
        candidate_count: 2,
        eligible_count: 1,
        pickup_available_count: 1,
        delivery_available_count: 2,
        numeric_courier_id_count: 1
      },
      public_rate_options: [{
        public_service_name: "Shipmastr Smart",
        amount_paise: 7200,
        estimated_delivery_days: 2
      }],
      blockers: [],
      admin_next_actions: ["Review the trial options, then explicitly confirm pickup change before refreshing rates."]
    });

    assert.match(report, /Shipmastr Smart \(INR 72\.00, 2 days\)/);
    assert.match(report, /Review safe public options/);
    assert.doesNotMatch(report, /providerCourierId|provider pickup|rawPayload|rawHeaders|rawResponse|Authorization|Bearer|token|secret/i);
  });

  it("does not print SHIPMASTR_TOKEN explicitly", () => {
    const source = scriptSource();
    assert.doesNotMatch(source, /console\.log\([^)]*SHIPMASTR_TOKEN/i);
    assert.doesNotMatch(source, /console\.log\([^)]*runtime\.token/i);
  });
});
