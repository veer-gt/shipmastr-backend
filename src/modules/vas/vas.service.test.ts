import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getVasActionCenter } from "./vas.service.js";

const merchant = {
  id: "merchant_1",
  name: "Skymax",
  onboardingStatus: "READY_TO_SHIP"
};

function makeClient(overrides: Record<string, unknown> = {}) {
  const client = {
    merchant: {
      findUnique: async (args: any) => {
        assert.deepEqual(args.where, { id: "merchant_1" });
        assert.deepEqual(args.select, {
          id: true,
          name: true,
          onboardingStatus: true
        });
        return merchant;
      }
    },
    merchantTrustProfile: {
      findUnique: async (args: any) => {
        assert.deepEqual(args.where, { merchantId: "merchant_1" });
        assert.equal(args.select.metadata, undefined);
        return null;
      }
    },
    sellerWalletLedger: {
      findFirst: async (args: any) => {
        assert.deepEqual(args.where, { merchantId: "merchant_1" });
        assert.deepEqual(args.select, { balanceAfter: true });
        return null;
      }
    },
    ...overrides
  };

  return client;
}

describe("seller VAS action center", () => {
  it("mounts VAS routes behind JWT auth and keeps the existing finance products path", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const financeRoutes = readFileSync("src/modules/sellerSettlements/finance.routes.ts", "utf8");
    const vasRoutes = readFileSync("src/modules/vas/vas.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/vas", requireJwtAuth, vasRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/value-added-services", requireJwtAuth, vasRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/finance", requireJwtAuth, financeRouter\);/);
    assert.match(financeRoutes, /financeRouter\.get\("\/products"/);
    assert.match(vasRoutes, /vasRouter\.get\("\/action-center"/);
    assert.match(vasRoutes, /vasRouter\.get\("\/products"/);
  });

  it("returns a stable empty merchant-scoped response when no products are enabled", async () => {
    const result = await getVasActionCenter("merchant_1", makeClient() as any);

    assert.deepEqual(result.summary, {
      settlementProducts: 0,
      insurancePlans: 0,
      capitalProducts: 0,
      capitalScore: 0,
      capitalEnvelope: 0,
      capitalEnvelopePaise: 0
    });
    assert.deepEqual(result.settlementProducts, []);
    assert.deepEqual(result.insuranceProducts, []);
    assert.deepEqual(result.capitalProducts, []);
    assert.deepEqual(result.recommendations, []);
    assert.equal(result.capitalProfile.maxEligibleAmount, 0);
    assert.equal(result.capitalProfile.maxEligibleAmountPaise, 0);
  });

  it("uses only own merchant eligibility signals for the seller-safe capital profile", async () => {
    const client = makeClient({
      merchantTrustProfile: {
        findUnique: async (args: any) => {
          assert.deepEqual(args.where, { merchantId: "merchant_1" });
          assert.equal(args.select.metadata, undefined);
          assert.equal(args.select.reasons, undefined);
          return {
            merchantId: "merchant_1",
            tier: "GOLD",
            trustScore: 82,
            totalOrders: 250,
            codExposure: 200000,
            reliabilityScore: 91,
            internalRiskTrace: "must-not-leak"
          };
        }
      },
      sellerWalletLedger: {
        findFirst: async () => ({ balanceAfter: 10000 })
      }
    });

    const result = await getVasActionCenter("merchant_1", client as any);
    const serialized = JSON.stringify(result);

    assert.equal(result.summary.capitalScore, 82);
    assert.equal(result.summary.capitalEnvelope, 51000);
    assert.equal(result.summary.capitalEnvelopePaise, 5100000);
    assert.equal(result.capitalProfile.eligible, true);
    assert.equal(result.capitalProfile.band, "gold");
    assert.equal(result.recommendations.length, 1);
    assert.equal(serialized.includes("merchant_2"), false);
    assert.equal(serialized.includes("must-not-leak"), false);
    assert.equal(serialized.includes("internalRiskTrace"), false);
  });

  it("rejects missing or wrong merchant scope", async () => {
    await assert.rejects(
      () => getVasActionCenter("", makeClient() as any),
      /MERCHANT_SCOPE_REQUIRED/
    );

    await assert.rejects(
      () => getVasActionCenter("merchant_1", makeClient({
        merchant: {
          findUnique: async () => ({ ...merchant, id: "merchant_2" })
        }
      }) as any),
      /MERCHANT_SCOPE_REQUIRED/
    );
  });
});
