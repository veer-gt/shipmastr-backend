import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { serializeCourierOnboardingChecklist } from "../courier-onboarding.serializer.js";
import {
  buildCourierOnboardingChecklist,
  getCourierOnboardingProvider,
  getCourierOnboardingSummary
} from "../courier-onboarding.service.js";
import type { CourierCertificationDimension, CourierCertificationSnapshot } from "../../certification/courier-certification.types.js";

function dim(
  key: CourierCertificationDimension["key"],
  status: CourierCertificationDimension["status"],
  blockers: string[] = [],
  warnings: string[] = [],
  safe_summary: Record<string, unknown> = {}
): CourierCertificationDimension {
  return { key, status, blockers, warnings, safe_summary };
}

function snapshot(overrides: Partial<CourierCertificationSnapshot> = {}): CourierCertificationSnapshot {
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
      dim("CREDENTIALS", "PASS", [], [], { configured: true, mode: "LIVE" }),
      dim("PICKUPS", "FAIL", ["PROVIDER_PICKUP_UNAVAILABLE"], [], {
        selected_context: "shipment_pickup",
        pincode_match: true,
        live_rate_pickup_available: false
      }),
      dim("SERVICEABILITY", "PASS"),
      dim("RATES", "PASS"),
      dim("COURIER_ID_MAPPING", "PASS"),
      dim("AWB", "WARN", ["PROVIDER_AWB_NOT_CERTIFIED"], ["One-shot AWB has not been certified."]),
      dim("LABEL", "WARN", ["PROVIDER_LABEL_NOT_CERTIFIED"], ["Label retrieval has not been certified."]),
      dim("TRACKING", "NOT_RUN", ["PROVIDER_TRACKING_NOT_CERTIFIED"]),
      dim("WEBHOOKS", "NOT_SUPPORTED"),
      dim("PUBLIC_SAFETY", "PASS", [], [], { public_network_name: "Shipmastr Courier Network" })
    ],
    blockers: ["PROVIDER_PICKUP_UNAVAILABLE", "PROVIDER_AWB_NOT_CERTIFIED"],
    warnings: ["One-shot AWB has not been certified."],
    next_actions: ["Align the selected Shipmastr pickup with the provider pickup."],
    checked_at: "2026-06-12T08:00:00.000Z",
    ...overrides
  };
}

function step(checklist: ReturnType<typeof buildCourierOnboardingChecklist>, key: string) {
  const found = checklist.steps.find((item) => item.key === key);
  assert.ok(found, `Expected checklist step ${key}`);
  return found;
}

