import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const refreshScript = require("../../../../../scripts/pilot-run-6h-confirmed-pickup-rate-refresh.cjs");

function scriptSource() {
  return readFileSync("scripts/pilot-run-6h-confirmed-pickup-rate-refresh.cjs", "utf8");
}

describe("Pilot Run 6H confirmed pickup rate refresh script", () => {
  it("fails closed without token or explicit refresh flag", () => {
    assert.equal(refreshScript.DEFAULT_API_BASE_URL, "http://localhost:8080/api/shipping");
    assert.equal(refreshScript.DEFAULT_PROVIDER_KEY, "SHIPROCKET");
    assert.equal(refreshScript.DEFAULT_SHIPMENT_ID, "cmqamlku6000am1qh7amfz3m5");
    assert.equal(refreshScript.DEFAULT_CONFIRMED_PICKUP_LOCATION_ID, "cmq9380sf0002m1akjbwmbkm8");

    assert.throws(() => refreshScript.runtimeFromEnv({}), /PILOT_6H_RUN_CONFIRMED_PICKUP_RATE_REFRESH=1 is required/);
    assert.throws(() => refreshScript.runtimeFromEnv({
      PILOT_6H_RUN_CONFIRMED_PICKUP_RATE_REFRESH: "1"
    }), /SHIPMASTR_TOKEN is required/);
  });

  it("targets only the confirmed-pickup refresh endpoint", () => {
    const runtime = refreshScript.runtimeFromEnv({
      SHIPMASTR_TOKEN: "test-token",
      PILOT_6H_RUN_CONFIRMED_PICKUP_RATE_REFRESH: "1"
    });
    const source = scriptSource();

    assert.equal(refreshScript.endpointPath(runtime), "/courier-pickup-trials/providers/SHIPROCKET/shipments/cmqamlku6000am1qh7amfz3m5/confirmed-pickup-rate-refresh");
    assert.deepEqual(refreshScript.requestBody(runtime), {
      pickup_location_id: "cmq9380sf0002m1akjbwmbkm8",
      mode: "CONFIRMED_PICKUP_REFRESH"
    });
    assert.doesNotMatch(source, /\/live-one-shot|\/ship-now|x-shipmastr-live-awb-approval|x-shipmastr-live-label-approval|x-shipmastr-live-tracking-approval/i);
    assert.doesNotMatch(source, /awb-certification|label-certification|tracking-certification|shipNowShipment|manifestOrder|createLabel|getLabel|trackOrder|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });

  it("prints safe counts and public rate options only", () => {
    const report = refreshScript.renderReport({
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      confirmedPickupLocationId: "pickup_2"
    }, {
      status: "ELIGIBLE_RATES_FOUND",
      shipment_id: "shipment_1",
      trial_pickup_location_id: "pickup_2",
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
      admin_next_actions: ["Rerun certification readiness and AWB dry-run."]
    });

    assert.match(report, /Pilot Run 6H confirmed pickup rate refresh:/);
    assert.match(report, /eligible count: 1/);
    assert.match(report, /Shipmastr Smart \(INR 72\.00, 2 days\)/);
    assert.match(report, /final recommendation:/);
    assert.doesNotMatch(report, /test-token|SHIPMASTR_TOKEN|Authorization|Bearer|secret|password|credential|rawPayload|rawHeaders|rawResponse|Bigship|Shipmozo|providerCourierId/i);
  });
});
