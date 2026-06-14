import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateCertifiedProviderRouting } from "../certified-provider-routing.service.js";
import { serializeCertifiedProviderRouting } from "../certified-provider-routing.serializer.js";
import type {
  CertifiedProviderRoutingDependencies,
  CertifiedProviderRoutingRateCandidate
} from "../certified-provider-routing.types.js";
import type { CourierLiveProviderKey } from "../../liveReadiness/courier-live-readiness.types.js";
import type { CourierReadinessAutopilotProviderResult } from "../../readinessAutopilot/courier-readiness-autopilot.types.js";

const checkedAt = "2026-06-13T09:00:00.000Z";

function provider(
  providerKey: CourierLiveProviderKey,
  overrides: Partial<CourierReadinessAutopilotProviderResult> = {}
): CourierReadinessAutopilotProviderResult {
  return {
    provider_key_internal: providerKey,
    public_network_name: "Shipmastr Courier Network",
    lifecycle_state: "AWB_SANDBOX_READY",
    capabilities: {
      rates: "READY",
      awb: "ONE_SHOT_READY",
      label: "NOT_CERTIFIED",
      tracking: "NOT_CERTIFIED"
    },
    blockers: ["PROVIDER_AWB_NOT_CERTIFIED", "PROVIDER_LABEL_NOT_CERTIFIED", "PROVIDER_TRACKING_NOT_CERTIFIED"],
    warnings: [],
    next_safe_action: "RUN_AWB_ONE_SHOT",
    admin_next_actions: ["Complete AWB certification before live Ship Now."],
    seller_safe_message: "Shipmastr is reviewing this shipping path before live shipping.",
    requested_capability: "AWB",
    shipment_id: "shipment_1",
    checked_at: checkedAt,
    ...overrides
  };
}

function liveReady(providerKey: CourierLiveProviderKey = "SHIPROCKET") {
  return provider(providerKey, {
    lifecycle_state: "LIVE_READY",
    capabilities: {
      rates: "READY",
      awb: "READY",
      label: "READY",
      tracking: "READY"
    },
    blockers: [],
    next_safe_action: "READY_FOR_LIVE",
    admin_next_actions: ["Provider is certified for controlled live routing."],
    seller_safe_message: "Shipmastr Courier Network is ready for controlled shipping."
  });
}

function dryRunOnly(providerKey: CourierLiveProviderKey = "BIGSHIP") {
  return provider(providerKey, {
    lifecycle_state: "DRY_RUN_ONLY",
    capabilities: {
      rates: "DRY_RUN_ONLY",
      awb: "NOT_CERTIFIED",
      label: "NOT_CERTIFIED",
      tracking: "NOT_CERTIFIED"
    },
    blockers: ["PROVIDER_AWB_NOT_CERTIFIED"],
    next_safe_action: "KEEP_IN_REVIEW"
  });
}

function pickupBlocked() {
  return provider("SHIPROCKET", {
    lifecycle_state: "BLOCKED",
    capabilities: {
      rates: "BLOCKED",
      awb: "BLOCKED",
      label: "BLOCKED",
      tracking: "BLOCKED"
    },
    blockers: ["PROVIDER_PICKUP_UNAVAILABLE", "PROVIDER_AWB_NOT_CERTIFIED"],
    next_safe_action: "RUN_PICKUP_TRIAL",
    admin_next_actions: ["Run a controlled alternate pickup trial. Do not Ship Now."],
    seller_safe_message: "Shipping is in safe review. Try another pickup location."
  });
}

function rate(overrides: Partial<CertifiedProviderRoutingRateCandidate> = {}): CertifiedProviderRoutingRateCandidate {
  return {
    id: "rate_1",
    publicServiceCode: "shipmastr_smart",
    publicServiceName: "Shipmastr Smart",
    rateBreakup: {
      phase6: {
        providerCourierId: "123456",
        pickupAvailable: true,
        deliveryAvailable: true
      }
    },
    createdAt: checkedAt,
    ...overrides
  };
}

