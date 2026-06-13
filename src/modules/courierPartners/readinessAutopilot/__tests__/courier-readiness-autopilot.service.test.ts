import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  evaluateCourierReadinessAutopilotProvider,
  listCourierReadinessAutopilotProviders
} from "../courier-readiness-autopilot.service.js";
import { serializeCourierReadinessAutopilotProvider } from "../courier-readiness-autopilot.serializer.js";
import type {
  CourierCertificationDimension,
  CourierCertificationSnapshot
} from "../../certification/courier-certification.types.js";
import type { CourierLiveProviderKey } from "../../liveReadiness/courier-live-readiness.types.js";

const checkedAt = "2026-06-13T08:00:00.000Z";

function dim(
  key: CourierCertificationDimension["key"],
  status: CourierCertificationDimension["status"] = "PASS",
  blockers: string[] = [],
  warnings: string[] = [],
  safe_summary: Record<string, unknown> = {}
): CourierCertificationDimension {
  return { key, status, blockers, warnings, safe_summary };
}

function snapshot(
  providerKey: CourierLiveProviderKey = "SHIPROCKET",
  overrides: Partial<CourierCertificationSnapshot> = {}
): CourierCertificationSnapshot {
  return {
    provider_key: providerKey,
    provider_label_internal: providerKey,
    public_network_name: "Shipmastr Courier Network",
    status: "READY_FOR_PILOT",
    live_ready: false,
    can_use_for_rates: true,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [
      dim("CREDENTIALS"),
      dim("PICKUPS"),
      dim("SERVICEABILITY"),
      dim("RATES"),
      dim("COURIER_ID_MAPPING"),
      dim("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"], ["Live AWB certification has not been completed."], { sandbox_status: "AVAILABLE" }),
      dim("LABEL", "WARN", ["PROVIDER_LABEL_NOT_CERTIFIED"], ["Live label certification has not been completed."], { sandbox_status: "AVAILABLE" }),
      dim("TRACKING", "NOT_RUN", ["PROVIDER_TRACKING_NOT_CERTIFIED"], [], { sandbox_status: "AVAILABLE" }),
      dim("PUBLIC_SAFETY")
    ],
    blockers: ["PROVIDER_AWB_NOT_CERTIFIED", "PROVIDER_LABEL_NOT_CERTIFIED", "PROVIDER_TRACKING_NOT_CERTIFIED"],
    warnings: [],
    next_actions: ["Complete an explicit one-shot live AWB certification before live Ship Now."],
    checked_at: checkedAt,
    ...overrides
  };
}

function notConfigured() {
  return snapshot("SHIPROCKET", {
    status: "NOT_CONFIGURED",
    can_use_for_rates: false,
    dimensions: [
      dim("CREDENTIALS", "FAIL", ["PROVIDER_CREDENTIALS_MISSING"]),
      dim("PUBLIC_SAFETY")
    ],
    blockers: ["PROVIDER_CREDENTIALS_MISSING"],
    next_actions: ["Attach and test a live credential reference."]
  });
}

function dryRunProvider() {
  return snapshot("BIGSHIP", {
    status: "READY_FOR_DRY_RUN",
    can_use_for_rates: true,
    can_use_for_awb: false,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [
      dim("CREDENTIALS", "FAIL", ["PROVIDER_CREDENTIALS_MISSING"]),
      dim("RATES", "WARN", [], ["Provider is currently certified for dry-run routing only."]),
      dim("AWB", "NOT_RUN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
      dim("PUBLIC_SAFETY")
    ],
    blockers: ["PROVIDER_AWB_NOT_CERTIFIED"],
    warnings: ["Provider is currently certified for dry-run routing only."]
  });
}

function pickupBlocked() {
  return snapshot("SHIPROCKET", {
    status: "BLOCKED",
    can_use_for_rates: false,
    dimensions: [
      dim("CREDENTIALS"),
      dim("PICKUPS", "FAIL", ["PROVIDER_PICKUP_UNAVAILABLE"]),
      dim("SERVICEABILITY", "PASS"),
      dim("RATES", "FAIL", ["PROVIDER_PICKUP_UNAVAILABLE"]),
      dim("COURIER_ID_MAPPING"),
      dim("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"], [], { sandbox_status: "AVAILABLE" }),
      dim("LABEL", "WARN", ["PROVIDER_LABEL_NOT_CERTIFIED"], [], { sandbox_status: "AVAILABLE" }),
      dim("TRACKING", "NOT_RUN", ["PROVIDER_TRACKING_NOT_CERTIFIED"], [], { sandbox_status: "AVAILABLE" }),
      dim("PUBLIC_SAFETY")
    ],
    blockers: ["PROVIDER_PICKUP_UNAVAILABLE", "PROVIDER_AWB_NOT_CERTIFIED"],
    next_actions: ["Use another pickup or fix pickup availability before Ship Now."]
  });
}

