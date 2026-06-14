import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const confirmScript = require("../../../../../scripts/pilot-run-6h-confirm-alternate-pickup.cjs");

function scriptSource() {
  return readFileSync("scripts/pilot-run-6h-confirm-alternate-pickup.cjs", "utf8");
}

describe("Pilot Run 6H alternate pickup confirmation script", () => {
  it("fails closed without token, explicit confirm flag, or trial id", () => {
    assert.equal(confirmScript.DEFAULT_API_BASE_URL, "http://localhost:8080/api/shipping");
    assert.equal(confirmScript.DEFAULT_PROVIDER_KEY, "SHIPROCKET");
    assert.equal(confirmScript.DEFAULT_SHIPMENT_ID, "cmqamlku6000am1qh7amfz3m5");
    assert.equal(confirmScript.DEFAULT_ALTERNATE_PICKUP_LOCATION_ID, "cmq9380sf0002m1akjbwmbkm8");

    assert.throws(() => confirmScript.runtimeFromEnv({}), /PILOT_6H_CONFIRM_ALTERNATE_PICKUP=1 is required/);
    assert.throws(() => confirmScript.runtimeFromEnv({ PILOT_6H_CONFIRM_ALTERNATE_PICKUP: "1" }), /SHIPMASTR_TOKEN is required/);
    assert.throws(() => confirmScript.runtimeFromEnv({
      PILOT_6H_CONFIRM_ALTERNATE_PICKUP: "1",
      SHIPMASTR_TOKEN: "test-token"
    }), /PILOT_6H_ALTERNATE_PICKUP_TRIAL_ID is required/);
  });

  it("targets only the confirmation endpoint when explicitly enabled", () => {
    const runtime = confirmScript.runtimeFromEnv({
      SHIPMASTR_TOKEN: "test-token",
      PILOT_6H_CONFIRM_ALTERNATE_PICKUP: "1",
      PILOT_6H_ALTERNATE_PICKUP_TRIAL_ID: "pickup_trial_shipment_pickup"
    });
    const source = scriptSource();

    assert.equal(confirmScript.endpointPath(runtime), "/courier-pickup-trials/providers/SHIPROCKET/shipments/cmqamlku6000am1qh7amfz3m5/confirm");
    assert.deepEqual(confirmScript.requestBody(runtime), {
      pickup_location_id: "cmq9380sf0002m1akjbwmbkm8",
      trial_id: "pickup_trial_shipment_pickup",
      operator_note: "Pilot Run 6H alternate pickup confirmation"
    });
    assert.doesNotMatch(source, /\/live-one-shot|\/ship-now|x-shipmastr-live-awb-approval|x-shipmastr-live-label-approval|x-shipmastr-live-tracking-approval/i);
    assert.doesNotMatch(source, /awb-certification|label-certification|tracking-certification|shipNowShipment|manifestOrder|createLabel|getLabel|trackOrder|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });

  it("prints a safe confirmation summary without secrets", () => {
    const report = confirmScript.renderReport({
      providerKey: "SHIPROCKET",
      shipmentId: "shipment_1",
      alternatePickupLocationId: "pickup_2"
    }, {
      success: true,
      provider_key: "SHIPROCKET",
      shipment_id: "shipment_1",
      previous_pickup_location_id: "pickup_1",
      confirmed_pickup_location_id: "pickup_2",
      confirmed_pickup_pincode: "122001",
      status: "CONFIRMED",
      requires_rate_refresh: true,
      blockers: [],
      admin_next_actions: ["Run a confirmed-pickup rate refresh before any shipping action."]
    });

    assert.match(report, /Pilot Run 6H alternate pickup confirmation:/);
    assert.match(report, /status: CONFIRMED/);
    assert.match(report, /requires rate refresh: yes/);
    assert.match(report, /final recommendation:/);
    assert.doesNotMatch(report, /test-token|SHIPMASTR_TOKEN|Authorization|Bearer|secret|password|credential|rawPayload|rawHeaders|rawResponse|Bigship|Shipmozo/i);
  });

  it("does not print SHIPMASTR_TOKEN explicitly", () => {
    const source = scriptSource();
    assert.doesNotMatch(source, /console\.log\([^)]*SHIPMASTR_TOKEN/i);
    assert.doesNotMatch(source, /console\.log\([^)]*runtime\.token/i);
  });
});