function dependencies(providers: CourierReadinessAutopilotProviderResult[], input: {
  arbitrationDecision?: string;
  selectedPickup?: string | null;
  rates?: CertifiedProviderRoutingRateCandidate[];
} = {}): CertifiedProviderRoutingDependencies {
  return {
    shipmentProvider: async () => ({ id: "shipment_1", pickupLocationId: "pickup_1" }),
    readinessProvider: async () => ({
      public_network_name: "Shipmastr Courier Network",
      shipment_id: "shipment_1",
      requested_capability: "AWB",
      checked_at: checkedAt,
      providers,
      counts: {
        total: providers.length,
        live_ready: providers.filter((item) => item.lifecycle_state === "LIVE_READY").length,
        pilot_ready: 0,
        dry_run_only: providers.filter((item) => item.lifecycle_state === "DRY_RUN_ONLY").length,
        blocked: providers.filter((item) => item.lifecycle_state === "BLOCKED").length,
        not_configured: providers.filter((item) => item.lifecycle_state === "NOT_CONFIGURED").length
      },
      blockers: providers.flatMap((item) => item.blockers),
      warnings: providers.flatMap((item) => item.warnings),
      next_safe_actions: providers.map((item) => item.next_safe_action)
    }),
    arbitrationProvider: async () => ({
      decision: input.arbitrationDecision ?? "USE_SELECTED",
      selected_option: {
        provider_key_internal: "SHIPROCKET",
        pickup_location_id: input.selectedPickup ?? "pickup_1",
        public_service_code: "shipmastr_smart"
      },
      blockers: input.arbitrationDecision === "RUN_PICKUP_TRIAL" ? ["PROVIDER_PICKUP_UNAVAILABLE"] : [],
      warnings: [],
      seller_safe_message: "Shipmastr selected a safe shipping path.",
      admin_next_actions: input.arbitrationDecision === "RUN_PICKUP_TRIAL"
        ? ["Run a controlled alternate pickup trial. Do not Ship Now."]
        : ["Continue controlled checks."]
    }),
    ratesProvider: async () => input.rates ?? [rate()]
  };
}