function awbCertifiedOnly() {
  return snapshot("SHIPROCKET", {
    status: "READY_FOR_PILOT",
    can_use_for_awb: true,
    can_use_for_label: false,
    can_use_for_tracking: false,
    dimensions: [
      dim("CREDENTIALS"),
      dim("PICKUPS"),
      dim("SERVICEABILITY"),
      dim("RATES"),
      dim("COURIER_ID_MAPPING"),
      dim("AWB", "PASS", [], [], { live_awb_certified: true, sandbox_status: "AVAILABLE" }),
      dim("LABEL", "WARN", ["PROVIDER_LABEL_NOT_CERTIFIED"], [], { sandbox_status: "AVAILABLE" }),
      dim("TRACKING", "NOT_RUN", ["PROVIDER_TRACKING_NOT_CERTIFIED"], [], { sandbox_status: "AVAILABLE" }),
      dim("PUBLIC_SAFETY")
    ],
    blockers: ["PROVIDER_LABEL_NOT_CERTIFIED", "PROVIDER_TRACKING_NOT_CERTIFIED"]
  });
}

function liveReady(providerKey: CourierLiveProviderKey = "SHIPROCKET") {
  return snapshot(providerKey, {
    status: "READY_FOR_LIVE",
    live_ready: true,
    can_use_for_awb: true,
    can_use_for_label: true,
    can_use_for_tracking: true,
    dimensions: [
      dim("CREDENTIALS"),
      dim("PICKUPS"),
      dim("SERVICEABILITY"),
      dim("RATES"),
      dim("COURIER_ID_MAPPING"),
      dim("AWB", "PASS", [], [], { live_awb_certified: true, sandbox_status: "AVAILABLE" }),
      dim("LABEL", "PASS", [], [], { live_label_certified: true, sandbox_status: "AVAILABLE" }),
      dim("TRACKING", "PASS", [], [], { live_tracking_certified: true, sandbox_status: "AVAILABLE" }),
      dim("PUBLIC_SAFETY")
    ],
    blockers: [],
    next_actions: []
  });
}

