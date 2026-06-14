import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getCourierCertificationDecision,
  sellerSafeCourierCertificationDecision
} from "../courier-certification-decision.service.js";
import type { CourierCertificationDimension, CourierCertificationSnapshot } from "../courier-certification.types.js";

function dim(
  key: CourierCertificationDimension["key"],
  status: CourierCertificationDimension["status"],
  blockers: string[] = [],
  warnings: string[] = []
): CourierCertificationDimension {
  return { key, status, blockers, warnings, safe_summary: {} };
}

function snapshot(overrides: Partial<CourierCertificationSnapshot> = {}): CourierCertificationSnapshot {
  return {
    provider_key: "SHIPROCKET",
    provider_label_internal: "Shiprocket",
    public_network_name: "Shipmastr Courier Network",
    status: "READY_FOR_PILOT",
    live_ready: false,
    can_use_for_rates: true,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [
      dim("CREDENTIALS", "PASS"),
      dim("PICKUPS", "PASS"),
      dim("SERVICEABILITY", "PASS"),
      dim("RATES", "PASS"),
      dim("COURIER_ID_MAPPING", "PASS"),
      dim("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
      dim("LABEL", "NOT_RUN", ["PROVIDER_LABEL_NOT_CERTIFIED"]),
      dim("TRACKING", "NOT_RUN", ["PROVIDER_TRACKING_NOT_CERTIFIED"]),
      dim("WEBHOOKS", "NOT_SUPPORTED"),
      dim("PUBLIC_SAFETY", "PASS")
    ],
    blockers: ["PROVIDER_AWB_NOT_CERTIFIED"],
    warnings: [],
    next_actions: ["Complete explicit one-shot AWB certification."],
    checked_at: "2026-06-12T08:00:00.000Z",
    ...overrides
  };
}

describe("courier certification decision engine", () => {
  it("blocks Shiprocket AWB when pickup is unavailable", async () => {
    const decision = await getCourierCertificationDecision({
      merchantId: "merchant_1",
      providerKey: "SHIPROCKET",
      requestedCapability: "AWB"
    }, {
      certification: snapshot({
        status: "BLOCKED",
        can_use_for_rates: false,
        dimensions: [
          dim("CREDENTIALS", "PASS"),
          dim("PICKUPS", "FAIL", ["PROVIDER_PICKUP_UNAVAILABLE"]),
          dim("RATES", "PASS"),
          dim("COURIER_ID_MAPPING", "PASS"),
          dim("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
          dim("PUBLIC_SAFETY", "PASS")
        ],
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"]
      }),
      oneShotPilotGatePassed: true,
      existingAwb: false
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.decision, "BLOCK");
    assert.ok(decision.blockers.includes("PROVIDER_PICKUP_UNAVAILABLE"));
  });

  it("blocks rates when pickup context is unavailable and returns fallback decision", async () => {
    const decision = await getCourierCertificationDecision({
      merchantId: "merchant_1",
      providerKey: "SHIPROCKET",
      requestedCapability: "RATES"
    }, {
      certification: snapshot({
        status: "BLOCKED",
        can_use_for_rates: false,
        dimensions: [
          dim("PICKUPS", "FAIL", ["PROVIDER_PICKUP_NOT_FOUND"]),
          dim("RATES", "FAIL", ["PROVIDER_RATES_NOT_LIVE"]),
          dim("COURIER_ID_MAPPING", "FAIL", ["PROVIDER_COURIER_ID_MISSING"]),
          dim("PUBLIC_SAFETY", "PASS")
        ]
      })
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.decision, "FALLBACK");
    assert.ok(decision.blockers.includes("PROVIDER_PICKUP_NOT_FOUND"));
  });

  it("returns dry-run-only for mock providers requesting live AWB", async () => {
    const decision = await getCourierCertificationDecision({
      merchantId: "merchant_1",
      providerKey: "BIGSHIP",
      requestedCapability: "AWB"
    }, {
      certification: snapshot({
        provider_key: "BIGSHIP",
        provider_label_internal: "Bigship",
        status: "READY_FOR_DRY_RUN",
        can_use_for_rates: false,
        dimensions: [
          dim("CREDENTIALS", "FAIL", ["PROVIDER_CREDENTIALS_MISSING"]),
          dim("AWB", "NOT_RUN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
          dim("PUBLIC_SAFETY", "PASS")
        ]
      })
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.decision, "DRY_RUN_ONLY");
  });

  it("allows AWB only when prerequisites and one-shot pilot gate pass", async () => {
    const decision = await getCourierCertificationDecision({
      merchantId: "merchant_1",
      providerKey: "SHIPROCKET",
      requestedCapability: "AWB"
    }, {
      certification: snapshot(),
      oneShotPilotGatePassed: true,
      existingAwb: false
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.decision, "ALLOW");
    assert.deepEqual(decision.blockers, []);
  });

  it("blocks duplicate AWB attempts", async () => {
    const decision = await getCourierCertificationDecision({
      merchantId: "merchant_1",
      providerKey: "SHIPROCKET",
      requestedCapability: "AWB"
    }, {
      certification: snapshot(),
      oneShotPilotGatePassed: true,
      existingAwb: true
    });
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockers.includes("SHIPMENT_ALREADY_HAS_AWB"));
  });

  it("keeps seller-safe decision messages free of provider names and ids", async () => {
    const decision = await getCourierCertificationDecision({
      merchantId: "merchant_1",
      providerKey: "SHIPROCKET",
      requestedCapability: "AWB"
    }, {
      certification: snapshot({
        status: "BLOCKED",
        dimensions: [dim("PICKUPS", "FAIL", ["PROVIDER_PICKUP_UNAVAILABLE"])]
      })
    });
    const seller = sellerSafeCourierCertificationDecision(decision);
    const json = JSON.stringify(seller);
    assert.doesNotMatch(json, /Shiprocket|Bigship|Shipmozo|provider courier|provider pickup|123/i);
  });
});
