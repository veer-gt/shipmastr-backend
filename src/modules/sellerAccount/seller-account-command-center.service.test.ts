import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSellerAccountCommandCenter } from "./seller-account-command-center.service.js";

function countFrom(map: Record<string, number>) {
  return async ({ where }: any = {}) => {
    const status = where?.status;
    const key = (Array.isArray(status?.in) ? status.in.join("|") : undefined)
      ?? (typeof status === "string" ? status : undefined)
      ?? where?.imageRetentionStatus
      ?? (where?.OR ? "OR" : "total");
    return map[key] ?? 0;
  };
}

function makeClient(overrides: Record<string, any> = {}) {
  return {
    merchant: {
      findUnique: async ({ where }: any) => {
        assert.equal(where.id, "seller_1");
        return {
          id: "seller_1",
          name: "Safe Seller",
          onboardingStatus: "IN_PROGRESS",
          pickupAddressStatus: "COMPLETED",
          kycStatus: "IN_PROGRESS",
          bankStatus: "PENDING",
          firstShipmentStatus: "PENDING",
          sellerKycStatus: "DETAILS_SUBMITTED"
        };
      }
    },
    order: {
      count: countFrom({
        total: 8,
        "CREATED|RISK_SCORED|VERIFIED|HELD|NEEDS_ATTENTION": 3,
        READY_TO_SHIP: 2,
        "HELD|NEEDS_ATTENTION|NDR|RTO": 1
      })
    },
    shipment: {
      count: countFrom({
        total: 5,
        "draft|rates_fetched|manifested|pickup_scheduled": 2,
        "picked_up|in_transit|out_for_delivery": 1,
        delivered: 1,
        "rto_initiated|rto_in_transit|rto_delivered|cancelled": 1,
        "delivery_failed|lost|damaged|exception": 1
      })
    },
    pickupLocation: { count: async () => 1 },
    ndrCase: { count: async () => 1 },
    rtoCase: { count: async () => 1 },
    codLedgerEntry: {
      count: countFrom({
        "pending|due|delayed": 2,
        "collected|remitted": 1
      })
    },
    sellerWalletLedger: {
      count: async () => 3,
      findFirst: async () => ({
        balanceAfter: 1200,
        currency: "INR",
        status: "POSTED",
        postedAt: new Date("2026-06-29T09:00:00.000Z"),
        createdAt: new Date("2026-06-29T08:00:00.000Z")
      })
    },
    shippingWeightProof: {
      count: countFrom({
        ACTIVE: 1,
        OR: 1
      })
    },
    ...overrides
  };
}

describe("seller account command center", () => {
  it("mounts the read-only seller account route behind JWT auth", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    assert.match(routes, /apiRouter\.use\("\/seller\/account", requireJwtAuth, sellerAccountRouter\);/);
  });

  it("builds a seller-scoped command center response without provider or secret leaks", async () => {
    const result = await buildSellerAccountCommandCenter("seller_1", makeClient() as any);
    const serialized = JSON.stringify(result);

    assert.equal(result.seller.id, "seller_1");
    assert.equal(result.orderSummary.total, 8);
    assert.equal(result.orderSummary.readyToShip, 2);
    assert.equal(result.unifiedQueues.find((queue: any) => queue.key === "ready-to-ship")?.count, 4);
    assert.equal(result.unifiedQueues.find((queue: any) => queue.key === "needs-attention")?.count, 2);
    assert.equal(result.unifiedQueues.find((queue: any) => queue.key === "weight-guard-captured")?.count, 2);
    assert.equal(result.shipmentSummary.inTransit, 1);
    assert.equal(result.ndrSummary.open, 1);
    assert.equal(result.returnsSummary.open, 1);
    assert.equal(result.weightGuardSummary.proofCaptured, 1);
    assert.equal(result.weightGuardSummary.proofArchivedAfterPayout, 1);
    assert.equal(result.weightGuardSummary.uploadMode, "backend_mediated");
    assert.equal(result.weightGuardSummary.directSignedUpload, "parked");
    assert.equal(result.pickupWarehouseSummary.status, "ready");
    assert.ok(result.nextActions.length > 0);
    assert.equal(serialized.includes("courierPartner"), false);
    assert.equal(serialized.includes("provider"), false);
    assert.equal(serialized.includes("objectKey"), false);
    assert.equal(serialized.includes("bucket"), false);
    assert.equal(serialized.includes("signedUrl"), false);
    assert.equal(serialized.includes("Bearer"), false);
    assert.equal(serialized.includes("secret"), false);
  });

  it("orders setup, operations, wallet, and Weight Guard next actions deterministically", async () => {
    const result = await buildSellerAccountCommandCenter("seller_1", makeClient({
      sellerWalletLedger: {
        count: async () => 1,
        findFirst: async () => ({
          balanceAfter: 100,
          currency: "INR",
          status: "POSTED",
          postedAt: new Date("2026-06-29T09:00:00.000Z"),
          createdAt: new Date("2026-06-29T08:00:00.000Z")
        })
      },
      shippingWeightProof: {
        count: countFrom({
          ACTIVE: 0,
          OR: 0
        })
      }
    }) as any);

    assert.deepEqual(result.nextActions.map((action: any) => action.key).slice(0, 4), [
      "setup-kyc",
      "needs-attention",
      "ready-to-ship",
      "exceptions"
    ]);
    assert.ok(result.nextActions.some((action: any) => action.key === "wallet-review"));
    assert.ok(result.nextActions.some((action: any) => action.key === "weight-guard-proof-missing"));
    assert.equal(result.unifiedQueues.find((queue: any) => queue.key === "wallet")?.count, 1);
    assert.equal(result.unifiedQueues.find((queue: any) => queue.key === "weight-guard-missing")?.count, 5);
  });

  it("degrades safely when optional modules are missing", async () => {
    const result = await buildSellerAccountCommandCenter("seller_1", {
      merchant: makeClient().merchant
    } as any);

    assert.equal(result.orderSummary.total, 0);
    assert.equal(result.shipmentSummary.total, 0);
    assert.equal(result.walletSummary.status, "no_activity");
    assert.equal(result.codSummary.status, "no_activity");
    assert.equal(result.weightGuardSummary.status, "no_activity");
    assert.equal(result.pickupWarehouseSummary.status, "needs_setup");
  });

  it("keeps Weight Guard deleted-image metadata seller safe", async () => {
    const result = await buildSellerAccountCommandCenter("seller_1", makeClient({
      shippingWeightProof: {
        count: countFrom({
          ACTIVE: 0,
          OR: 2
        })
      }
    }) as any);

    assert.equal(result.weightGuardSummary.proofCaptured, 0);
    assert.equal(result.weightGuardSummary.proofArchivedAfterPayout, 2);
    assert.equal(result.weightGuardSummary.status, "evidence_available");
    assert.equal("imageObjectKey" in result.weightGuardSummary, false);
  });
});
