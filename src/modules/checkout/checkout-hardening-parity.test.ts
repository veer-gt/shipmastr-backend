import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { HttpError } from "../../lib/httpError.js";
import { CheckoutAdminService } from "./checkout-admin.service.js";
import { CheckoutOrderService } from "./checkout-order.service.js";
import { CheckoutPaymentService } from "./checkout-payment.service.js";
import {
  CHECKOUT_MODES,
  DEFAULT_CHECKOUT_RULES,
  CheckoutQuoteService,
  computeCheckoutQuote,
  normalizeCheckoutItems,
  type CheckoutRules
} from "./checkout-quote.service.js";
import {
  serializeAdminCheckoutOrder,
  serializeBuyerOrder,
  serializeCheckoutQuote
} from "./checkout-serializers.js";

const baseTime = new Date("2026-07-05T10:00:00.000Z");
const merchant = { id: "merchant_c5", name: "Skymax" };

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function uniqueConflict() {
  return Object.assign(new Error("unique conflict"), { code: "P2002" });
}

function rules(overrides: Partial<CheckoutRules> = {}): CheckoutRules {
  return {
    ...clone(DEFAULT_CHECKOUT_RULES),
    ...overrides
  };
}

function blockedRules(): CheckoutRules {
  return rules({
    cod: {
      ...DEFAULT_CHECKOUT_RULES.cod,
      blockedPincodes: ["999999"]
    }
  });
}

function riskyRules(): CheckoutRules {
  return rules({
    risky: {
      pincodes: ["800001"],
      policy: "force_advance"
    }
  });
}

function feeWaiverRules(waiveAboveCartMinor: string): CheckoutRules {
  return rules({
    cod: {
      ...DEFAULT_CHECKOUT_RULES.cod,
      fee: {
        ...DEFAULT_CHECKOUT_RULES.cod.fee,
        waiveAboveCartMinor
      }
    }
  });
}

