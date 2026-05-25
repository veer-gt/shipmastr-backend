import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { HttpError } from "../../lib/httpError.js";
import { getNdrActionCenter, resolveNdrEvent } from "./ndr.service.js";

const now = new Date("2026-05-18T10:00:00.000Z");

function makeNdrEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "ndr_1",
    merchantId: "merchant_1",
    orderId: "order_1",
    courierId: "courier_1",
    pincode: "560001",
    reason: "BUYER_UNAVAILABLE",
    actionRequired: "Review reattempt action",
    metadata: {},
    createdAt: new Date("2026-05-18T09:00:00.000Z"),
    updatedAt: new Date("2026-05-18T09:05:00.000Z"),
    ...overrides
  } as any;
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_1",
    merchantId: "merchant_1",
    externalOrderId: "EXT-1",
    pincode: "560001",
    city: "Bengaluru",
    state: "KA",
    status: "NDR",
    shipmentDetails: {
      awb: "AWB123",
      trackingNumber: "TRK123",
      courierId: "courier_1",
      pincode: "560001",
      city: "Bengaluru",
      state: "KA",
      shipmentStatus: "NDR",
      ndrStatus: "open",
      firstAttemptAt: null,
      estimatedDeliveryDate: null
    },
    ...overrides
  } as any;
}

describe("NDR action center", () => {
  it("mounts seller NDR routes behind JWT auth", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const ndrRoutes = readFileSync("src/modules/ndr/ndr.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/ndr", requireJwtAuth, ndrRouter\);/);
    assert.match(ndrRoutes, /ndrRouter\.get\("\/action-center"/);
    assert.match(ndrRoutes, /ndrRouter\.post\("\/bulk-resolve"/);
    assert.match(ndrRoutes, /ndrRouter\.post\("\/:id\/resolve"/);
  });

  it("returns a stable empty merchant-scoped response when no NDR events exist", async () => {
    const client = {
      ndrEvent: {
        findMany: async (args: any) => {
          assert.deepEqual(args.where, { merchantId: "merchant_1" });
          return [];
        },
        findFirst: async () => null,
        update: async () => {
          throw new Error("not expected");
        }
      },
      order: {
        findMany: async () => {
          throw new Error("orders should not be queried without events");
        }
      }
    };

    const result = await getNdrActionCenter("merchant_1", client as any, now);

    assert.deepEqual(result.summary, {
      open: 0,
      inProgress: 0,
      awaitingBuyerAction: 0,
      resolved: 0,
      slaBreached: 0,
      fakeAttemptSignals: 0
    });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.events, []);
    assert.equal(result.count, 0);
  });

  it("filters accidental cross-merchant records before building seller-safe NDR items", async () => {
    const client = {
      ndrEvent: {
        findMany: async (args: any) => {
          assert.deepEqual(args.where, { merchantId: "merchant_1" });
          return [
            makeNdrEvent(),
            makeNdrEvent({ id: "ndr_other", merchantId: "merchant_2", orderId: "order_2" })
          ];
        },
        findFirst: async () => null,
        update: async () => {
          throw new Error("not expected");
        }
      },
      order: {
        findMany: async (args: any) => {
          assert.deepEqual(args.where, { merchantId: "merchant_1", id: { in: ["order_1"] } });
          return [
            makeOrder(),
            makeOrder({ id: "order_2", merchantId: "merchant_2", externalOrderId: "EXT-2" })
          ];
        }
      }
    };

    const result = await getNdrActionCenter("merchant_1", client as any, now);

    assert.equal(result.count, 1);
    assert.equal(result.items[0]?.id, "ndr_1");
    assert.equal(result.items[0]?.shipment.awbNumber, "AWB123");
    assert.equal(result.items[0]?.shipment.toPincode, "560001");
  });

  it("scopes NDR resolution updates to the authenticated merchant", async () => {
    let findFirstArgs: any;
    let updateArgs: any;
    const client = {
      ndrEvent: {
        findMany: async () => [],
        findFirst: async (args: any) => {
          findFirstArgs = args;
          return makeNdrEvent({ metadata: { eventType: "ndr_created" } });
        },
        update: async (args: any) => {
          updateArgs = args;
          return makeNdrEvent(args.data);
        }
      },
      order: {
        findMany: async () => []
      }
    };

    await resolveNdrEvent("merchant_1", "ndr_1", {
      preferredAction: "reschedule",
      preferredSlot: "Tomorrow 2pm to 6pm",
      note: "Buyer confirmed",
      attempted: true
    }, client as any);

    assert.deepEqual(findFirstArgs.where, { id: "ndr_1", merchantId: "merchant_1" });
    assert.equal(updateArgs.where.id, "ndr_1");
    assert.equal(updateArgs.data.actionRequired, "reschedule");
    assert.equal(updateArgs.data.metadata.eventType, "ndr_created");
    assert.equal(updateArgs.data.metadata.resolution.preferredAction, "reschedule");
    assert.equal(updateArgs.data.metadata.resolution.preferredSlot, "Tomorrow 2pm to 6pm");
  });

  it("rejects a wrong-merchant NDR resolution with 404", async () => {
    const client = {
      ndrEvent: {
        findMany: async () => [],
        findFirst: async (args: any) => {
          assert.deepEqual(args.where, { id: "ndr_2", merchantId: "merchant_1" });
          return null;
        },
        update: async () => {
          throw new Error("not expected");
        }
      },
      order: {
        findMany: async () => []
      }
    };

    await assert.rejects(
      () => resolveNdrEvent("merchant_1", "ndr_2", { preferredAction: "reattempt" }, client as any),
      (error) => error instanceof HttpError && error.status === 404 && error.message === "NDR_EVENT_NOT_FOUND"
    );
  });
});
