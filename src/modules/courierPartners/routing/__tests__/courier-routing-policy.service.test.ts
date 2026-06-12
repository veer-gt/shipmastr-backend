import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateCourierRoutingPolicy,
  publicCourierRoutingPolicyResult
} from "../courier-routing-policy.service.js";
import type { CourierCertificationDimension, CourierCertificationSnapshot } from "../../certification/courier-certification.types.js";

function dim(
  key: CourierCertificationDimension["key"],
  status: CourierCertificationDimension["status"],
  blockers: string[] = []
): CourierCertificationDimension {
  return { key, status, blockers, warnings: [], safe_summary: {} };
}

function provider(overrides: Partial<CourierCertificationSnapshot> = {}): CourierCertificationSnapshot {
  return {
    provider_key: "SHIPROCKET",
    provider_label_internal: "Shiprocket",
    public_network_name: "Shipmastr Courier Network",
    status: "BLOCKED",
    live_ready: false,
    can_use_for_rates: false,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [
      dim("CREDENTIALS", "PASS"),
      dim("PICKUPS", "FAIL", ["PROVIDER_PICKUP_UNAVAILABLE"]),
      dim("RATES", "FAIL", ["PROVIDER_RATES_NOT_LIVE"]),
      dim("COURIER_ID_MAPPING", "FAIL", ["PROVIDER_COURIER_ID_MISSING"]),
      dim("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
      dim("PUBLIC_SAFETY", "PASS")
    ],
    blockers: ["PROVIDER_PICKUP_UNAVAILABLE"],
    warnings: [],
    next_actions: ["Align pickup."],
    checked_at: "2026-06-12T08:00:00.000Z",
    ...overrides
  };
}

function dryRunProvider(provider_key: "BIGSHIP" | "SHIPMOZO"): CourierCertificationSnapshot {
  return provider({
    provider_key,
    provider_label_internal: provider_key,
    status: "READY_FOR_DRY_RUN",
    dimensions: [
      dim("CREDENTIALS", "FAIL", ["PROVIDER_CREDENTIALS_MISSING"]),
      dim("AWB", "NOT_RUN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
      dim("PUBLIC_SAFETY", "PASS")
    ],
    blockers: ["PROVIDER_CREDENTIALS_MISSING"]
  });
}

function liveReady(provider_key: "SHIPROCKET" | "BIGSHIP" | "SHIPMOZO"): CourierCertificationSnapshot {
  return provider({
    provider_key,
    provider_label_internal: provider_key,
    status: "READY_FOR_LIVE",
    live_ready: true,
    can_use_for_rates: true,
    can_use_for_awb: true,
    can_use_for_label: true,
    can_use_for_tracking: true,
    dimensions: [
      dim("CREDENTIALS", "PASS"),
      dim("PICKUPS", "PASS"),
      dim("RATES", "PASS"),
      dim("COURIER_ID_MAPPING", "PASS"),
      dim("AWB", "PASS"),
      dim("LABEL", "PASS"),
      dim("TRACKING", "PASS"),
      dim("WEBHOOKS", "PASS"),
      dim("PUBLIC_SAFETY", "PASS")
    ],
    blockers: []
  });
}

describe("courier certification routing policy", () => {
  it("falls back to dry-run provider when Shiprocket is blocked and live is not requested", async () => {
    const result = await evaluateCourierRoutingPolicy({
      requestedCapability: "AWB",
      liveRequested: false,
      certifications: [
        provider(),
        dryRunProvider("BIGSHIP")
      ]
    });
    assert.equal(result.selected_provider_internal, "BIGSHIP");
    assert.equal(result.decision, "DRY_RUN_ONLY");
    assert.equal(result.fallback_used, true);
    assert.equal(result.selected_tier_public, "Shipmastr Smart");
  });

  it("blocks live requests when no certified provider is available", async () => {
    const result = await evaluateCourierRoutingPolicy({
      requestedCapability: "AWB",
      liveRequested: true,
      certifications: [
        provider(),
        dryRunProvider("BIGSHIP"),
        dryRunProvider("SHIPMOZO")
      ]
    });
    assert.equal(result.selected_provider_internal, null);
    assert.equal(result.decision, "BLOCK");
    assert.equal(result.blocked_providers_internal.length, 3);
  });

  it("selects a certified live provider when available", async () => {
    const result = await evaluateCourierRoutingPolicy({
      requestedCapability: "AWB",
      liveRequested: true,
      certifications: [
        provider(),
        liveReady("SHIPMOZO")
      ]
    });
    assert.equal(result.selected_provider_internal, "SHIPMOZO");
    assert.equal(result.decision, "ALLOW");
    assert.equal(result.fallback_used, true);
  });

  it("public routing output hides provider names and blockers", async () => {
    const result = await evaluateCourierRoutingPolicy({
      requestedCapability: "AWB",
      liveRequested: false,
      certifications: [
        provider(),
        dryRunProvider("BIGSHIP")
      ]
    });
    const publicResult = publicCourierRoutingPolicyResult(result);
    const json = JSON.stringify(publicResult);
    assert.match(json, /Shipmastr Smart/);
    assert.doesNotMatch(json, /Shiprocket|Bigship|Shipmozo|PROVIDER_|pickup unavailable|provider/i);
    assert.equal(Object.prototype.hasOwnProperty.call(publicResult, "selected_provider_internal"), false);
  });

  it("admin routing output keeps safe provider blockers", async () => {
    const result = await evaluateCourierRoutingPolicy({
      requestedCapability: "RATES",
      liveRequested: true,
      certifications: [provider()]
    });
    assert.equal(result.blocked_providers_internal[0]?.provider_key, "SHIPROCKET");
    assert.ok(result.blocked_providers_internal[0]?.blockers.includes("PROVIDER_PICKUP_UNAVAILABLE"));
    assert.ok(result.blocked_providers_internal[0]?.next_actions.length);
  });
});