describe("courier readiness autopilot", () => {
  it("returns NOT_CONFIGURED when provider credentials are missing", async () => {
    const result = await evaluateCourierReadinessAutopilotProvider("merchant_1", "SHIPROCKET", {}, {
      checkedAt,
      certificationProvider: async () => notConfigured()
    });
    assert.equal(result.lifecycle_state, "NOT_CONFIGURED");
    assert.equal(result.capabilities.rates, "NOT_CONFIGURED");
    assert.equal(result.next_safe_action, "CONNECT_CREDENTIALS");
  });

  it("keeps dry-run providers DRY_RUN_ONLY and not live-ready", async () => {
    const result = await evaluateCourierReadinessAutopilotProvider("merchant_1", "BIGSHIP", {}, {
      checkedAt,
      certificationProvider: async () => dryRunProvider()
    });
    assert.equal(result.lifecycle_state, "DRY_RUN_ONLY");
    assert.equal(result.capabilities.rates, "DRY_RUN_ONLY");
    assert.notEqual(result.next_safe_action, "READY_FOR_LIVE");
  });

  it("blocks Shiprocket when credentials and rates pass but selected pickup is unavailable", async () => {
    const result = await evaluateCourierReadinessAutopilotProvider("merchant_1", "SHIPROCKET", {
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_1",
      includeArbitration: true
    }, {
      checkedAt,
      certificationProvider: async () => pickupBlocked(),
      arbitrationProvider: async () => ({
        decision: "RUN_PICKUP_TRIAL",
        blockers: ["PROVIDER_PICKUP_UNAVAILABLE"],
        warnings: [],
        seller_safe_message: "Try another pickup location.",
        admin_next_actions: ["Run a controlled alternate pickup trial. Do not Ship Now."]
      })
    });
    assert.equal(result.lifecycle_state, "BLOCKED");
    assert.equal(result.next_safe_action, "RUN_PICKUP_TRIAL");
    assert.match(result.seller_safe_message, /Try another pickup/i);
    assert.notEqual(result.lifecycle_state, "LIVE_READY");
  });

  it("does not mark AWB-certified provider live-ready while label and tracking remain missing", async () => {
    const result = await evaluateCourierReadinessAutopilotProvider("merchant_1", "SHIPROCKET", {}, {
      checkedAt,
      certificationProvider: async () => awbCertifiedOnly()
    });
    assert.notEqual(result.lifecycle_state, "LIVE_READY");
    assert.equal(result.capabilities.awb, "READY");
    assert.equal(result.capabilities.label, "ONE_SHOT_READY");
    assert.equal(result.capabilities.tracking, "NOT_CERTIFIED");
  });

  it("marks provider LIVE_READY only when AWB, label, and tracking are certified", async () => {
    const result = await evaluateCourierReadinessAutopilotProvider("merchant_1", "SHIPROCKET", {}, {
      checkedAt,
      certificationProvider: async () => liveReady()
    });
    assert.equal(result.lifecycle_state, "LIVE_READY");
    assert.equal(result.capabilities.awb, "READY");
    assert.equal(result.capabilities.label, "READY");
    assert.equal(result.capabilities.tracking, "READY");
    assert.equal(result.next_safe_action, "READY_FOR_LIVE");
  });

  it("seller-safe output hides provider names and internal ids while admin output keeps provider key", async () => {
    const result = await evaluateCourierReadinessAutopilotProvider("merchant_1", "SHIPROCKET", {}, {
      checkedAt,
      certificationProvider: async () => pickupBlocked()
    });
    const serialized = serializeCourierReadinessAutopilotProvider({
      ...result,
      seller_safe_message: "Shiprocket provider pickup id pickup_123 is blocked"
    });
    assert.equal(serialized.provider_key_internal, "SHIPROCKET");
    assert.doesNotMatch(serialized.seller_safe_message, /Shiprocket|provider pickup id|pickup_123/i);
  });

  it("lists providers from injected snapshots without calling provider APIs", async () => {
    let providerApiCalls = 0;
    const result = await listCourierReadinessAutopilotProviders("merchant_1", {}, {
      checkedAt,
      certificationListProvider: async () => {
        providerApiCalls += 0;
        return [pickupBlocked(), dryRunProvider(), liveReady("SHIPMOZO")];
      },
      arbitrationProvider: async () => {
        providerApiCalls += 1;
        throw new Error("arbitration should not run unless requested");
      }
    });
    assert.equal(providerApiCalls, 0);
    assert.equal(result.counts.total, 3);
    assert.equal(result.counts.live_ready, 1);
    assert.equal(result.counts.dry_run_only, 1);
    assert.equal(result.counts.blocked, 1);
  });

  it("routes and script expose autopilot checks without mutation helpers", () => {
    const routes = readFileSync("src/modules/courierPartners/readinessAutopilot/courier-readiness-autopilot.routes.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");
    const service = readFileSync("src/modules/courierPartners/readinessAutopilot/courier-readiness-autopilot.service.ts", "utf8");
    const script = readFileSync("scripts/pilot-run-6h-certification-check.cjs", "utf8");

    assert.match(routes, /provider-readiness-autopilot\/providers/);
    assert.match(routes, /provider-readiness-autopilot\/shipments\/:shipmentId/);
    assert.match(shippingRoutes, /courierReadinessAutopilotRouter/);
    assert.doesNotMatch(`${routes}\n${service}`, /shipNowShipment|manifestShipment|createLabel|getLabel|fetchShipmentTracking|live-read-one-shot|live-one-shot|ShiprocketLiveClient|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
    assert.match(script, /Provider readiness autopilot:/);
    assert.match(script, /provider-readiness-autopilot\/shipments/);
  });
});
