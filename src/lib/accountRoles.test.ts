import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ActorType, actorTypeForAccount, canonicalRoleForAccount, dashboardPathForRole, UserRole } from "./accountRoles.js";
import { shipmastrActorModel } from "./actorModel.js";

describe("Shipmastr actor model", () => {
  it("lands hosted commerce Merchants in the Merchant Panel", () => {
    assert.equal(actorTypeForAccount({ role: "MERCHANT_OWNER" }), ActorType.MERCHANT);
    assert.equal(canonicalRoleForAccount({ role: "MERCHANT_OWNER" }), UserRole.MERCHANT_OWNER);
    assert.equal(dashboardPathForRole("MERCHANT_OWNER"), "/merchant");
  });

  it("lands external-store Sellers in the Seller Panel", () => {
    assert.equal(actorTypeForAccount({ role: "SELLER_OWNER" }), ActorType.SELLER);
    assert.equal(canonicalRoleForAccount({ role: "SELLER_OWNER" }), UserRole.SELLER_OWNER);
    assert.equal(dashboardPathForRole("SELLER_OWNER"), "/seller/dashboard");
  });

  it("lands Courier Partner users in the Courier Partner Panel", () => {
    assert.equal(actorTypeForAccount({ role: "COURIER_OPS" }), ActorType.COURIER_PARTNER);
    assert.equal(canonicalRoleForAccount({ role: "COURIER_OPS" }), UserRole.COURIER_OPS);
    assert.equal(dashboardPathForRole("COURIER_OPS"), "/courier/dashboard");
  });

  it("keeps legacy external merchant rows seller-scoped until explicit Merchant readiness", () => {
    assert.equal(actorTypeForAccount({ role: "EXTERNAL_MERCHANT", onboardingStatus: "IN_PROGRESS" }), ActorType.SELLER);
    assert.equal(actorTypeForAccount({ role: "EXTERNAL_MERCHANT", onboardingStatus: "READY_TO_SHIP" }), ActorType.MERCHANT);
  });

  it("documents feature boundaries for all three non-admin actors", () => {
    const merchantRoutes = shipmastrActorModel.MERCHANT.features.map((feature) => feature.route);
    const sellerRoutes = shipmastrActorModel.SELLER.features.map((feature) => feature.route);
    const courierRoutes = shipmastrActorModel.COURIER_PARTNER.features.map((feature) => feature.route);

    assert.ok(merchantRoutes.includes("/merchant/website"));
    assert.ok(merchantRoutes.includes("/merchant/products"));
    assert.ok(!sellerRoutes.some((route) => route.startsWith("/merchant/website")));

    assert.ok(sellerRoutes.includes("/seller/apps"));
    assert.ok(sellerRoutes.includes("/seller/finance/reconciliation"));
    assert.ok(!courierRoutes.some((route) => route.startsWith("/seller")));

    assert.ok(courierRoutes.includes("/courier/docs"));
    assert.ok(courierRoutes.includes("/courier/invoices"));
    assert.ok(!courierRoutes.some((route) => route.startsWith("/merchant")));
  });
});