describe("certified provider routing engine", () => {
  it("returns AWB_READY for a live-ready provider and pickup available context", async () => {
    const result = await evaluateCertifiedProviderRouting("merchant_1", {
      shipmentId: "shipment_1",
      requestedCapability: "AWB",
      requestedOutcome: "DEFAULT_SMART"
    }, dependencies([liveReady()]));

    assert.equal(result.decision, "AWB_READY");
    assert.equal(result.selected_public_tier, "shipmastr_smart");
    assert.equal(result.internal_selection.provider_key_internal, "SHIPROCKET");
    assert.equal(result.internal_selection.internal_courier_id_present, true);
    assert.equal(result.readiness.awb_ready, true);
  });

  it("returns RATES_ONLY when rates are ready but AWB is not certified", async () => {
    const result = await evaluateCertifiedProviderRouting("merchant_1", {
      shipmentId: "shipment_1",
      requestedCapability: "AWB"
    }, dependencies([provider("SHIPROCKET")]));

    assert.equal(result.decision, "RATES_ONLY");
    assert.notEqual(result.decision, "AWB_READY");
    assert.equal(result.readiness.rates_ready, true);
    assert.equal(result.readiness.awb_ready, false);
    assert.ok(result.blockers.includes("PROVIDER_NOT_CERTIFIED_FOR_LIVE_AWB"));
  });

  it("recommends a pickup trial when selected pickup is unavailable", async () => {
    const result = await evaluateCertifiedProviderRouting("merchant_1", {
      shipmentId: "shipment_1",
      pickupLocationId: "pickup_1",
      requestedCapability: "AWB"
    }, dependencies([pickupBlocked()], {
      arbitrationDecision: "RUN_PICKUP_TRIAL",
      selectedPickup: "pickup_2"
    }));

    assert.equal(result.decision, "RUN_PICKUP_TRIAL");
    assert.equal(result.selected_rate_id, null);
    assert.equal(result.selected_public_tier, null);
    assert.match(result.seller_safe_message, /Try another pickup/i);
  });

  it("does not use dry-run-only providers for live AWB", async () => {
    const result = await evaluateCertifiedProviderRouting("merchant_1", {
      shipmentId: "shipment_1",
      requestedCapability: "AWB"
    }, dependencies([dryRunOnly()]));

    assert.equal(result.decision, "SAFE_REVIEW");
    assert.equal(result.internal_selection.provider_key_internal, null);
    assert.equal(result.selected_rate_id, null);
  });

  it("returns SAFE_REVIEW when no certified provider exists", async () => {
    const result = await evaluateCertifiedProviderRouting("merchant_1", {
      shipmentId: "shipment_1",
      requestedCapability: "AWB"
    }, dependencies([provider("SHIPROCKET", {
      capabilities: {
        rates: "BLOCKED",
        awb: "BLOCKED",
        label: "BLOCKED",
        tracking: "BLOCKED"
      },
      lifecycle_state: "BLOCKED",
      blockers: ["PROVIDER_RATES_NOT_LIVE"]
    })]));

    assert.equal(result.decision, "SAFE_REVIEW");
    assert.notEqual(result.decision, "AWB_READY");
  });

  it("recommends alternate provider when another provider is live-ready", async () => {
    const result = await evaluateCertifiedProviderRouting("merchant_1", {
      shipmentId: "shipment_1",
      requestedCapability: "AWB"
    }, dependencies([provider("SHIPROCKET", {
      capabilities: {
        rates: "BLOCKED",
        awb: "BLOCKED",
        label: "BLOCKED",
        tracking: "BLOCKED"
      },
      blockers: ["PROVIDER_RATES_NOT_LIVE"]
    }), liveReady("SHIPMOZO")]));

    assert.equal(result.decision, "TRY_ALTERNATE_PROVIDER");
    assert.equal(result.internal_selection.provider_key_internal, "SHIPMOZO");
    assert.match(result.seller_safe_message, /safe shipping path/i);
  });

  it("keeps seller-safe routing output free of provider names and ids", async () => {
    const result = await evaluateCertifiedProviderRouting("merchant_1", {
      shipmentId: "shipment_1",
      requestedCapability: "AWB"
    }, dependencies([pickupBlocked()]));
    const serialized = serializeCertifiedProviderRouting({
      ...result,
      seller_safe_message: "Shiprocket provider pickup id pickup_123 is unavailable",
      warnings: ["Shipmozo rawHeaders should not appear"]
    });
    assert.doesNotMatch(JSON.stringify({
      message: serialized.seller_safe_message,
      warnings: serialized.warnings,
      tier: serialized.selected_public_service_name
    }), /Shiprocket|Shipmozo|Bigship|provider pickup id|pickup_123|rawHeaders/i);
  });

  it("does not call provider APIs and wires read-only routes/script sections", async () => {
    let providerCalls = 0;
    const result = await evaluateCertifiedProviderRouting("merchant_1", {
      shipmentId: "shipment_1",
      requestedCapability: "AWB"
    }, {
      ...dependencies([liveReady()]),
      readinessProvider: async (...args) => {
        providerCalls += 0;
        return dependencies([liveReady()]).readinessProvider!(...args);
      }
    });
    const routes = readFileSync("src/modules/courierPartners/certifiedRouting/certified-provider-routing.routes.ts", "utf8");
    const service = readFileSync("src/modules/courierPartners/certifiedRouting/certified-provider-routing.service.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");
    const script = readFileSync("scripts/pilot-run-6h-certification-check.cjs", "utf8");

    assert.equal(providerCalls, 0);
    assert.equal(result.decision, "AWB_READY");
    assert.match(routes, /certified-provider-routing\/shipments\/:shipmentId/);
    assert.match(shippingRoutes, /certifiedProviderRoutingRouter/);
    assert.match(script, /Certified provider routing:/);
    assert.doesNotMatch(`${routes}\n${service}`, /shipNowShipment|manifestShipment|createLabel|getLabel|fetchShipmentTracking|live-read-one-shot|live-one-shot|ShiprocketLiveClient|app\.shiprocket\.in|shiprocket\.in\/v1\/external/i);
  });
});
