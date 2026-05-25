import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getReturnsActionCenter } from "./returns.service.js";

const now = new Date("2026-05-18T10:00:00.000Z");

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_1",
    merchantId: "merchant_1",
    externalOrderId: "EXT-1",
    buyerName: "Safe Buyer",
    orderValue: 129900,
    paymentMode: "COD",
    status: "RTO",
    createdAt: now,
    updatedAt: now,
    shipmentDetails: {
      id: "shipment_1",
      merchantId: "merchant_1",
      courierId: "courier_1",
      awb: "AWB1234567890",
      trackingNumber: "TRK123",
      shipmentStatus: "RTO_IN_TRANSIT",
      rtoStatus: "RTO_INITIATED",
      rtoInitiatedAt: now,
      rtoDeliveredAt: null,
      updatedAt: now
    },
    ...overrides
  } as any;
}

describe("seller returns action center", () => {
  it("mounts merchant returns routes behind JWT auth", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const returnsRoutes = readFileSync("src/modules/returns/returns.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/returns", requireJwtAuth, returnsRouter\);/);
    assert.match(returnsRoutes, /returnsRouter\.get\("\/action-center"/);
    assert.match(returnsRoutes, /returnsRouter\.get\("\/summary"/);
    assert.match(returnsRoutes, /returnsRouter\.get\("\/"/);
  });

  it("returns a stable empty merchant-scoped response", async () => {
    const client = {
      order: {
        findMany: async (args: any) => {
          assert.equal(args.where.merchantId, "merchant_1");
          assert.equal(args.where.OR[1].shipmentDetails.is.merchantId, "merchant_1");
          return [];
        }
      }
    };

    const result = await getReturnsActionCenter("merchant_1", client as any);

    assert.deepEqual(result.summary, {
      openRmas: 0,
      open: 0,
      exchanges: 0,
      storeCredits: 0,
      totalReverseRequests: 0,
      total: 0
    });
    assert.deepEqual(result.requests, []);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.returns, []);
    assert.deepEqual(result.rmas, []);
    assert.deepEqual(result.exchanges, []);
    assert.deepEqual(result.credits, []);
    assert.equal(result.count, 0);
  });

  it("returns only own reverse requests with seller-safe fields", async () => {
    const client = {
      order: {
        findMany: async () => [
          makeOrder(),
          makeOrder({
            id: "order_other",
            merchantId: "merchant_2",
            externalOrderId: "EXT-OTHER",
            buyerName: "Other Merchant Buyer",
            shipmentDetails: { ...makeOrder().shipmentDetails, id: "shipment_other", merchantId: "merchant_2" },
            rawCourierPayload: "must-not-leak"
          })
        ]
      }
    };

    const result = await getReturnsActionCenter("merchant_1", client as any);
    const serialized = JSON.stringify(result);

    assert.equal(result.count, 1);
    assert.equal(result.summary.openRmas, 1);
    assert.equal(result.summary.totalReverseRequests, 1);
    assert.equal(result.summary.storeCredits, 1);
    assert.equal(result.requests[0]?._id, "order_1");
    assert.equal(result.requests[0]?.rmaNumber, "RMA-EXT-1");
    assert.equal(result.requests[0]?.awbNumber, "AWB1234567890");
    assert.equal(result.requests[0]?.refundDisposition, "store_credit");
    assert.equal(result.requests[0]?.amount, 1299);
    assert.equal(result.requests[0]?.amountPaise, 129900);
    assert.equal(serialized.includes("merchant_2"), false);
    assert.equal(serialized.includes("Other Merchant Buyer"), false);
    assert.equal(serialized.includes("must-not-leak"), false);
  });

  it("keeps resolved RTO rows out of the open RMA count", async () => {
    const client = {
      order: {
        findMany: async () => [
          makeOrder({
            shipmentDetails: {
              ...makeOrder().shipmentDetails,
              shipmentStatus: "RTO_DELIVERED",
              rtoStatus: "RTO_DELIVERED",
              rtoDeliveredAt: now
            }
          })
        ]
      }
    };

    const result = await getReturnsActionCenter("merchant_1", client as any);

    assert.equal(result.summary.openRmas, 0);
    assert.equal(result.summary.totalReverseRequests, 1);
    assert.equal(result.requests[0]?.status, "resolved");
  });
});
