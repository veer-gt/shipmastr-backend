import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { HttpError } from "../../lib/httpError.js";
import {
  CHECKOUT_MODES,
  DEFAULT_CHECKOUT_RULES,
  CheckoutQuoteService,
  computeCheckoutQuote,
  normalizeCheckoutItems,
  type CheckoutRules
} from "./checkout-quote.service.js";
import { CheckoutOrderService, checkoutRequestHash } from "./checkout-order.service.js";
import { CheckoutPaymentService } from "./checkout-payment.service.js";
import { assertLowercaseCheckoutModes } from "./checkout-serializers.js";

const baseTime = new Date("2026-07-05T10:00:00.000Z");
const merchant = { id: "merchant_c1", name: "Skymax", email: "owner@example.test" };

function clone<T>(value: T): T {
  return structuredClone(value as never) as T;
}

function uniqueConflict() {
  return Object.assign(new Error("unique conflict"), { code: "P2002" });
}

function matchesWhere(row: any, where: any = {}) {
  for (const [key, value] of Object.entries(where)) {
    if (row[key] !== value) return false;
  }
  return true;
}

function replaceArray<T>(target: T[], next: T[]) {
  target.splice(0, target.length, ...next);
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
    idempotencyKeys: [] as any[],
    telemetrySessions: [] as any[],
    telemetryEvents: [] as any[],
    telemetryPaymentAttempts: [] as any[],
    telemetryFailures: [] as any[],
    failTelemetryEventNames: new Set<string>(),
    transactionDepth: 0,
    walletWrites: [] as string[]
  };

  function dateOffset(ms: number) {
    return new Date(state.now.getTime() + ms);
  }

  function withOrderIncludes(order: any, include: any = {}) {
    if (!order) return null;
    const next = clone(order);
    if (include.timeline) {
      next.timeline = clone(state.timeline.filter((row) => row.orderId === order.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
    }
    if (include.payments) {
      next.payments = clone(state.payments.filter((row) => row.orderId === order.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
    }
    return next;
  }

  function withPaymentIncludes(payment: any, include: any = {}) {
    if (!payment) return null;
    const next = clone(payment);
    if (include.order) {
      const orderInclude = include.order.include ?? {};
      next.order = withOrderIncludes(state.orders.find((row) => row.id === payment.orderId), orderInclude);
    }
    return next;
  }

  const client: any = {
    $transaction: async (callback: any) => {
      const snapshot = {
        settings: clone(state.settings),
        rulesVersions: clone(state.rulesVersions),
        quotes: clone(state.quotes),
        orders: clone(state.orders),
        timeline: clone(state.timeline),
        payments: clone(state.payments),
        accountingEvents: clone(state.accountingEvents),
        idempotencyKeys: clone(state.idempotencyKeys),
        telemetrySessions: clone(state.telemetrySessions),
        telemetryEvents: clone(state.telemetryEvents),
        telemetryPaymentAttempts: clone(state.telemetryPaymentAttempts),
        telemetryFailures: clone(state.telemetryFailures),
        walletWrites: clone(state.walletWrites)
      };
      state.transactionDepth += 1;
      try {
        return await callback(client);
      } catch (error) {
        replaceArray(state.settings, snapshot.settings);
        replaceArray(state.rulesVersions, snapshot.rulesVersions);
        replaceArray(state.quotes, snapshot.quotes);
        replaceArray(state.orders, snapshot.orders);
        replaceArray(state.timeline, snapshot.timeline);
        replaceArray(state.payments, snapshot.payments);
        replaceArray(state.accountingEvents, snapshot.accountingEvents);
        replaceArray(state.idempotencyKeys, snapshot.idempotencyKeys);
        replaceArray(state.telemetrySessions, snapshot.telemetrySessions);
        replaceArray(state.telemetryEvents, snapshot.telemetryEvents);
        replaceArray(state.telemetryPaymentAttempts, snapshot.telemetryPaymentAttempts);
        replaceArray(state.telemetryFailures, snapshot.telemetryFailures);
        replaceArray(state.walletWrites, snapshot.walletWrites);
        throw error;
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
      }
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
      findUnique: async ({ where, include }: any) => withOrderIncludes(state.orders.find((row) => row.id === where.id), include)
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
        if (state.failTelemetryEventNames.has(data.eventName)) throw new Error(`telemetry failed: ${data.eventName}`);
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
        throw new Error("wallet write forbidden in checkout tests");
      }
    },
    journalEntry: {
      create: async () => {
        state.walletWrites.push(["journalEntry", "create"].join("."));
        throw new Error("journal write forbidden in checkout tests");
      }
    }
  };

  const quoteService = new CheckoutQuoteService(client, () => state.now);
  const orderService = new CheckoutOrderService(client, () => state.now);
  const paymentService = new CheckoutPaymentService(client, () => state.now);

  async function quote(overrides: Record<string, unknown> = {}) {
    return quoteService.createQuote({
      merchantId: merchant.id,
      pincode: "560001",
      items: [{ id: "sku_c1", name: "Cotton Kurta", quantity: 1, priceMinor: "129900" }],
      ...overrides
    } as any);
  }

  async function createOrder(mode: "prepaid" | "partial_cod" | "full_cod", key: string, quoteId?: string) {
    const createdQuote = quoteId ? { quoteId } : await quote();
    return orderService.createOrder({
      quoteId: createdQuote.quoteId,
      mode,
      idempotencyKey: key,
      customer: {
        name: "Asha Buyer",
        phone: "9876543210",
        email: "asha@example.test"
      }
    });
  }

  return { state, client, quoteService, orderService, paymentService, quote, createOrder, dateOffset };
}

function riskyRules(): CheckoutRules {
  return {
    ...DEFAULT_CHECKOUT_RULES,
    risky: {
      pincodes: ["560001"],
      policy: "force_advance"
    }
  };
}

function blockedRules(): CheckoutRules {
  return {
    ...DEFAULT_CHECKOUT_RULES,
    cod: {
      ...DEFAULT_CHECKOUT_RULES.cod,
      blockedPincodes: ["560001"]
    }
  };
}

describe("Checkout C1 quote engine", () => {
  it("returns all lowercase options with stable buyer-safe shape", () => {
    const quote = computeCheckoutQuote({
      pincode: "560001",
      items: normalizeCheckoutItems([{ id: "sku_1", quantity: 1, priceMinor: "129900" }])
    });

    assert.deepEqual(Object.keys(quote.options), ["prepaid", "partial_cod", "full_cod"]);
    assert.equal(assertLowercaseCheckoutModes(), true);
    for (const mode of CHECKOUT_MODES) {
      assert.equal(quote.options[mode].key, mode);
      assert.equal(quote.options[mode].currency, "INR");
      assert.equal(typeof quote.options[mode].available, "boolean");
    }
  });

  it("calculates prepaid discount, full COD fee waiver, and partial COD min/max using integer paise", () => {
    const quote = computeCheckoutQuote({
      pincode: "560001",
      items: normalizeCheckoutItems([{ id: "sku_1", quantity: 1, priceMinor: "129900" }])
    });
    assert.equal(quote.options.prepaid.discount, 6495n);
    assert.equal(quote.options.partial_cod.payNow, 25980n);
    assert.equal(quote.options.full_cod.codFee, 4900n);

    const highValue = computeCheckoutQuote({
      pincode: "560001",
      items: normalizeCheckoutItems([{ id: "sku_2", quantity: 1, priceMinor: "350000" }])
    });
    assert.equal(highValue.options.full_cod.codFee, 0n);
    assert.equal(highValue.options.full_cod.badge, "COD fee waived");
  });

  it("disables COD for blocked pincodes and force-advance risky pincodes", () => {
    const blocked = computeCheckoutQuote({
      pincode: "560001",
      rules: blockedRules(),
      items: normalizeCheckoutItems([{ id: "sku_1", quantity: 1, priceMinor: "129900" }])
    });
    assert.equal(blocked.options.prepaid.available, true);
    assert.equal(blocked.options.partial_cod.available, false);
    assert.equal(blocked.options.full_cod.available, false);

    const risky = computeCheckoutQuote({
      pincode: "560001",
      rules: riskyRules(),
      items: normalizeCheckoutItems([{ id: "sku_1", quantity: 1, priceMinor: "129900" }])
    });
    assert.equal(risky.options.partial_cod.available, true);
    assert.equal(risky.options.full_cod.available, false);
    assert.match(risky.options.full_cod.reason ?? "", /advance/);
    assert.equal(risky.riskNotes.length, 1);
  });

  it("marks COD unavailable below minimum cart", () => {
    const quote = computeCheckoutQuote({
      pincode: "560001",
      items: normalizeCheckoutItems([{ id: "sku_1", quantity: 1, priceMinor: "10000" }])
    });
    assert.equal(quote.options.full_cod.available, false);
    assert.match(quote.options.full_cod.reason ?? "", /above/);
  });
});

describe("Checkout C1 order and payment foundation", () => {
  it("persists quotes with TTL and creates a full COD confirmed order without payment intent", async () => {
    const { state, quote, createOrder } = makeHarness();
    const createdQuote = await quote();
    assert.equal(state.quotes.length, 1);
    assert.equal(createdQuote.expiresAt.toISOString(), "2026-07-05T10:15:00.000Z");

    const result = await createOrder("full_cod", "idem_full", createdQuote.quoteId);
    assert.equal(result.statusCode, 201);
    const body = result.body as any;
    assert.equal(body.order.mode, "full_cod");
    assert.equal(body.order.state, "confirmed");
    assert.equal(body.payment, null);
    assert.equal(state.payments.length, 0);
  });

  it("requires order idempotency key, replays same body, and conflicts on changed body", async () => {
    const { createOrder, orderService, quote, state } = makeHarness();
    const createdQuote = await quote();
    await assert.rejects(
      () => orderService.createOrder({
        quoteId: createdQuote.quoteId,
        mode: "prepaid",
        idempotencyKey: "",
        customer: { name: "Asha", phone: "9876543210" }
      }),
      (error) => error instanceof HttpError && error.message === "IDEMPOTENCY_KEY_REQUIRED"
    );

    const first = await createOrder("partial_cod", "idem_same", createdQuote.quoteId);
    const second = await createOrder("partial_cod", "idem_same", createdQuote.quoteId);
    assert.equal((first.body as any).order.id, (second.body as any).order.id);
    assert.equal(state.orders.length, 1);
    assert.equal(state.idempotencyKeys[0].requestHash.length, 64);
    assert.equal(state.idempotencyKeys[0].responseJson.customer, undefined);

    await assert.rejects(
      () => orderService.createOrder({
        quoteId: createdQuote.quoteId,
        mode: "prepaid",
        idempotencyKey: "idem_same",
        customer: { name: "Different", phone: "9876543210" }
      }),
      (error) => error instanceof HttpError && error.status === 409 && error.message === "IDEMPOTENCY_CONFLICT"
    );
  });

  it("rejects expired quotes and unavailable payment modes", async () => {
    const { state, quote, orderService } = makeHarness();
    const createdQuote = await quote();
    state.quotes[0].expiresAt = new Date("2026-07-05T09:59:00.000Z");
    await assert.rejects(
      () => orderService.createOrder({
        quoteId: createdQuote.quoteId,
        mode: "prepaid",
        idempotencyKey: "idem_expired",
        customer: { name: "Asha", phone: "9876543210" }
      }),
      /CHECKOUT_QUOTE_EXPIRED/
    );

    const harness = makeHarness();
    harness.state.rulesVersions.push({ id: "rules_blocked", merchantId: merchant.id, rulesJson: blockedRules() });
    harness.state.settings.push({ id: "setting_1", merchantId: merchant.id, activeRulesVersionId: "rules_blocked", quoteTtlSeconds: 900 });
    const blockedQuote = await harness.quote();
    await assert.rejects(
      () => harness.orderService.createOrder({
        quoteId: blockedQuote.quoteId,
        mode: "full_cod",
        idempotencyKey: "idem_blocked",
        customer: { name: "Asha", phone: "9876543210" }
      }),
      /CHECKOUT_MODE_UNAVAILABLE/
    );
  });

  it("creates prepaid and partial COD payment intents from server-side quote amounts only", async () => {
    const prepaid = makeHarness();
    const prepaidResult = await prepaid.createOrder("prepaid", "idem_prepaid");
    assert.equal((prepaidResult.body as any).order.state, "pending_payment");
    assert.equal((prepaidResult.body as any).payment.purpose, "full_payment");
    assert.equal((prepaidResult.body as any).payment.amount, 123405);

    const partial = makeHarness();
    const partialResult = await partial.createOrder("partial_cod", "idem_partial");
    assert.equal((partialResult.body as any).order.state, "pending_advance");
    assert.equal((partialResult.body as any).payment.purpose, "advance");
    assert.equal((partialResult.body as any).payment.amount, 25980);
    assert.equal((partialResult.body as any).order.amounts.payOnDelivery, 103920);
  });

  it("writes order_placed telemetry inside the authoritative order transaction", async () => {
    const { state, createOrder } = makeHarness();
    const result = await createOrder("full_cod", "idem_order_telemetry");
    const body = result.body as any;

    assert.equal(state.telemetrySessions.length, 1);
    assert.equal(state.telemetrySessions[0].sessionId, `checkout-order:${body.order.id}`);
    assert.equal(state.telemetrySessions[0].checkoutOrderId, body.order.id);
    assert.equal(state.telemetrySessions[0].sellerId, null);
    assert.ok(state.telemetrySessions[0].emailHash);
    assert.ok(state.telemetrySessions[0].phoneHash);
    assert.equal(state.telemetrySessions[0].insideTransaction, true);

    const event = state.telemetryEvents.find((row) => row.eventName === "order_placed");
    assert.ok(event);
    assert.equal(event.checkoutOrderId, body.order.id);
    assert.equal(event.timelineEntryId, state.timeline[0].id);
    assert.equal(event.accountingEventId, state.accountingEvents.find((row) => row.eventType === "checkout_order_created")?.id);
    assert.equal(event.idempotencyKey, `order_placed:${body.order.id}`);
    assert.equal(event.source, "ORDER_SERVICE");
    assert.equal(event.insideTransaction, true);
    assert.equal(JSON.stringify(event.payloadJson).includes("asha@example.test"), false);
    assert.equal(JSON.stringify(event.payloadJson).includes("9876543210"), false);
  });

  it("rolls back order_placed telemetry with the order transaction", async () => {
    const { state, createOrder } = makeHarness();
    state.failTelemetryEventNames.add("order_placed");

    await assert.rejects(() => createOrder("full_cod", "idem_order_telemetry_rollback"), /telemetry failed: order_placed/);

    assert.equal(state.orders.length, 0);
    assert.equal(state.timeline.length, 0);
    assert.equal(state.accountingEvents.length, 0);
    assert.equal(state.telemetrySessions.length, 0);
    assert.equal(state.telemetryEvents.length, 0);
    assert.equal(state.idempotencyKeys.length, 0);
  });

  it("protects buyer reads with signed order token", async () => {
    const { createOrder, orderService } = makeHarness();
    const result = await createOrder("partial_cod", "idem_token");
    const body = result.body as any;

    await assert.rejects(() => orderService.getBuyerOrder(body.order.id, ""), /CHECKOUT_ORDER_TOKEN_REQUIRED/);
    await assert.rejects(() => orderService.getBuyerOrder(body.order.id, "wrong.token"), /CHECKOUT_ORDER_TOKEN_REQUIRED/);
    const read = await orderService.getBuyerOrder(body.order.id, body.orderToken);
    assert.equal(read.order.id, body.order.id);
    assert.equal("riskNotes" in read.order, false);
  });

  it("captures mock advance and full payment idempotently without double posting", async () => {
    const partial = makeHarness();
    const partialOrder = await partial.createOrder("partial_cod", "idem_capture_order");
    const partialBody = partialOrder.body as any;
    await partial.paymentService.initiatePayment(partialBody.payment.id, partialBody.orderToken);
    const captured = await partial.paymentService.mockComplete({
      paymentId: partialBody.payment.id,
      orderToken: partialBody.orderToken,
      outcome: "success",
      idempotencyKey: "idem_capture"
    });
    const replay = await partial.paymentService.mockComplete({
      paymentId: partialBody.payment.id,
      orderToken: partialBody.orderToken,
      outcome: "success",
      idempotencyKey: "idem_capture"
    });
    assert.equal((captured.body as any).order.state, "confirmed");
    assert.equal((replay.body as any).order.state, "confirmed");
    assert.equal(partial.state.accountingEvents.filter((event) => event.eventType === "advance_captured").length, 1);
    assert.equal(partial.state.timeline.filter((row) => row.type === "payment").length, 1);
    assert.equal(partial.state.telemetryEvents.filter((event) => event.eventName === "payment_attempt_started").length, 1);
    assert.equal(partial.state.telemetryEvents.filter((event) => event.eventName === "payment_succeeded").length, 1);
    assert.equal(partial.state.telemetryPaymentAttempts.length, 1);
    assert.equal(partial.state.telemetryPaymentAttempts[0].status, "SUCCEEDED");
    assert.equal(partial.state.telemetryPaymentAttempts[0].checkoutPaymentId, partialBody.payment.id);

    const prepaid = makeHarness();
    const prepaidOrder = await prepaid.createOrder("prepaid", "idem_full_payment_order");
    const prepaidBody = prepaidOrder.body as any;
    const full = await prepaid.paymentService.mockComplete({
      paymentId: prepaidBody.payment.id,
      orderToken: prepaidBody.orderToken,
      outcome: "success",
      idempotencyKey: "idem_full_payment_capture"
    });
    assert.equal((full.body as any).order.state, "confirmed");
    assert.equal(prepaid.state.accountingEvents.filter((event) => event.eventType === "full_payment_captured").length, 1);
  });

  it("writes payment_attempt_started when payment initiation becomes authoritative", async () => {
    const harness = makeHarness();
    const order = await harness.createOrder("prepaid", "idem_payment_attempt_started");
    const body = order.body as any;

    await harness.paymentService.initiatePayment(body.payment.id, body.orderToken);

    const event = harness.state.telemetryEvents.find((row) => row.eventName === "payment_attempt_started");
    assert.ok(event);
    assert.equal(event.checkoutPaymentId, body.payment.id);
    assert.equal(event.checkoutOrderId, body.order.id);
    assert.equal(event.idempotencyKey, `payment_attempt_started:${body.payment.id}`);
    assert.equal(event.insideTransaction, true);
    assert.equal(harness.state.telemetryPaymentAttempts.length, 1);
    assert.equal(harness.state.telemetryPaymentAttempts[0].status, "STARTED");
    assert.equal(harness.state.telemetryPaymentAttempts[0].insideTransaction, true);
  });

  it("rolls back clean payment success telemetry with the payment transaction", async () => {
    const harness = makeHarness();
    const order = await harness.createOrder("partial_cod", "idem_payment_success_rollback_order");
    const body = order.body as any;
    await harness.paymentService.initiatePayment(body.payment.id, body.orderToken);
    harness.state.failTelemetryEventNames.add("payment_succeeded");

    await assert.rejects(
      () => harness.paymentService.mockComplete({
        paymentId: body.payment.id,
        orderToken: body.orderToken,
        outcome: "success",
        idempotencyKey: "idem_payment_success_rollback"
      }),
      /telemetry failed: payment_succeeded/
    );

    assert.equal(harness.state.payments[0].state, "initiated");
    assert.equal(harness.state.orders[0].state, "pending_advance");
    assert.equal(harness.state.telemetryEvents.some((event) => event.eventName === "payment_succeeded"), false);
    assert.equal(harness.state.accountingEvents.some((event) => event.eventType === "advance_captured"), false);
    assert.equal(harness.state.timeline.some((row) => row.type === "payment"), false);
    assert.equal(harness.state.idempotencyKeys.some((row) => row.operation.startsWith("checkout_payment_capture:")), false);
  });

  it("marks late captures after cancelled or expired orders as refund_due", async () => {
    const cancelled = makeHarness();
    const cancelOrder = await cancelled.createOrder("prepaid", "idem_cancel_order");
    const cancelBody = cancelOrder.body as any;
    cancelled.state.orders[0].state = "cancelled";
    const lateCancel = await cancelled.paymentService.mockComplete({
      paymentId: cancelBody.payment.id,
      orderToken: cancelBody.orderToken,
      outcome: "success",
      idempotencyKey: "idem_late_cancel"
    });
    assert.equal((lateCancel.body as any).order.state, "refund_due");
    assert.equal((lateCancel.body as any).payment.state, "refund_due");
    assert.equal(cancelled.state.telemetryEvents.some((event) => event.eventName === "payment_succeeded"), false);
    const refundEvent = cancelled.state.telemetryEvents.find((event) => event.eventName === "payment_failed");
    assert.ok(refundEvent);
    assert.equal(refundEvent.checkoutPaymentId, cancelBody.payment.id);
    assert.equal(refundEvent.idempotencyKey, `payment_failed:${cancelBody.payment.id}:CHECKOUT_PAYMENT_REFUND_DUE`);
    assert.equal(refundEvent.payloadJson.reason, "late_capture_refund_due");
    assert.equal(cancelled.state.telemetryFailures[0].failureStage, "PAYMENT");
    assert.equal(cancelled.state.telemetryFailures[0].failureCode, "CHECKOUT_PAYMENT_REFUND_DUE");

    const expired = makeHarness();
    const expiredOrder = await expired.createOrder("partial_cod", "idem_expired_order");
    const expiredBody = expiredOrder.body as any;
    expired.state.orders[0].state = "expired";
    const lateExpired = await expired.paymentService.mockComplete({
      paymentId: expiredBody.payment.id,
      orderToken: expiredBody.orderToken,
      outcome: "success",
      idempotencyKey: "idem_late_expired"
    });
    assert.equal((lateExpired.body as any).order.state, "refund_due");
    assert.equal(expired.state.accountingEvents.filter((event) => event.eventType === "payment_refund_due").length, 1);
    assert.equal(expired.state.telemetryEvents.some((event) => event.eventName === "payment_succeeded"), false);
  });

  it("keeps failed mock payments from confirming an order", async () => {
    const harness = makeHarness();
    const order = await harness.createOrder("prepaid", "idem_failed_order");
    const body = order.body as any;
    const failed = await harness.paymentService.mockComplete({
      paymentId: body.payment.id,
      orderToken: body.orderToken,
      outcome: "failure",
      idempotencyKey: "idem_failed_payment"
    });
    const replay = await harness.paymentService.mockComplete({
      paymentId: body.payment.id,
      orderToken: body.orderToken,
      outcome: "failure",
      idempotencyKey: "idem_failed_payment"
    });
    assert.equal((failed.body as any).payment.state, "failed");
    assert.equal((failed.body as any).order.state, "pending_payment");
    assert.equal((replay.body as any).alreadyCaptured, false);
    const failureEvent = harness.state.telemetryEvents.find((event) => event.eventName === "payment_failed");
    assert.ok(failureEvent);
    assert.equal(failureEvent.checkoutPaymentId, body.payment.id);
    assert.equal(failureEvent.checkoutOrderId, body.order.id);
    assert.equal(failureEvent.idempotencyKey, `payment_failed:${body.payment.id}:PAYMENT_CAPTURE_FAILED`);
    assert.equal(harness.state.telemetryEvents.some((event) => event.eventName === "payment_succeeded"), false);
    assert.equal(harness.state.telemetryPaymentAttempts[0].status, "FAILED");
    assert.equal(harness.state.telemetryFailures[0].failureStage, "PAYMENT");
    assert.equal(harness.state.telemetryFailures[0].failureCode, "PAYMENT_CAPTURE_FAILED");
    assert.equal(harness.state.payments[0].state, "failed");
  });

  it("uses dedicated CheckoutIdempotencyKey request hashes", () => {
    const hashA = checkoutRequestHash({ route: "orders", body: { quoteId: "quote_1", mode: "prepaid" } });
    const hashB = checkoutRequestHash({ body: { mode: "prepaid", quoteId: "quote_1" }, route: "orders" });
    assert.equal(hashA, hashB);
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.match(schema, /model CheckoutIdempotencyKey/);
    assert.match(schema, /requestHash\s+String\s+@map\("request_hash"\)/);
    assert.match(schema, /@@unique\(\[merchantId, operation, idempotencyKey\]\)/);
  });

  it("mounts public checkout routes and avoids wallet/provider side effects", async () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    assert.match(routes, /apiRouter\.use\("\/checkout", checkoutRouter\);/);

    const files = [
      "src/modules/checkout/checkout-order.service.ts",
      "src/modules/checkout/checkout-payment.service.ts",
      "src/modules/checkout/checkout-quote.service.ts",
      "src/modules/checkout/checkout.routes.ts"
    ].map((file) => readFileSync(file, "utf8").toLowerCase()).join("\n");
    assert.equal(files.includes("sellerwalletledger"), false);
    assert.equal(files.includes(["journalentry", "create"].join(".")), false);
    assert.equal(files.includes(["cash", "free"].join("")), false);
    assert.equal(files.includes(["shipping", "balance"].join("_")), false);

    const harness = makeHarness();
    await harness.createOrder("partial_cod", "idem_no_wallet");
    assert.deepEqual(harness.state.walletWrites, []);
  });
});
