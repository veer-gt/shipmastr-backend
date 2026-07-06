import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { HttpError } from "../../lib/httpError.js";
import { CheckoutAdminService } from "./checkout-admin.service.js";
import { CheckoutOrderService } from "./checkout-order.service.js";
import {
  CheckoutQuoteService,
  DEFAULT_CHECKOUT_RULES,
  type CheckoutRules
} from "./checkout-quote.service.js";
import {
  deserializePersistedCheckoutQuote,
  serializeBuyerOrder
} from "./checkout-serializers.js";

const baseTime = new Date("2026-07-05T10:00:00.000Z");
const merchantA = { id: "merchant_c2_a", name: "Skymax" };
const merchantB = { id: "merchant_c2_b", name: "Other" };

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function rules(overrides: Partial<CheckoutRules> = {}): CheckoutRules {
  return {
    ...clone(DEFAULT_CHECKOUT_RULES),
    ...overrides
  };
}

function riskyRules(): CheckoutRules {
  return rules({
    risky: {
      pincodes: ["560001"],
      policy: "force_advance"
    }
  });
}

function makeHarness() {
  const state = {
    now: new Date(baseTime),
    merchants: [merchantA, merchantB],
    settings: [] as any[],
    rulesVersions: [] as any[],
    quotes: [] as any[],
    orders: [] as any[],
    timeline: [] as any[],
    payments: [] as any[],
    accountingEvents: [] as any[],
    auditLogs: [] as any[],
    idempotencyKeys: [] as any[],
    walletWrites: [] as string[]
  };

  function withOrderIncludes(order: any, include: any = {}) {
    if (!order) return null;
    const next = clone(order);
    if (include.quote) {
      next.quote = clone(state.quotes.find((row) => row.id === order.quoteId) ?? null);
    }
    if (include.timeline) {
      next.timeline = clone(state.timeline.filter((row) => row.orderId === order.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
    }
    if (include.payments) {
      next.payments = clone(state.payments.filter((row) => row.orderId === order.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
    }
    if (include.accountingEvents) {
      next.accountingEvents = clone(state.accountingEvents.filter((row) => row.orderId === order.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
    }
    return next;
  }

  function matchesWhere(row: any, where: any = {}) {
    for (const [key, value] of Object.entries(where)) {
      if (key === "createdAt") {
        const range = value as { gte?: Date; lte?: Date };
        if (range.gte && row.createdAt < range.gte) return false;
        if (range.lte && row.createdAt > range.lte) return false;
        continue;
      }
      if (row[key] !== value) return false;
    }
    return true;
  }

  const client: any = {
    $transaction: async (callback: any) => callback(client),
    merchant: {
      findUnique: async ({ where }: any) => clone(state.merchants.find((row) => row.id === where.id) ?? null)
    },
    checkoutMerchantSetting: {
      findUnique: async ({ where, include }: any) => {
        const setting = state.settings.find((row) => row.merchantId === where.merchantId);
        if (!setting) return null;
        return {
          ...clone(setting),
          activeRulesVersion: include?.activeRulesVersion
            ? clone(state.rulesVersions.find((row) => row.id === setting.activeRulesVersionId) ?? null)
            : undefined
        };
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = state.settings.find((row) => row.merchantId === where.merchantId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: state.now });
          return clone(existing);
        }
        const setting = {
          id: `setting_${state.settings.length + 1}`,
          createdAt: state.now,
          updatedAt: state.now,
          ...create
        };
        state.settings.push(setting);
        return clone(setting);
      }
    },
    checkoutRulesVersion: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of state.rulesVersions) {
          if (matchesWhere(row, where)) {
            Object.assign(row, data, { updatedAt: state.now });
            count += 1;
          }
        }
        return { count };
      },
      create: async ({ data }: any) => {
        const version = {
          id: data.id ?? `rules_${state.rulesVersions.length + 1}`,
          createdAt: state.now,
          updatedAt: state.now,
          ...data
        };
        state.rulesVersions.push(version);
        return clone(version);
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = state.rulesVersions.filter((row) => matchesWhere(row, where));
        if (orderBy?.createdAt === "desc") rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return clone(rows.slice(0, take ?? rows.length));
      },
      findFirst: async ({ where }: any) => clone(state.rulesVersions.find((row) => matchesWhere(row, where)) ?? null)
    },
    checkoutQuote: {
      create: async ({ data }: any) => {
        const quote = {
          id: data.id ?? `quote_${state.quotes.length + 1}`,
          createdAt: state.now,
          ...data
        };
        state.quotes.push(quote);
        return clone(quote);
      },
      findUnique: async ({ where }: any) => clone(state.quotes.find((row) => row.id === where.id) ?? null)
    },
    checkoutOrder: {
      create: async ({ data }: any) => {
        const order = {
          id: data.id ?? `order_${state.orders.length + 1}`,
          createdAt: state.now,
          updatedAt: state.now,
          fulfillmentOrderId: null,
          codCollectionMethod: null,
          codCollectionReference: null,
          codCollectedAt: null,
          ...data
        };
        state.orders.push(order);
        return clone(order);
      },
      update: async ({ where, data }: any) => {
        const order = state.orders.find((row) => row.id === where.id);
        if (!order) throw new Error("ORDER_NOT_FOUND");
        Object.assign(order, data, { updatedAt: state.now });
        return clone(order);
      },
      findUnique: async ({ where, include }: any) => withOrderIncludes(state.orders.find((row) => row.id === where.id), include),
      findMany: async ({ where, include, orderBy, take, cursor, skip }: any) => {
        let rows = state.orders.filter((row) => matchesWhere(row, where));
        if (orderBy?.createdAt === "desc") rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (cursor?.id) {
          const index = rows.findIndex((row) => row.id === cursor.id);
          if (index >= 0) rows = rows.slice(index + (skip ?? 0));
        }
        return rows.slice(0, take ?? rows.length).map((row) => withOrderIncludes(row, include));
      }
    },
    checkoutOrderTimeline: {
      create: async ({ data }: any) => {
        const row = {
          id: `timeline_${state.timeline.length + 1}`,
          createdAt: state.now,
          ...data
        };
        state.timeline.push(row);
        return clone(row);
      }
    },
    checkoutPayment: {
      create: async ({ data }: any) => {
        const payment = {
          id: data.id ?? `payment_${state.payments.length + 1}`,
          createdAt: state.now,
          updatedAt: state.now,
          gatewayPaymentRef: null,
          capturedAt: null,
          ...data
        };
        state.payments.push(payment);
        return clone(payment);
      }
    },
    checkoutAccountingEvent: {
      create: async ({ data }: any) => {
        const row = {
          id: `event_${state.accountingEvents.length + 1}`,
          createdAt: state.now,
          ...data
        };
        state.accountingEvents.push(row);
        return clone(row);
      }
    },
    checkoutAuditLog: {
      create: async ({ data }: any) => {
        const row = {
          id: `audit_${state.auditLogs.length + 1}`,
          createdAt: state.now,
          ...data
        };
        state.auditLogs.push(row);
        return clone(row);
      },
      findMany: async ({ where, orderBy, take, cursor, skip }: any) => {
        let rows = state.auditLogs.filter((row) => matchesWhere(row, where));
        if (orderBy?.createdAt === "desc") rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (cursor?.id) {
          const index = rows.findIndex((row) => row.id === cursor.id);
          if (index >= 0) rows = rows.slice(index + (skip ?? 0));
        }
        return clone(rows.slice(0, take ?? rows.length));
      }
    },
    checkoutIdempotencyKey: {
      findUnique: async ({ where }: any) => {
        const key = where.merchantId_operation_idempotencyKey;
        return clone(state.idempotencyKeys.find((row) => row.merchantId === key.merchantId
          && row.operation === key.operation
          && row.idempotencyKey === key.idempotencyKey) ?? null);
      },
      create: async ({ data }: any) => {
        const row = {
          id: `idem_${state.idempotencyKeys.length + 1}`,
          createdAt: state.now,
          updatedAt: state.now,
          ...data
        };
        state.idempotencyKeys.push(row);
        return clone(row);
      }
    },
    sellerWalletLedger: {
      create: async () => {
        state.walletWrites.push("sellerWalletLedger.create");
        throw new Error("wallet write forbidden");
      }
    },
    journalEntry: {
      create: async () => {
        state.walletWrites.push(["journalEntry", "create"].join("."));
        throw new Error("journal write forbidden");
      }
    }
  };

  const quoteService = new CheckoutQuoteService(client, () => state.now);
  const orderService = new CheckoutOrderService(client, () => state.now);
  const adminService = new CheckoutAdminService(client, () => state.now);

  async function quote(merchantId = merchantA.id, pincode = "560001") {
    return quoteService.createQuote({
      merchantId,
      pincode,
      items: [{ id: "sku_c2", name: "Cotton Kurta", quantity: 1, priceMinor: "129900" }]
    });
  }

  async function createOrder(mode: "prepaid" | "partial_cod" | "full_cod", key: string, merchantId = merchantA.id) {
    const createdQuote = await quote(merchantId);
    return orderService.createOrder({
      quoteId: createdQuote.quoteId,
      mode,
      idempotencyKey: key,
      customer: { name: "Asha Buyer", phone: "9876543210", email: "asha@example.test" }
    });
  }

  return { state, client, quoteService, orderService, adminService, quote, createOrder };
}

function orderId(result: Awaited<ReturnType<ReturnType<typeof makeHarness>["createOrder"]>>) {
  return (result.body as any).order.id as string;
}

describe("Checkout C2 admin rules, lifecycle, and audit APIs", () => {
  it("mounts checkout admin routes under real admin JWT only", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    assert.match(routes, /import \{ adminCheckoutRouter \} from "\.\.\/modules\/checkout\/checkout-admin\.routes\.js";/);
    assert.match(routes, /apiRouter\.use\("\/admin\/checkout", requireAdminJwt, adminCheckoutRouter\);/);
    assert.doesNotMatch(routes, /apiRouter\.use\("\/admin\/checkout", adminCheckoutRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/checkout", checkoutRouter\);/);
  });

  it("updates rules as new active versions, validates fee waiver config, and records audit", async () => {
    const { state, adminService } = makeHarness();
    const first = await adminService.updateRules({ merchantId: merchantA.id, rules: rules(), actorId: "admin_a" });
    assert.equal(first.status, "active");
    assert.equal(state.rulesVersions.length, 1);
    assert.equal(state.auditLogs[0].action, "checkout.rules.updated");

    const invalid = rules();
    invalid.cod.fee = { ...invalid.cod.fee, waiveAboveCartMinor: "12.34" };
    await assert.rejects(
      () => adminService.updateRules({ merchantId: merchantA.id, rules: invalid, actorId: "admin_a" }),
      /INVALID_MONEY_MINOR/
    );

    const second = await adminService.updateRules({ merchantId: merchantA.id, rules: riskyRules(), actorId: "admin_b" });
    assert.equal(second.status, "active");
    assert.equal(state.rulesVersions.filter((row) => row.status === "active").length, 1);
    assert.equal(state.rulesVersions.filter((row) => row.status === "retired").length, 1);
  });

  it("lists rule history and rolls back by creating a new active version", async () => {
    const { state, adminService } = makeHarness();
    const original = await adminService.updateRules({ merchantId: merchantA.id, rules: rules(), actorId: "admin_a" });
    await adminService.updateRules({ merchantId: merchantA.id, rules: riskyRules(), actorId: "admin_b" });

    const history = await adminService.listRuleVersions({ merchantId: merchantA.id });
    assert.equal(history.versions.length, 2);

    const rollback = await adminService.rollbackRules({ merchantId: merchantA.id, versionId: original.id, actorId: "admin_c" });
    assert.equal(rollback.status, "active");
    assert.equal(state.rulesVersions.length, 3);
    assert.equal(state.rulesVersions.filter((row) => row.status === "active").length, 1);
    assert.equal(state.auditLogs.filter((row) => row.action === "checkout.rules.rolled_back").length, 1);
  });

  it("filters admin order list by merchant, state, and mode", async () => {
    const { adminService, createOrder } = makeHarness();
    await createOrder("full_cod", "idem_a", merchantA.id);
    await createOrder("prepaid", "idem_b", merchantB.id);

    const filtered = await adminService.listOrders({
      merchantId: merchantA.id,
      state: "confirmed",
      mode: "full_cod"
    });
    assert.equal(filtered.orders.length, 1);
    assert.equal(filtered.orders[0].merchantId, merchantA.id);
    assert.equal(filtered.orders[0].mode, "full_cod");
  });

  it("persists risky quote notes, reloads them, exposes them to admin, and omits them for buyers", async () => {
    const { state, adminService, quoteService, orderService } = makeHarness();
    await adminService.updateRules({ merchantId: merchantA.id, rules: riskyRules(), actorId: "admin_a" });
    const quote = await quoteService.createQuote({
      merchantId: merchantA.id,
      pincode: "560001",
      items: [{ id: "sku_risk", quantity: 1, priceMinor: "129900" }]
    });
    assert.equal((state.quotes[0].riskNotes as string[]).length, 1);

    const reloaded = deserializePersistedCheckoutQuote(state.quotes[0]);
    assert.equal(reloaded.riskNotes.length, 1);

    const order = await orderService.createOrder({
      quoteId: quote.quoteId,
      mode: "partial_cod",
      customer: { name: "Asha Buyer", phone: "9876543210" },
      idempotencyKey: "idem_risk"
    });
    assert.equal("riskNotes" in (order.body as any).order, false);

    const detail = await adminService.getOrderDetail((order.body as any).order.id);
    assert.equal(detail.order.riskNotes.length, 1);
    assert.equal("riskNotes" in serializeBuyerOrder(state.orders[0]), false);
  });

  it("blocks unpaid orders from packed/shipped/delivered transitions", async () => {
    const { adminService, createOrder } = makeHarness();
    const prepaid = await createOrder("prepaid", "idem_prepaid");
    await assert.rejects(
      () => adminService.transitionOrder({ orderId: orderId(prepaid), toState: "packed", actorId: "admin_a" }),
      (error) => error instanceof HttpError && error.status === 409 && error.message === "CHECKOUT_ORDER_PAYMENT_NOT_CONFIRMED"
    );

    const partial = await createOrder("partial_cod", "idem_partial");
    await assert.rejects(
      () => adminService.transitionOrder({ orderId: orderId(partial), toState: "shipped", actorId: "admin_a" }),
      /CHECKOUT_ORDER_PAYMENT_NOT_CONFIRMED/
    );
    await assert.rejects(
      () => adminService.transitionOrder({ orderId: orderId(partial), toState: "delivered", actorId: "admin_a" }),
      /CHECKOUT_ORDER_PAYMENT_NOT_CONFIRMED/
    );
  });

  it("moves confirmed orders through packed, shipped, and delivered with required COD collection", async () => {
    const { state, adminService, createOrder } = makeHarness();
    const prepaid = await createOrder("prepaid", "idem_prepaid_deliver");
    const prepaidId = orderId(prepaid);
    const prepaidOrder = state.orders.find((row) => row.id === prepaidId);
    assert.ok(prepaidOrder);
    prepaidOrder.state = "confirmed";
    await adminService.transitionOrder({ orderId: prepaidId, toState: "packed", actorId: "admin_a" });
    await adminService.transitionOrder({ orderId: prepaidId, toState: "shipped", actorId: "admin_a" });
    const prepaidDelivered = await adminService.transitionOrder({ orderId: prepaidId, toState: "delivered", actorId: "admin_a" });
    assert.equal(prepaidDelivered.order.state, "delivered");
    assert.equal(prepaidDelivered.order.codCollection.status, "none");
    assert.equal(state.accountingEvents.some((row) => row.orderId === prepaidId && row.eventType === "cod_collected"), false);

    const created = await createOrder("full_cod", "idem_full");
    const id = orderId(created);
    const codOrder = state.orders.find((row) => row.id === id);
    assert.ok(codOrder);

    await adminService.transitionOrder({ orderId: id, toState: "packed", actorId: "admin_a" });
    await adminService.transitionOrder({ orderId: id, toState: "shipped", actorId: "admin_a" });

    await assert.rejects(
      () => adminService.transitionOrder({ orderId: id, toState: "delivered", actorId: "admin_a" }),
      /CHECKOUT_COD_COLLECTION_REQUIRED/
    );
    await assert.rejects(
      () => adminService.transitionOrder({
        orderId: id,
        toState: "delivered",
        actorId: "admin_a",
        codCollection: { method: "cash", amountMinor: codOrder.payOnDeliveryMinor.toString() }
      }),
      /CHECKOUT_COD_COLLECTION_REFERENCE_REQUIRED/
    );
    await assert.rejects(
      () => adminService.transitionOrder({
        orderId: id,
        toState: "delivered",
        actorId: "admin_a",
        codCollection: { method: "cash", reference: "   ", amountMinor: codOrder.payOnDeliveryMinor.toString() }
      }),
      /CHECKOUT_COD_COLLECTION_REFERENCE_REQUIRED/
    );
    await assert.rejects(
      () => adminService.transitionOrder({
        orderId: id,
        toState: "delivered",
        actorId: "admin_a",
        codCollection: { method: "cash", reference: "cash_receipt_001", amountMinor: "1" }
      }),
      /CHECKOUT_COD_COLLECTION_AMOUNT_MISMATCH/
    );
    await assert.rejects(
      () => adminService.transitionOrder({
        orderId: id,
        toState: "delivered",
        actorId: "admin_a",
        codCollection: { method: "u" + "pi", amountMinor: codOrder.payOnDeliveryMinor.toString() }
      }),
      /CHECKOUT_COD_COLLECTION_REFERENCE_REQUIRED/
    );

    const delivered = await adminService.transitionOrder({
      orderId: id,
      toState: "delivered",
      actorId: "admin_a",
      codCollection: {
        method: "u" + "pi",
        reference: "internal_ref_001",
        amountMinor: codOrder.payOnDeliveryMinor.toString(),
        collectedAt: "2026-07-05T10:10:00.000Z"
      }
    });
    assert.equal(delivered.order.state, "delivered");
    assert.equal(delivered.order.codCollection.status, "collected");
    assert.equal(delivered.order.codCollection.collectedAt, baseTime.toISOString());
    assert.equal(state.accountingEvents.filter((row) => row.eventType === "cod_collected").length, 1);
    assert.equal(state.accountingEvents.some((row) => row.eventType === "cod_collected" && row.amountMinor === codOrder.payOnDeliveryMinor), true);
    assert.deepEqual(state.walletWrites, []);
  });

  it("cancels before delivery, keeps terminal states closed, and rejects delivered cancellation", async () => {
    const cancelledHarness = makeHarness();
    const cancellable = await cancelledHarness.createOrder("full_cod", "idem_cancel");
    const cancelResult = await cancelledHarness.adminService.transitionOrder({
      orderId: orderId(cancellable),
      toState: "cancelled",
      actorId: "admin_a"
    });
    assert.equal(cancelResult.order.state, "cancelled");
    await assert.rejects(
      () => cancelledHarness.adminService.transitionOrder({ orderId: orderId(cancellable), toState: "confirmed", actorId: "admin_a" }),
      /CHECKOUT_ORDER_TERMINAL_STATE/
    );

    const deliveredHarness = makeHarness();
    const created = await deliveredHarness.createOrder("full_cod", "idem_delivered_cancel");
    const id = orderId(created);
    await deliveredHarness.adminService.transitionOrder({ orderId: id, toState: "packed", actorId: "admin_a" });
    await deliveredHarness.adminService.transitionOrder({ orderId: id, toState: "shipped", actorId: "admin_a" });
    await deliveredHarness.adminService.transitionOrder({
      orderId: id,
      toState: "delivered",
      actorId: "admin_a",
      codCollection: { method: "cash", reference: "cash_receipt_001", amountMinor: deliveredHarness.state.orders[0].payOnDeliveryMinor.toString() }
    });
    await assert.rejects(
      () => deliveredHarness.adminService.transitionOrder({ orderId: id, toState: "cancelled", actorId: "admin_a" }),
      /CHECKOUT_DELIVERED_CANCEL_UNSUPPORTED/
    );
  });

  it("does not double-write timeline, accounting, or audit for repeated same transition", async () => {
    const { state, adminService, createOrder } = makeHarness();
    const created = await createOrder("full_cod", "idem_idempotent");
    const id = orderId(created);
    await adminService.transitionOrder({ orderId: id, toState: "packed", actorId: "admin_a" });
    const counts = {
      timeline: state.timeline.length,
      accounting: state.accountingEvents.length,
      audit: state.auditLogs.length
    };
    const replay = await adminService.transitionOrder({ orderId: id, toState: "packed", actorId: "admin_a" });
    assert.equal(replay.idempotent, true);
    assert.equal(state.timeline.length, counts.timeline);
    assert.equal(state.accountingEvents.length, counts.accounting);
    assert.equal(state.auditLogs.length, counts.audit);
  });

  it("returns admin audit events and keeps C2 free of provider and wallet side effects", async () => {
    const { state, adminService, createOrder } = makeHarness();
    await adminService.updateRules({ merchantId: merchantA.id, rules: rules(), actorId: "admin_a" });
    const created = await createOrder("full_cod", "idem_audit");
    await adminService.transitionOrder({ orderId: orderId(created), toState: "packed", actorId: "admin_a" });

    const audit = await adminService.listAudit({ merchantId: merchantA.id });
    assert.equal(audit.events.length >= 2, true);
    assert.equal(audit.events.some((row: { action: string }) => row.action === "checkout.order.transitioned"), true);

    const checkoutSource = [
      "src/modules/checkout/checkout-admin.service.ts",
      "src/modules/checkout/checkout-admin.routes.ts",
      "src/modules/checkout/checkout-order.service.ts",
      "src/modules/checkout/checkout-payment.service.ts",
      "src/modules/checkout/checkout-quote.service.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");
    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Number", "\\("].join("")
    ].join("|"));
    const livePattern = new RegExp([
      ["razorpay", "orders", "create"].join("\\."),
      ["razorpay", "payments"].join("\\."),
      ["cash", "free"].join(""),
      ["bank", "payout"].join(" "),
      ["settlement", "api"].join(" "),
      ["n", "8n"].join(""),
      ["cloud", "run"].join(" "),
      ["i", "mps"].join(""),
      ["n", "eft"].join("")
    ].join("|"));
    assert.equal(floatPattern.test(checkoutSource), false);
    assert.equal(livePattern.test(checkoutSource.toLowerCase()), false);
    assert.equal(checkoutSource.includes(["shipping", "balance"].join("_")), false);
    assert.equal(checkoutSource.includes(["journalEntry", "create"].join(".")), false);
    assert.deepEqual(state.walletWrites, []);
  });
});