function makeHarness() {
  const state = {
    now: new Date(baseTime),
    merchants: [merchant],
    settings: [] as any[],
    rulesVersions: [] as any[],
    quotes: [] as any[],
    orders: [] as any[],
    timeline: [] as any[],
    payments: [] as any[],
    accountingEvents: [] as any[],
    auditLogs: [] as any[],
    idempotencyKeys: [] as any[],
    telemetrySessions: [] as any[],
    telemetryEvents: [] as any[],
    telemetryPaymentAttempts: [] as any[],
    telemetryFailures: [] as any[],
    transactionDepth: 0,
    walletWrites: [] as string[]
  };

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

  function withPaymentIncludes(payment: any, include: any = {}) {
    if (!payment) return null;
    const next = clone(payment);
    if (include.order) {
      next.order = withOrderIncludes(
        state.orders.find((row) => row.id === payment.orderId),
        include.order.include ?? {}
      );
    }
    return next;
  }

  const client: any = {
    $transaction: async (callback: any) => {
      state.transactionDepth += 1;
      try {
        return await callback(client);
      } finally {
        state.transactionDepth -= 1;
      }
    },
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
      },
      update: async ({ where, data }: any) => {
        const payment = state.payments.find((row) => row.id === where.id);
        if (!payment) throw new Error("PAYMENT_NOT_FOUND");
        Object.assign(payment, data, { updatedAt: state.now });
        return clone(payment);
      },
      findUnique: async ({ where, include }: any) => withPaymentIncludes(state.payments.find((row) => row.id === where.id), include)
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
        if (state.idempotencyKeys.some((row) => row.merchantId === data.merchantId
          && row.operation === data.operation
          && row.idempotencyKey === data.idempotencyKey)) {
          throw uniqueConflict();
        }
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
    checkoutTelemetrySession: {
      upsert: async ({ where, create, update }: any) => {
        const unique = where.merchantId_sessionId;
        const existing = state.telemetrySessions.find((row) =>
          row.merchantId === unique.merchantId && row.sessionId === unique.sessionId
        );
        if (existing) {
          Object.assign(existing, update, {
            updatedAt: state.now,
            insideTransaction: state.transactionDepth > 0
          });
          return clone(existing);
        }
        const row = {
          id: `telemetry_session_${state.telemetrySessions.length + 1}`,
          createdAt: state.now,
          updatedAt: state.now,
          insideTransaction: state.transactionDepth > 0,
          ...create
        };
        state.telemetrySessions.push(row);
        return clone(row);
      }
    },
    checkoutTelemetryEvent: {
      create: async ({ data }: any) => {
        if (data.idempotencyKey && state.telemetryEvents.some((row) =>
          row.telemetrySessionId === data.telemetrySessionId
          && row.eventName === data.eventName
          && row.idempotencyKey === data.idempotencyKey
        )) {
          throw uniqueConflict();
        }
        const row = {
          id: `telemetry_event_${state.telemetryEvents.length + 1}`,
          createdAt: state.now,
          insideTransaction: state.transactionDepth > 0,
          ...data
        };
        state.telemetryEvents.push(row);
        return clone(row);
      },
      findUnique: async ({ where }: any) => {
        const unique = where.telemetrySessionId_eventName_idempotencyKey;
        return clone(state.telemetryEvents.find((row) => matchesWhere(row, unique)) ?? null);
      }
    },
    checkoutTelemetryPaymentAttempt: {
      create: async ({ data }: any) => {
        const row = {
          id: `telemetry_payment_attempt_${state.telemetryPaymentAttempts.length + 1}`,
          createdAt: state.now,
          updatedAt: state.now,
          insideTransaction: state.transactionDepth > 0,
          ...data
        };
        state.telemetryPaymentAttempts.push(row);
        return clone(row);
      },
      findFirst: async ({ where, orderBy }: any) => {
        let rows = state.telemetryPaymentAttempts.filter((row) => matchesWhere(row, where));
        if (orderBy?.createdAt === "asc") rows = rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return clone(rows[0] ?? null);
      },
      update: async ({ where, data }: any) => {
        const row = state.telemetryPaymentAttempts.find((item) => item.id === where.id);
        if (!row) throw new Error("TELEMETRY_PAYMENT_ATTEMPT_NOT_FOUND");
        Object.assign(row, data, {
          updatedAt: state.now,
          insideTransaction: state.transactionDepth > 0
        });
        return clone(row);
      }
    },
    checkoutTelemetryFailure: {
      create: async ({ data }: any) => {
        const row = {
          id: `telemetry_failure_${state.telemetryFailures.length + 1}`,
          createdAt: state.now,
          insideTransaction: state.transactionDepth > 0,
          ...data
        };
        state.telemetryFailures.push(row);
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
  const paymentService = new CheckoutPaymentService(client, () => state.now);
  const adminService = new CheckoutAdminService(client, () => state.now);

  async function quote(input: Partial<{ merchantId: string; pincode: string; priceMinor: string }> = {}) {
    return quoteService.createQuote({
      merchantId: input.merchantId ?? merchant.id,
      pincode: input.pincode ?? "560001",
      items: [{ id: "sku_c5", name: "Cotton Kurta", quantity: 1, priceMinor: input.priceMinor ?? "129900" }]
    });
  }

  async function createOrder(mode: "prepaid" | "partial_cod" | "full_cod", key: string, quoteId?: string) {
    const createdQuote = quoteId ? { quoteId } : await quote();
    return orderService.createOrder({
      quoteId: createdQuote.quoteId,
      mode,
      idempotencyKey: key,
      customer: { name: "Asha Buyer", phone: "9876543210", email: "asha@example.test" }
    });
  }

  return { state, client, quoteService, orderService, paymentService, adminService, quote, createOrder };
}

function orderId(result: Awaited<ReturnType<ReturnType<typeof makeHarness>["createOrder"]>>) {
  return (result.body as any).order.id as string;
}

function paymentFrom(result: Awaited<ReturnType<ReturnType<typeof makeHarness>["createOrder"]>>) {
  return (result.body as any).payment as { id: string; amount: number; currency: string };
}

function tokenFrom(result: Awaited<ReturnType<ReturnType<typeof makeHarness>["createOrder"]>>) {
  return (result.body as any).orderToken as string;
}

describe("Checkout C5 hardening-parity smoke", () => {
  it("proves configurable COD fee waiver and stable frontend/backend quote contract", async () => {
    const belowThreshold = computeCheckoutQuote({
      pincode: "560001",
      rules: feeWaiverRules("500000"),
      items: normalizeCheckoutItems([{ id: "sku_low", quantity: 1, priceMinor: "350000" }])
    });
    assert.equal(belowThreshold.options.full_cod.codFee, 4900n);

    const aboveThreshold = computeCheckoutQuote({
      pincode: "560001",
      rules: feeWaiverRules("300000"),
      items: normalizeCheckoutItems([{ id: "sku_high", quantity: 1, priceMinor: "350000" }])
    });
    assert.equal(aboveThreshold.options.full_cod.codFee, 0n);
    assert.equal(aboveThreshold.options.full_cod.badge, "COD fee waived");

    const serialized = serializeCheckoutQuote({
      ...aboveThreshold,
      quoteId: "quote_c5",
      expiresAt: new Date("2026-07-05T10:15:00.000Z")
    });
    assert.deepEqual(Object.keys(serialized.options), ["prepaid", "partial_cod", "full_cod"]);
    for (const mode of CHECKOUT_MODES) {
      const option = serialized.options[mode] as Record<string, unknown>;
      for (const key of ["available", "reason", "payNow", "payOnDelivery", "codFee", "discount", "total", "badge"]) {
        assert.equal(key in option, true, `${mode} should include ${key}`);
      }
      assert.equal(option.key, mode);
    }
  });

  it("runs the C1/C2 partial-COD smoke through quote, idempotency, capture, lifecycle, COD collection, buyer read, and audit", async () => {
    const harness = makeHarness();
    const normal = await harness.quote({ pincode: "560001" });
    assert.equal(normal.options.prepaid.available, true);
    assert.equal(normal.options.partial_cod.available, true);
    assert.equal(normal.options.full_cod.available, true);

    await harness.adminService.updateRules({ merchantId: merchant.id, rules: blockedRules(), actorId: "admin_c5" });
    const blocked = await harness.quote({ pincode: "999999" });
    assert.equal(blocked.options.prepaid.available, true);
    assert.equal(blocked.options.partial_cod.available, false);
    assert.equal(blocked.options.full_cod.available, false);

    await harness.adminService.updateRules({ merchantId: merchant.id, rules: riskyRules(), actorId: "admin_c5" });
    const risky = await harness.quote({ pincode: "800001" });
    assert.equal(risky.options.partial_cod.available, true);
    assert.equal(risky.options.full_cod.available, false);
    assert.equal(risky.riskNotes.length, 1);

    await harness.adminService.updateRules({ merchantId: merchant.id, rules: rules(), actorId: "admin_c5" });
    const partialQuote = await harness.quote({ pincode: "560001" });
    const first = await harness.createOrder("partial_cod", "idem_c5_partial", partialQuote.quoteId);
    const replay = await harness.createOrder("partial_cod", "idem_c5_partial", partialQuote.quoteId);
    assert.equal(orderId(first), orderId(replay));
    assert.equal(harness.state.orders.length, 1);
    assert.equal(harness.state.idempotencyKeys[0].requestHash.length, 64);
    assert.equal(harness.state.idempotencyKeys[0].responseJson.customer, undefined);

    await assert.rejects(
      () => harness.orderService.createOrder({
        quoteId: partialQuote.quoteId,
        mode: "prepaid",
        idempotencyKey: "idem_c5_partial",
        customer: { name: "Changed Buyer", phone: "9876543210" }
      }),
      (error) => error instanceof HttpError && error.status === 409 && error.message === "IDEMPOTENCY_CONFLICT"
    );

    const payment = paymentFrom(first);
    const orderToken = tokenFrom(first);
    const captured = await harness.paymentService.mockComplete({
      paymentId: payment.id,
      orderToken,
      outcome: "success",
      idempotencyKey: "idem_c5_capture"
    });
    assert.equal((captured.body as any).order.state, "confirmed");

    await harness.adminService.transitionOrder({ orderId: orderId(first), toState: "packed", actorId: "admin_c5" });
    await harness.adminService.transitionOrder({ orderId: orderId(first), toState: "shipped", actorId: "admin_c5" });
    await assert.rejects(
      () => harness.adminService.transitionOrder({ orderId: orderId(first), toState: "delivered", actorId: "admin_c5" }),
      /CHECKOUT_COD_COLLECTION_REQUIRED/
    );
    const delivered = await harness.adminService.transitionOrder({
      orderId: orderId(first),
      toState: "delivered",
      actorId: "admin_c5",
      codCollection: {
        method: "cash",
        reference: "cash_receipt_001",
        amountMinor: harness.state.orders[0].payOnDeliveryMinor.toString()
      }
    });
    assert.equal(delivered.order.state, "delivered");
    assert.equal(delivered.order.codCollection.status, "collected");

    const buyerRead = await harness.orderService.getBuyerOrder(orderId(first), orderToken);
    assert.equal(buyerRead.order.codCollection.status, "collected");
    assert.equal("riskNotes" in buyerRead.order, false);

    const detail = await harness.adminService.getOrderDetail(orderId(first));
    assert.equal(Array.isArray(detail.order.riskNotes), true);
    assert.equal(detail.order.codCollection.status, "collected");

    const audit = await harness.adminService.listAudit({ merchantId: merchant.id });
    assert.equal(audit.events.some((row: { action: string }) => row.action === "checkout.order.transitioned"), true);
    assert.equal(audit.events.some((row: { action: string }) => row.action === "checkout.cod_collection.recorded"), true);
    assert.deepEqual(harness.state.walletWrites, []);
  });

  it("keeps late capture after cancellation or expiry refund-due only and never as a confirmed sale", async () => {
    const cancelled = makeHarness();
    const cancelledOrder = await cancelled.createOrder("prepaid", "idem_c5_cancelled");
    await cancelled.adminService.transitionOrder({
      orderId: orderId(cancelledOrder),
      toState: "cancelled",
      actorId: "admin_c5"
    });
    const lateCancel = await cancelled.paymentService.mockComplete({
      paymentId: paymentFrom(cancelledOrder).id,
      orderToken: tokenFrom(cancelledOrder),
      outcome: "success",
      idempotencyKey: "idem_c5_late_cancel"
    });
    assert.equal((lateCancel.body as any).order.state, "refund_due");
    assert.equal((lateCancel.body as any).payment.state, "refund_due");
    assert.equal(cancelled.state.accountingEvents.some((event) => event.eventType === "payment_refund_due"), true);
    assert.equal(cancelled.state.timeline.some((row) => row.type === "payment" && /confirmed/i.test(row.message)), false);
    assert.equal(cancelled.state.auditLogs.some((row) => row.action === "checkout.order.transitioned" && row.safeMeta?.toState === "confirmed"), false);

    const expired = makeHarness();
    const expiredOrder = await expired.createOrder("partial_cod", "idem_c5_expired");
    expired.state.orders[0].state = "expired";
    const lateExpired = await expired.paymentService.mockComplete({
      paymentId: paymentFrom(expiredOrder).id,
      orderToken: tokenFrom(expiredOrder),
      outcome: "success",
      idempotencyKey: "idem_c5_late_expired"
    });
    assert.equal((lateExpired.body as any).order.state, "refund_due");
    assert.equal((lateExpired.body as any).payment.state, "refund_due");
    assert.equal(expired.state.accountingEvents.some((event) => event.eventType === "payment_refund_due"), true);
    assert.equal(expired.state.timeline.some((row) => row.type === "payment" && /confirmed/i.test(row.message)), false);
  });

  it("requires signed order token for buyer reads and payment actions; order id or payment id alone is never enough", async () => {
    const harness = makeHarness();
    const created = await harness.createOrder("partial_cod", "idem_c5_token");
    const payment = paymentFrom(created);

    await assert.rejects(() => harness.orderService.getBuyerOrder(orderId(created), ""), /CHECKOUT_ORDER_TOKEN_REQUIRED/);
    await assert.rejects(() => harness.orderService.getBuyerOrder(orderId(created), "wrong.token"), /CHECKOUT_ORDER_TOKEN_REQUIRED/);
    await assert.rejects(() => harness.paymentService.initiatePayment(payment.id, ""), /CHECKOUT_ORDER_TOKEN_REQUIRED/);
    await assert.rejects(() => harness.paymentService.initiatePayment(payment.id, "wrong.token"), /CHECKOUT_ORDER_TOKEN_REQUIRED/);
    await assert.rejects(
      () => harness.paymentService.mockComplete({
        paymentId: payment.id,
        orderToken: "",
        outcome: "success",
        idempotencyKey: "idem_c5_missing_token_capture"
      }),
      /CHECKOUT_ORDER_TOKEN_REQUIRED/
    );

    const read = await harness.orderService.getBuyerOrder(orderId(created), tokenFrom(created));
    assert.equal(read.order.id, orderId(created));
  });

  it("retains payment fields needed for future webhook payload cross-validation without adding a live webhook route", async () => {
    const harness = makeHarness();
    const created = await harness.createOrder("partial_cod", "idem_c5_webhook_ready");
    const payment = harness.state.payments[0];

    assert.equal(payment.id, paymentFrom(created).id);
    assert.equal(payment.amountMinor, 25980n);
    assert.equal(payment.currency, "INR");
    assert.match(payment.gatewayOrderRef, /^mock_order_/);
    assert.match(payment.gatewayIntentRef, /^mock_intent_/);
    assert.equal(payment.gatewayPaymentRef, null);

    const checkoutRouteSource = readFileSync("src/modules/checkout/checkout.routes.ts", "utf8");
    assert.doesNotMatch(checkoutRouteSource, /webhook/i);
  });

  it("keeps buyer serializers risk-note-free while admin detail exposes riskNotes as an array", async () => {
    const harness = makeHarness();
    await harness.adminService.updateRules({ merchantId: merchant.id, rules: riskyRules(), actorId: "admin_c5" });
    const quote = await harness.quote({ pincode: "800001" });
    const order = await harness.createOrder("partial_cod", "idem_c5_risk", quote.quoteId);

    const buyer = serializeBuyerOrder(harness.state.orders[0]);
    assert.equal("riskNotes" in buyer, false);

    const admin = serializeAdminCheckoutOrder({
      ...harness.state.orders[0],
      quote: harness.state.quotes[0],
      timeline: [],
      payments: [],
      accountingEvents: []
    });
    assert.equal(Array.isArray(admin.riskNotes), true);
    assert.equal(admin.riskNotes.length, 1);

    const detail = await harness.adminService.getOrderDetail(orderId(order));
    assert.equal(detail.order.riskNotes.length, 1);
  });

  it("keeps checkout C5 scoped away from live provider, settlement, custody, and wallet behavior", async () => {
    const source = [
      "src/modules/checkout/checkout-admin.service.ts",
      "src/modules/checkout/checkout-admin.routes.ts",
      "src/modules/checkout/checkout-order.service.ts",
      "src/modules/checkout/checkout-payment.service.ts",
      "src/modules/checkout/checkout-quote.service.ts",
      "src/modules/checkout/checkout.routes.ts"
    ].map((file) => readFileSync(file, "utf8")).join("\n");

    const floatPattern = new RegExp([
      ["parse", "Float"].join(""),
      ["Math", "round"].join("\\."),
      ["Number", "\\("].join("")
    ].join("|"));
    assert.equal(floatPattern.test(source), false);
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
    assert.equal(livePattern.test(source.toLowerCase()), false);
    assert.equal(source.includes(["shipping", "balance"].join("_")), false);
    assert.equal(source.includes(["journalEntry", "create"].join(".")), false);

    const harness = makeHarness();
    await harness.createOrder("partial_cod", "idem_c5_no_wallet");
    assert.deepEqual(harness.state.walletWrites, []);
  });
});