describe("courier provider onboarding checklist", () => {
  it("reflects current Shiprocket blocked pickup state", () => {
    const checklist = buildCourierOnboardingChecklist(snapshot());
    assert.equal(checklist.provider_key, "SHIPROCKET");
    assert.equal(checklist.public_network_name, "Shipmastr Courier Network");
    assert.equal(step(checklist, "CONNECT_CREDENTIALS").status, "DONE");
    assert.equal(step(checklist, "ALIGN_PICKUP").status, "BLOCKED");
    assert.ok(step(checklist, "ALIGN_PICKUP").blockers.includes("PROVIDER_PICKUP_UNAVAILABLE"));
    assert.equal(step(checklist, "ENABLE_PILOT").status, "BLOCKED");
    assert.equal(step(checklist, "ENABLE_LIVE").status, "BLOCKED");
  });

  it("keeps dry-run providers in TODO/BLOCKED state instead of claiming live readiness", () => {
    const checklist = buildCourierOnboardingChecklist(snapshot({
      provider_key: "BIGSHIP",
      provider_label_internal: "Bigship",
      status: "READY_FOR_DRY_RUN",
      dimensions: [
        dim("CREDENTIALS", "FAIL", ["PROVIDER_CREDENTIALS_MISSING"]),
        dim("RATES", "WARN", [], ["Provider is certified for dry-run routing only."]),
        dim("AWB", "NOT_RUN", ["PROVIDER_AWB_NOT_CERTIFIED"]),
        dim("PUBLIC_SAFETY", "PASS")
      ],
      blockers: ["PROVIDER_CREDENTIALS_MISSING"],
      warnings: ["Provider is certified for dry-run routing only."]
    }));
    assert.equal(step(checklist, "CONNECT_CREDENTIALS").status, "TODO");
    assert.equal(step(checklist, "FETCH_LIVE_RATES").status, "READY");
    assert.equal(step(checklist, "ENABLE_PILOT").status, "TODO");
    assert.equal(step(checklist, "ENABLE_LIVE").status, "BLOCKED");
  });

  it("includes public safety certification for every checklist", () => {
    for (const provider_key of ["BIGSHIP", "SHIPMOZO", "SHIPROCKET"] as const) {
      const checklist = buildCourierOnboardingChecklist(snapshot({
        provider_key,
        provider_label_internal: provider_key
      }));
      assert.equal(step(checklist, "CERTIFY_PUBLIC_SAFETY").status, "DONE");
    }
  });

  it("summarizes providers without calling live provider APIs when snapshots are supplied", async () => {
    const result = await getCourierOnboardingSummary("merchant_1", {
      certifications: [
        snapshot(),
        snapshot({ provider_key: "SHIPMOZO", provider_label_internal: "Shipmozo", status: "READY_FOR_DRY_RUN" })
      ]
    });
    assert.equal(result.counts.total_providers, 2);
    assert.equal(result.counts.blocked, 1);
    assert.equal(result.counts.dry_run_only, 1);
    assert.ok(result.blockers.includes("PROVIDER_PICKUP_UNAVAILABLE"));
  });

  it("returns one provider checklist from an injected certification snapshot", async () => {
    const result = await getCourierOnboardingProvider("merchant_1", "SHIPROCKET", {
      certification: snapshot()
    });
    assert.equal(result.provider.provider_key, "SHIPROCKET");
    assert.equal(step(result.provider, "SYNC_PICKUPS").status, "BLOCKED");
  });

  it("redacts unsafe summary values from checklist serializers", () => {
    const checklist = buildCourierOnboardingChecklist(snapshot({
      dimensions: [
        dim("PUBLIC_SAFETY", "PASS", [], [], {
          safe_note: "visible",
          rawPayload: { token: "Bearer unsafe" },
          Authorization: "Bearer unsafe",
          credentialHash: "hash",
          nested: {
            providerPayload: "unsafe",
            ok: "visible child"
          }
        })
      ]
    }));
    const serialized = serializeCourierOnboardingChecklist(checklist);
    const json = JSON.stringify(serialized);
    assert.match(json, /visible/);
    assert.doesNotMatch(json, /rawPayload|Authorization|Bearer|credentialHash|providerPayload|token|secret|password/i);
  });

  it("registers authenticated shipping onboarding routes without seller API exposure", () => {
    const indexRoutes = readFileSync("src/routes/index.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");
    const onboardingRoutes = readFileSync("src/modules/courierPartners/onboarding/courier-onboarding.routes.ts", "utf8");
    const onboardingValidation = readFileSync("src/modules/courierPartners/onboarding/courier-onboarding.validation.ts", "utf8");
    assert.match(indexRoutes, /apiRouter\.use\("\/shipping", requireJwtAuth, shippingNetworkRouter\);/);
    assert.match(shippingRoutes, /courierOnboardingRouter/);
    assert.match(onboardingRoutes, /\/courier-onboarding\/providers/);
    assert.match(onboardingRoutes, /\/courier-onboarding\/summary/);
    assert.match(onboardingRoutes, /shipmentId: query\.shipment_id/);
    assert.match(onboardingRoutes, /pickupLocationId: query\.pickup_location_id/);
    assert.match(onboardingValidation, /include_pickup_probe/);
    assert.doesNotMatch(indexRoutes, /shipping\/seller-api.*courier-onboarding/);
  });
});
